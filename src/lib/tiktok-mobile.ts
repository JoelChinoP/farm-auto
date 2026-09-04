import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { AdbClient, AdbDeviceInspection } from "./adb.ts";
import type { AppiumClient, AppiumElement } from "./appium-client.ts";
import {
  assertRuntimeOwnership,
  CleanupUnknownError,
  runOwnedDeviceAutomation,
} from "./device-runtime.ts";
import { getOperation, stableJson } from "./operations.ts";
import {
  readTikTokConfig,
  reduceTikTokCampaignExecution,
  normalizeTikTokUrl,
  TIKTOK_APP_PACKAGE,
  TikTokError,
  type TikTokConfig,
  type TikTokExecutionPayload,
  type TikTokLiveExecutionPayload,
  type TikTokPostExecutionPayload,
} from "./tiktok.ts";

type TikTokPostAction = "like" | "comment";

export type TikTokPostMobileDriver = {
  openPost(sessionId: string, deviceId: string, url: string, signal?: AbortSignal): Promise<void>;
  verifyAccountAndPost(
    sessionId: string,
    account: string,
    accountResourceId: string,
    postContainerResourceId: string,
    postUrlResourceId: string,
    postUrl: string,
    targetText: string,
    signal?: AbortSignal,
  ): Promise<void>;
  readLikeState(sessionId: string, signal?: AbortSignal): Promise<boolean>;
  prepareLike(sessionId: string, signal?: AbortSignal): Promise<string>;
  tapLike(sessionId: string, elementId: string, signal?: AbortSignal): Promise<void>;
  openCommentComposer(sessionId: string, signal?: AbortSignal): Promise<void>;
  assertCommentAbsent(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
  enterComment(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
  readCommentDraft(sessionId: string, signal?: AbortSignal): Promise<string>;
  prepareCommentSubmit(sessionId: string, signal?: AbortSignal): Promise<string>;
  submitComment(sessionId: string, elementId: string, signal?: AbortSignal): Promise<void>;
  confirmCommentVisible(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
};

export type TikTokLiveMobileDriver = {
  openLive(sessionId: string, deviceId: string, url: string, signal?: AbortSignal): Promise<void>;
  verifyAccountAndLive(
    sessionId: string,
    account: string,
    accountResourceId: string,
    liveContainerResourceId: string,
    liveUrlResourceId: string,
    liveUrl: string,
    targetText: string,
    signal?: AbortSignal,
  ): Promise<void>;
  doubleTapRound(sessionId: string, x: number, y: number, signal?: AbortSignal): Promise<void>;
};

function decodeXml(value: string) {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function visibleText(value: string) {
  return decodeXml(value).normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalized(value: string) {
  return visibleText(value).toLocaleLowerCase("es");
}

function xpathLiteral(value: string) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(`, "'", `)})`;
}

export class AppiumTikTokMobileDriver implements TikTokPostMobileDriver, TikTokLiveMobileDriver {
  readonly #adb: AdbClient;
  readonly #appium: AppiumClient;
  readonly #config: TikTokConfig;
  readonly #targets = new Map<string, {
    mode: "post" | "live";
    text: string;
    containerResourceId: string;
    urlResourceId: string;
    url: string;
  }>();
  readonly #commentSurfaces = new Map<string, string>();

  constructor(adb: AdbClient, appium: AppiumClient, config = readTikTokConfig()) {
    this.#adb = adb;
    this.#appium = appium;
    this.#config = config;
  }

  async #waitFor<T>(read: () => Promise<T | null>, message: string, signal?: AbortSignal) {
    const startedAt = Date.now();
    while (true) {
      signal?.throwIfAborted();
      const value = await read();
      if (value !== null) return value;
      if (Date.now() - startedAt >= this.#config.uiTimeoutMs) {
        throw new TikTokError("TIKTOK_UI_NOT_VERIFIED", message, 422);
      }
      await delay(250, undefined, { signal });
    }
  }

  async #open(sessionId: string, deviceId: string, url: string, signal?: AbortSignal) {
    await this.#appium.activateApp(sessionId, TIKTOK_APP_PACKAGE, { signal });
    await this.#appium.executeScript(sessionId, "mobile: deepLink", [{ url, package: TIKTOK_APP_PACKAGE }], { signal });
    await this.#waitFor(async () => {
      const foreground = await this.#adb.getForeground(deviceId, { signal });
      return foreground?.packageName === TIKTOK_APP_PACKAGE ? true : null;
    }, "No se pudo confirmar TikTok en primer plano.", signal);
  }

  async #verifyAccount(sessionId: string, account: string, accountResourceId: string, signal?: AbortSignal) {
    await this.#waitFor(async () => {
      const accounts = await this.#appium.findElements(sessionId, "id", accountResourceId, { signal });
      if (accounts.length > 1) throw new TikTokError("TIKTOK_ACCOUNT_AMBIGUOUS", "El indicador de cuenta TikTok es ambiguo.", 422);
      if (!accounts[0]) return null;
      const [text, description] = await Promise.all([
        this.#appium.getElementText(sessionId, accounts[0].elementId, { signal }),
        this.#appium.getElementAttribute(sessionId, accounts[0].elementId, "content-desc", { signal }),
      ]);
      if (![text, description].some((value) => value !== null && normalized(value) === normalized(account))) {
        throw new TikTokError("TIKTOK_ACCOUNT_MISMATCH", "La cuenta TikTok visible no coincide con la cuenta controlada.", 422);
      }
      return true;
    }, "No se pudo verificar la cuenta TikTok controlada.", signal);
  }

  #target(sessionId: string, mode?: "post" | "live") {
    const target = this.#targets.get(sessionId);
    if (!target || mode && target.mode !== mode) throw new TikTokError("TIKTOK_TARGET_NOT_VERIFIED", "El objetivo TikTok no fue verificado.", 422);
    return target;
  }

  async #targetContainer(sessionId: string, mode: "post" | "live", signal?: AbortSignal) {
    const target = this.#target(sessionId, mode);
    const literal = xpathLiteral(visibleText(target.text));
    const locator = `.//*[contains(normalize-space(@text), ${literal}) or contains(normalize-space(@content-desc), ${literal})]`;
    return this.#waitFor(async () => {
      const containers = await this.#appium.findElements(sessionId, "id", target.containerResourceId, { signal });
      const matches: AppiumElement[] = [];
      let textMatches = 0;
      for (const container of containers) {
        const text = await this.#appium.findElementsFromElement(sessionId, container.elementId, "xpath", locator, { signal });
        if (text.length > 1) throw new TikTokError("TIKTOK_TARGET_AMBIGUOUS", "La referencia visible aparece mas de una vez.", 422);
        if (text.length !== 1) continue;
        textMatches += 1;
        const urls = await this.#appium.findElementsFromElement(sessionId, container.elementId, "id", target.urlResourceId, { signal });
        if (urls.length > 1) throw new TikTokError("TIKTOK_TARGET_AMBIGUOUS", "La URL visible de TikTok es ambigua.", 422);
        if (!urls[0]) continue;
        const [textUrl, description] = await Promise.all([
          this.#appium.getElementText(sessionId, urls[0].elementId, { signal }),
          this.#appium.getElementAttribute(sessionId, urls[0].elementId, "content-desc", { signal }),
        ]);
        const sameUrl = [textUrl, description].some((value) => {
          if (value === null) return false;
          try {
            return normalizeTikTokUrl(value).normalizedUrl === normalizeTikTokUrl(target.url).normalizedUrl;
          } catch {
            return false;
          }
        });
        if (sameUrl) matches.push(container);
      }
      if (matches.length > 1) throw new TikTokError("TIKTOK_TARGET_AMBIGUOUS", "Mas de un objetivo TikTok coincide.", 422);
      if (textMatches && !matches.length) throw new TikTokError("TIKTOK_URL_MISMATCH", "El objetivo visible no expone la URL TikTok autorizada.", 422);
      return matches[0] ?? null;
    }, `No se pudo verificar el ${mode === "live" ? "Live" : "post"} TikTok exacto.`, signal);
  }

  async #elementsForLabels(sessionId: string, labels: string[], parentElementId: string, signal?: AbortSignal) {
    const result = new Map<string, AppiumElement>();
    for (const label of labels) {
      const elements = await this.#appium.findElementsFromElement(sessionId, parentElementId, "accessibility id", label, { signal });
      for (const element of elements) result.set(element.elementId, element);
    }
    return [...result.values()];
  }

  async #uniqueLabel(sessionId: string, labels: string[], parentElementId: string, description: string, signal?: AbortSignal) {
    return this.#waitFor(async () => {
      const elements = await this.#elementsForLabels(sessionId, labels, parentElementId, signal);
      if (elements.length > 1) throw new TikTokError("TIKTOK_UI_AMBIGUOUS", `${description} es ambiguo.`, 422);
      return elements[0] ?? null;
    }, `No se pudo verificar ${description}.`, signal);
  }

  async #commentComposer(sessionId: string, signal?: AbortSignal) {
    return this.#waitFor(async () => {
      const elements = await this.#appium.findElements(sessionId, "id", this.#config.commentComposerResourceId, { signal });
      if (elements.length > 1) throw new TikTokError("TIKTOK_UI_AMBIGUOUS", "Hay mas de un compositor TikTok.", 422);
      return elements[0] ?? null;
    }, "No se pudo verificar el compositor TikTok.", signal);
  }

  async #commentEditor(sessionId: string, signal?: AbortSignal) {
    const composer = await this.#commentComposer(sessionId, signal);
    const editors = await this.#appium.findElementsFromElement(sessionId, composer.elementId, "id", this.#config.commentEditorResourceId, { signal });
    if (editors.length !== 1) throw new TikTokError("TIKTOK_UI_AMBIGUOUS", "No existe un unico editor de comentario TikTok.", 422);
    return editors[0];
  }

  async #exactText(sessionId: string, parentElementId: string, text: string, signal?: AbortSignal) {
    const literal = xpathLiteral(visibleText(text));
    return this.#appium.findElementsFromElement(
      sessionId,
      parentElementId,
      "xpath",
      `.//*[normalize-space(@text) = ${literal} or normalize-space(@content-desc) = ${literal}]`,
      { signal },
    );
  }

  async openPost(sessionId: string, deviceId: string, url: string, signal?: AbortSignal) {
    await this.#open(sessionId, deviceId, url, signal);
  }

  async verifyAccountAndPost(
    sessionId: string,
    account: string,
    accountResourceId: string,
    postContainerResourceId: string,
    postUrlResourceId: string,
    postUrl: string,
    targetText: string,
    signal?: AbortSignal,
  ) {
    await this.#verifyAccount(sessionId, account, accountResourceId, signal);
    this.#targets.set(sessionId, { mode: "post", text: targetText, containerResourceId: postContainerResourceId, urlResourceId: postUrlResourceId, url: postUrl });
    await this.#targetContainer(sessionId, "post", signal);
  }

  async readLikeState(sessionId: string, signal?: AbortSignal) {
    const container = await this.#targetContainer(sessionId, "post", signal);
    const active = await this.#elementsForLabels(sessionId, this.#config.likeActiveLabels, container.elementId, signal);
    const inactive = await this.#elementsForLabels(sessionId, this.#config.likeInactiveLabels, container.elementId, signal);
    if (active.length === 1 && inactive.length === 0) return true;
    if (active.length === 0 && inactive.length === 1) {
      const [selected, checked] = await Promise.all([
        this.#appium.getElementAttribute(sessionId, inactive[0].elementId, "selected", { signal }),
        this.#appium.getElementAttribute(sessionId, inactive[0].elementId, "checked", { signal }),
      ]);
      return selected === "true" || checked === "true";
    }
    throw new TikTokError("TIKTOK_LIKE_STATE_AMBIGUOUS", "No se pudo determinar el estado exacto del Like TikTok.", 422);
  }

  async prepareLike(sessionId: string, signal?: AbortSignal) {
    const container = await this.#targetContainer(sessionId, "post", signal);
    return (await this.#uniqueLabel(sessionId, this.#config.likeInactiveLabels, container.elementId, "el Like TikTok objetivo", signal)).elementId;
  }

  async tapLike(sessionId: string, elementId: string, signal?: AbortSignal) {
    await this.#appium.clickElement(sessionId, elementId, { signal });
  }

  async openCommentComposer(sessionId: string, signal?: AbortSignal) {
    const container = await this.#targetContainer(sessionId, "post", signal);
    const trigger = await this.#uniqueLabel(sessionId, this.#config.commentLabels, container.elementId, "el disparador de comentarios TikTok", signal);
    if ((await this.#appium.findElements(sessionId, "id", this.#config.commentComposerResourceId, { signal })).length) {
      throw new TikTokError("TIKTOK_UI_AMBIGUOUS", "Ya habia un compositor abierto antes de seleccionar el post TikTok.", 422);
    }
    await this.#appium.clickElement(sessionId, trigger.elementId, { signal });
    await this.#commentEditor(sessionId, signal);
    const surfaces = await this.#appium.findElements(sessionId, "id", this.#config.commentResultContainerResourceId, { signal });
    if (surfaces.length !== 1) throw new TikTokError("TIKTOK_UI_AMBIGUOUS", "No existe una unica superficie de comentarios TikTok.", 422);
    this.#commentSurfaces.set(sessionId, surfaces[0].elementId);
  }

  async assertCommentAbsent(sessionId: string, text: string, signal?: AbortSignal) {
    const surface = this.#commentSurfaces.get(sessionId);
    if (!surface) throw new TikTokError("TIKTOK_TARGET_NOT_VERIFIED", "La superficie de comentarios TikTok no fue verificada.", 422);
    if ((await this.#exactText(sessionId, surface, text, signal)).length) {
      throw new TikTokError("TIKTOK_COMMENT_ALREADY_VISIBLE", "El comentario exacto ya es visible; requiere verificacion manual.", 409);
    }
  }

  async enterComment(sessionId: string, text: string, signal?: AbortSignal) {
    const editor = await this.#commentEditor(sessionId, signal);
    await this.#appium.clearElement(sessionId, editor.elementId, { signal });
    await this.#appium.setElementValue(sessionId, editor.elementId, text, { signal });
  }

  async readCommentDraft(sessionId: string, signal?: AbortSignal) {
    return this.#appium.getElementText(sessionId, (await this.#commentEditor(sessionId, signal)).elementId, { signal });
  }

  async prepareCommentSubmit(sessionId: string, signal?: AbortSignal) {
    const composer = await this.#commentComposer(sessionId, signal);
    const elements = await this.#appium.findElementsFromElement(sessionId, composer.elementId, "id", this.#config.commentSubmitResourceId, { signal });
    if (elements.length !== 1) throw new TikTokError("TIKTOK_UI_AMBIGUOUS", "No existe un unico boton de envio TikTok.", 422);
    return elements[0].elementId;
  }

  async submitComment(sessionId: string, elementId: string, signal?: AbortSignal) {
    await this.#appium.clickElement(sessionId, elementId, { signal });
  }

  async confirmCommentVisible(sessionId: string, text: string, signal?: AbortSignal) {
    const surface = this.#commentSurfaces.get(sessionId);
    if (!surface) throw new TikTokError("TIKTOK_TARGET_NOT_VERIFIED", "La superficie de comentarios TikTok no fue verificada.", 422);
    await this.#waitFor(async () => {
      const exact = await this.#exactText(sessionId, surface, text, signal);
      const composers = await this.#appium.findElements(sessionId, "id", this.#config.commentComposerResourceId, { signal });
      return exact.length === 1 && composers.length === 0 ? true : null;
    }, "No se pudo confirmar la visibilidad exacta del comentario TikTok.", signal);
  }

  async openLive(sessionId: string, deviceId: string, url: string, signal?: AbortSignal) {
    await this.#open(sessionId, deviceId, url, signal);
  }

  async verifyAccountAndLive(
    sessionId: string,
    account: string,
    accountResourceId: string,
    liveContainerResourceId: string,
    liveUrlResourceId: string,
    liveUrl: string,
    targetText: string,
    signal?: AbortSignal,
  ) {
    await this.#verifyAccount(sessionId, account, accountResourceId, signal);
    this.#targets.set(sessionId, { mode: "live", text: targetText, containerResourceId: liveContainerResourceId, urlResourceId: liveUrlResourceId, url: liveUrl });
    await this.#targetContainer(sessionId, "live", signal);
  }

  async doubleTapRound(sessionId: string, x: number, y: number, signal?: AbortSignal) {
    this.#target(sessionId, "live");
    await this.#appium.executeScript(sessionId, "mobile: doubleClickGesture", [{ x, y }], { signal });
  }
}

export type TikTokExecutionDependencies = {
  adb: AdbClient;
  appium: AppiumClient;
  postMobile?: TikTokPostMobileDriver;
  liveMobile?: TikTokLiveMobileDriver;
  config?: TikTokConfig;
  artifactsPath?: string;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
  leaseSignal?: AbortSignal;
};

function executionPayload(database: Database.Database, operationId: string) {
  const operation = getOperation(database, operationId);
  if (!operation?.campaignId || !operation.postId || !operation.assignmentId || !operation.deviceId
    || operation.kind !== "assignment.execute" || operation.status !== "running") {
    throw new Error("La operacion de ejecucion TikTok no es valida.");
  }
  const platform = database.prepare("SELECT platform FROM campaigns WHERE id = ?").get(operation.campaignId) as { platform: string } | undefined;
  if (platform?.platform !== "tiktok") throw new Error("La operacion no pertenece a TikTok.");
  const payload = operation.request as TikTokExecutionPayload;
  if (payload.mode !== "post" && payload.mode !== "live") throw new Error("El modo de ejecucion TikTok no es valido.");
  return payload;
}

function assertNotCancelled(database: Database.Database, operationId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const job = database.prepare("SELECT cancellation_requested_at FROM jobs WHERE operation_id = ?")
    .get(operationId) as { cancellation_requested_at: number | null } | undefined;
  if (!job || job.cancellation_requested_at !== null) throw new DOMException("Cancelacion solicitada", "AbortError");
}

function assertExecutionContent(database: Database.Database, payload: TikTokExecutionPayload, config: TikTokConfig) {
  if (payload.expectedAccount !== config.controlledAccount || !config.controlledAccount
    || payload.expectedAccountResourceId !== config.accountResourceId || !config.accountResourceId) {
    throw new TikTokError("CONTROLLED_ACCOUNT_CHANGED", "La cuenta o selector TikTok cambio antes de ejecutar.", 409);
  }
  if (payload.mode === "post") {
    if (!config.publicEffectsEnabled || payload.authorization.environmentGate !== "TIKTOK_PUBLIC_EFFECTS_ENABLED") {
      throw new TikTokError("TIKTOK_EFFECTS_DISABLED", "TikTok post fue deshabilitado antes de ejecutar.", 503);
    }
    if (payload.expectedPostContainerResourceId !== config.postContainerResourceId
      || payload.expectedPostUrlResourceId !== config.postUrlResourceId
      || stableJson(payload.expectedLikeActiveLabels) !== stableJson(config.likeActiveLabels)
      || stableJson(payload.expectedLikeInactiveLabels) !== stableJson(config.likeInactiveLabels)
      || stableJson(payload.expectedCommentLabels) !== stableJson(config.commentLabels)) {
      throw new TikTokError("TIKTOK_POST_STRUCTURE_CHANGED", "Los selectores TikTok cambiaron antes de ejecutar.", 409);
    }
    if (payload.actions.comment && (
      payload.expectedCommentComposerResourceId !== config.commentComposerResourceId
      || payload.expectedCommentEditorResourceId !== config.commentEditorResourceId
      || payload.expectedCommentSubmitResourceId !== config.commentSubmitResourceId
      || payload.expectedCommentResultContainerResourceId !== config.commentResultContainerResourceId
    )) throw new TikTokError("TIKTOK_COMMENT_STRUCTURE_CHANGED", "Los selectores de comentario TikTok cambiaron.", 409);
  } else if (!config.liveEffectsEnabled || payload.authorization.environmentGate !== "TIKTOK_LIVE_EFFECTS_ENABLED") {
    throw new TikTokError("TIKTOK_LIVE_EFFECTS_DISABLED", "TikTok Live fue deshabilitado antes de ejecutar.", 503);
  } else if (payload.expectedLiveContainerResourceId !== config.liveContainerResourceId
    || payload.expectedLiveUrlResourceId !== config.liveUrlResourceId
    || !config.liveCalibration
    || stableJson(payload.authorization.calibration) !== stableJson(config.liveCalibration)
    || payload.deviceId !== config.liveCalibration.deviceId
    || payload.x !== config.liveCalibration.x
    || payload.y !== config.liveCalibration.y) {
    throw new TikTokError("TIKTOK_LIVE_STRUCTURE_CHANGED", "Los selectores TikTok Live cambiaron antes de ejecutar.", 409);
  }
  const row = database.prepare(`
    SELECT c.revision, c.like_enabled, c.comment_enabled, p.context_hash, p.source_url,
      p.final_url, a.status AS assignment_status
    FROM assignments a JOIN campaigns c ON c.id = a.campaign_id
    JOIN posts p ON p.id = a.post_id
    WHERE a.id = ? AND a.campaign_id = ? AND a.post_id = ? AND a.device_id = ? AND c.platform = 'tiktok'
  `).get(payload.assignmentId, payload.campaignId, payload.postId, payload.deviceId) as {
    revision: number;
    like_enabled: 0 | 1;
    comment_enabled: 0 | 1;
    context_hash: string | null;
    source_url: string;
    final_url: string | null;
    assignment_status: string;
  } | undefined;
  const url = payload.mode === "post" ? payload.postUrl : payload.liveUrl;
  if (!row || !["approved", "scheduled"].includes(row.assignment_status)
    || (row.final_url ?? row.source_url) !== url) {
    throw new TikTokError("EXECUTION_CONTENT_CHANGED", "El objetivo TikTok cambio antes de ejecutar.", 409);
  }
  if (payload.mode === "post") {
    if (Boolean(row.like_enabled) !== payload.actions.like || Boolean(row.comment_enabled) !== payload.actions.comment
      || row.context_hash !== payload.contextHash) {
      throw new TikTokError("EXECUTION_CONTENT_CHANGED", "La campana TikTok cambio antes de ejecutar.", 409);
    }
    if (payload.actions.comment) {
      const comment = database.prepare(`
        SELECT id, version, text, status, stale FROM comments WHERE assignment_id = ?
          AND version = (SELECT MAX(version) FROM comments WHERE assignment_id = ?)
      `).get(payload.assignmentId, payload.assignmentId) as { id: string; version: number; text: string; status: string; stale: 0 | 1 } | undefined;
      if (!payload.comment || !comment || comment.id !== payload.comment.id || comment.version !== payload.comment.version
        || comment.text !== payload.comment.text || !["ready", "edited"].includes(comment.status) || comment.stale) {
        throw new TikTokError("EXECUTION_COMMENT_CHANGED", "El comentario TikTok cambio antes de ejecutar.", 409);
      }
    }
  }
}

function beginExecution(database: Database.Database, payload: TikTokExecutionPayload) {
  const now = Date.now();
  database.transaction(() => {
    database.prepare("UPDATE assignments SET status = 'running', actual_at = COALESCE(actual_at, ?), updated_at = ? WHERE id = ?")
      .run(now, now, payload.assignmentId);
    reduceTikTokCampaignExecution(database, payload.campaignId, now);
  })();
}

function actionStatus(database: Database.Database, operationId: string, action: TikTokPostAction) {
  return database.prepare("SELECT status FROM assignment_action_results WHERE operation_id = ? AND action = ?")
    .get(operationId, action) as { status: string } | undefined;
}

function saveActionCheckpoint(database: Database.Database, operationId: string, payload: TikTokPostExecutionPayload, action: TikTokPostAction) {
  return database.transaction(() => {
    const phase = action === "like" ? "before_tiktok_like" : "before_tiktok_comment";
    const previous = database.prepare("SELECT id FROM checkpoints WHERE operation_id = ? AND phase = ? AND sequence = 1")
      .get(operationId, phase) as { id: string } | undefined;
    const id = previous?.id ?? randomUUID();
    if (!previous) database.prepare(`
      INSERT INTO checkpoints (id, operation_id, assignment_id, phase, sequence, data_json, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, operationId, payload.assignmentId, phase, stableJson({
      action,
      account: payload.expectedAccount,
      postUrl: payload.postUrl,
      targetText: payload.expectedTargetText,
      commentId: action === "comment" ? payload.comment?.id ?? null : null,
      commentVersion: action === "comment" ? payload.comment?.version ?? null : null,
    }), Date.now());
    database.prepare("UPDATE assignment_action_results SET checkpoint_id = ?, updated_at = ? WHERE operation_id = ? AND action = ?")
      .run(id, Date.now(), operationId, action);
    return id;
  }).immediate();
}

function armPostAction(database: Database.Database, operationId: string, owner: string, action: TikTokPostAction) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const job = database.prepare(`
      SELECT id, effect_phase, cancellation_requested_at FROM jobs
      WHERE operation_id = ? AND status = 'running' AND lock_owner = ?
    `).get(operationId, owner) as { id: string; effect_phase: string; cancellation_requested_at: number | null } | undefined;
    if (!job || job.effect_phase !== "before_effect") throw new Error("La frontera de efecto TikTok no esta lista.");
    if (job.cancellation_requested_at !== null) throw new DOMException("Cancelacion solicitada", "AbortError");
    const updated = database.prepare(`
      UPDATE assignment_action_results SET status = 'effect_possible', updated_at = ?
      WHERE operation_id = ? AND action = ? AND status = 'pending' AND checkpoint_id IS NOT NULL
    `).run(Date.now(), operationId, action);
    if (updated.changes !== 1) throw new Error("La accion TikTok no esta lista para ejecutarse.");
    const now = Date.now();
    database.prepare("UPDATE jobs SET effect_phase = 'effect_possible', updated_at = ? WHERE id = ?").run(now, job.id);
    database.prepare("UPDATE operations SET effect_phase = 'effect_possible', updated_at = ? WHERE id = ?").run(now, operationId);
  }).immediate();
}

function confirmPostAction(
  database: Database.Database,
  operationId: string,
  owner: string,
  action: TikTokPostAction,
  result: "already_active" | "activated" | "sent",
) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const current = actionStatus(database, operationId, action);
    if (!current) throw new Error("La accion TikTok no existe.");
    if (current.status === "confirmed") return;
    if (!["pending", "effect_possible"].includes(current.status)) throw new Error("La accion TikTok no puede confirmarse.");
    const now = Date.now();
    database.prepare(`
      UPDATE assignment_action_results SET status = 'confirmed', result = ?, error = NULL,
        updated_at = ?, completed_at = ? WHERE operation_id = ? AND action = ?
    `).run(result, now, now, operationId, action);
    const remaining = (database.prepare("SELECT COUNT(*) AS total FROM assignment_action_results WHERE operation_id = ? AND status != 'confirmed'")
      .get(operationId) as { total: number }).total;
    const phase = remaining ? "before_effect" : "effect_confirmed";
    database.prepare("UPDATE jobs SET effect_phase = ?, updated_at = ? WHERE operation_id = ?").run(phase, now, operationId);
    database.prepare("UPDATE operations SET effect_phase = ?, updated_at = ? WHERE id = ?").run(phase, now, operationId);
  }).immediate();
}

function completeAssignment(database: Database.Database, operationId: string, payload: TikTokExecutionPayload, extra: Record<string, unknown> = {}) {
  return database.transaction(() => {
    if (payload.mode === "post") {
      const incomplete = (database.prepare("SELECT COUNT(*) AS total FROM assignment_action_results WHERE operation_id = ? AND status != 'confirmed'")
        .get(operationId) as { total: number }).total;
      if (incomplete) throw new Error("No todas las acciones TikTok fueron confirmadas.");
    }
    const now = Date.now();
    const result = { assignmentId: payload.assignmentId, domainCommitted: true, ...extra };
    database.prepare("UPDATE assignments SET status = 'sent', updated_at = ?, completed_at = ? WHERE id = ?").run(now, now, payload.assignmentId);
    database.prepare("UPDATE operations SET result_json = ?, updated_at = ? WHERE id = ?").run(stableJson(result), now, operationId);
    database.prepare("UPDATE jobs SET result_json = ?, updated_at = ? WHERE operation_id = ?").run(stableJson(result), now, operationId);
    return reduceTikTokCampaignExecution(database, payload.campaignId, now);
  }).immediate();
}

function markPostFailure(
  database: Database.Database,
  operationId: string,
  owner: string,
  payload: TikTokPostExecutionPayload,
  error: unknown,
  signal?: AbortSignal,
) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const job = database.prepare("SELECT status, lock_owner, cancellation_requested_at FROM jobs WHERE operation_id = ?")
      .get(operationId) as { status: string; lock_owner: string | null; cancellation_requested_at: number | null } | undefined;
    if (!job || job.status !== "running" || job.lock_owner !== owner) return;
    const possible = database.prepare(`
      SELECT action FROM assignment_action_results WHERE operation_id = ? AND status = 'effect_possible' LIMIT 1
    `).get(operationId) as { action: TikTokPostAction } | undefined;
    const actions = database.prepare("SELECT status FROM assignment_action_results WHERE operation_id = ?")
      .all(operationId) as Array<{ status: string }>;
    const confirmed = actions.filter((action) => action.status === "confirmed").length;
    const cancelled = signal?.aborted || job.cancellation_requested_at !== null;
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (possible) {
      database.prepare(`
        UPDATE assignment_action_results SET status = 'outcome_unknown', error = ?, updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND action = ? AND status = 'effect_possible'
      `).run(message, now, now, operationId, possible.action);
      database.prepare(`
        UPDATE assignment_action_results SET status = 'cancelled', error = 'No ejecutada porque otra accion quedo incierta.',
          updated_at = ?, completed_at = ? WHERE operation_id = ? AND status = 'pending'
      `).run(now, now, operationId);
      database.prepare("UPDATE assignments SET status = 'outcome_unknown', updated_at = ?, completed_at = ? WHERE id = ?")
        .run(now, now, payload.assignmentId);
    } else if (actions.length && confirmed === actions.length) {
      database.prepare("UPDATE assignments SET status = 'sent', updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
        .run(now, now, payload.assignmentId);
    } else {
      const status = cancelled && confirmed === 0 ? "cancelled" : "failed";
      database.prepare(`
        UPDATE assignment_action_results SET status = ?, error = ?, updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND status = 'pending'
      `).run(cancelled ? "cancelled" : "failed", message, now, now, operationId);
      database.prepare("UPDATE assignments SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(status, now, now, payload.assignmentId);
    }
    database.prepare("UPDATE posts SET error = ?, updated_at = ? WHERE id = ?").run(message, now, payload.postId);
    reduceTikTokCampaignExecution(database, payload.campaignId, now);
  }).immediate();
}

function confirmedLiveRounds(database: Database.Database, operationId: string) {
  return (database.prepare(`
    SELECT COUNT(*) AS total FROM checkpoints WHERE operation_id = ? AND phase = 'tiktok_live_round_confirmed'
  `).get(operationId) as { total: number }).total;
}

function attachLiveEvidence(database: Database.Database, operationId: string) {
  const checkpoint = database.prepare(`
    SELECT id FROM checkpoints WHERE operation_id = ?
    ORDER BY CASE phase WHEN 'before_tiktok_live_round' THEN 0 ELSE 1 END, sequence DESC, created_at DESC
    LIMIT 1
  `).get(operationId) as { id: string } | undefined;
  if (checkpoint) database.prepare("UPDATE evidence SET checkpoint_id = ? WHERE operation_id = ? AND checkpoint_id IS NULL")
    .run(checkpoint.id, operationId);
}

function saveLiveCheckpoint(database: Database.Database, operationId: string, payload: TikTokLiveExecutionPayload, round: number) {
  return database.transaction(() => {
    const previous = database.prepare(`
      SELECT id FROM checkpoints WHERE operation_id = ? AND phase = 'before_tiktok_live_round' AND sequence = ?
    `).get(operationId, round) as { id: string } | undefined;
    if (previous) return previous.id;
    const id = randomUUID();
    database.prepare(`
      INSERT INTO checkpoints (id, operation_id, assignment_id, phase, sequence, data_json, created_at)
      VALUES (?, ?, ?, 'before_tiktok_live_round', ?, ?, ?)
    `).run(id, operationId, payload.assignmentId, round, stableJson({
      account: payload.expectedAccount,
      liveUrl: payload.liveUrl,
      round,
      rounds: payload.rounds,
      x: payload.x,
      y: payload.y,
    }), Date.now());
    return id;
  }).immediate();
}

function armLiveRound(database: Database.Database, operationId: string, owner: string, round: number) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const job = database.prepare(`
      SELECT id, effect_phase, cancellation_requested_at FROM jobs
      WHERE operation_id = ? AND status = 'running' AND lock_owner = ?
    `).get(operationId, owner) as { id: string; effect_phase: string; cancellation_requested_at: number | null } | undefined;
    if (!job || job.effect_phase !== "before_effect") throw new Error("La ronda Live no esta lista.");
    if (job.cancellation_requested_at !== null) throw new DOMException("Cancelacion solicitada", "AbortError");
    const checkpoint = database.prepare(`
      SELECT 1 FROM checkpoints WHERE operation_id = ? AND phase = 'before_tiktok_live_round' AND sequence = ?
    `).get(operationId, round);
    if (!checkpoint) throw new Error("La ronda Live no tiene checkpoint.");
    const now = Date.now();
    database.prepare("UPDATE jobs SET effect_phase = 'effect_possible', updated_at = ? WHERE id = ?").run(now, job.id);
    database.prepare("UPDATE operations SET effect_phase = 'effect_possible', updated_at = ? WHERE id = ?").run(now, operationId);
  }).immediate();
}

function confirmLiveRound(database: Database.Database, operationId: string, owner: string, payload: TikTokLiveExecutionPayload, round: number) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const job = database.prepare(`
      SELECT id, effect_phase FROM jobs WHERE operation_id = ? AND status = 'running' AND lock_owner = ?
    `).get(operationId, owner) as { id: string; effect_phase: string } | undefined;
    if (!job || job.effect_phase !== "effect_possible") throw new Error("La ronda Live no cruzo su frontera de efecto.");
    database.prepare(`
      INSERT INTO checkpoints (id, operation_id, assignment_id, phase, sequence, data_json, created_at)
      VALUES (?, ?, ?, 'tiktok_live_round_confirmed', ?, ?, ?)
    `).run(randomUUID(), operationId, payload.assignmentId, round, stableJson({ doubleTapCommands: 1, round }), Date.now());
    const phase = round === payload.rounds ? "effect_confirmed" : "before_effect";
    const result = stableJson({ confirmedRounds: round, domainCommitted: false });
    const now = Date.now();
    database.prepare("UPDATE jobs SET effect_phase = ?, result_json = ?, updated_at = ? WHERE id = ?").run(phase, result, now, job.id);
    database.prepare("UPDATE operations SET effect_phase = ?, result_json = ?, updated_at = ? WHERE id = ?").run(phase, result, now, operationId);
  }).immediate();
}

function markLiveFailure(
  database: Database.Database,
  operationId: string,
  owner: string,
  payload: TikTokLiveExecutionPayload,
  error: unknown,
  signal?: AbortSignal,
) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const job = database.prepare("SELECT status, lock_owner, effect_phase, cancellation_requested_at FROM jobs WHERE operation_id = ?")
      .get(operationId) as { status: string; lock_owner: string | null; effect_phase: string; cancellation_requested_at: number | null } | undefined;
    if (!job || job.status !== "running" || job.lock_owner !== owner) return;
    const assignment = database.prepare("SELECT status FROM assignments WHERE id = ?").get(payload.assignmentId) as { status: string };
    if (assignment.status === "sent") {
      reduceTikTokCampaignExecution(database, payload.campaignId);
      return;
    }
    const now = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    const status = job.effect_phase === "effect_possible"
      ? "outcome_unknown"
      : signal?.aborted || job.cancellation_requested_at !== null
        ? "cancelled"
        : "failed";
    database.prepare("UPDATE assignments SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
      .run(status, now, now, payload.assignmentId);
    database.prepare("UPDATE posts SET error = ?, updated_at = ? WHERE id = ?").run(message, now, payload.postId);
    reduceTikTokCampaignExecution(database, payload.campaignId, now);
  }).immediate();
}

async function executePost(
  database: Database.Database,
  operationId: string,
  owner: string,
  payload: TikTokPostExecutionPayload,
  mobile: TikTokPostMobileDriver,
  sessionId: string,
  inspection: AdbDeviceInspection,
  signal?: AbortSignal,
) {
  await mobile.openPost(sessionId, inspection.deviceId, payload.postUrl, signal);
  assertNotCancelled(database, operationId, signal);
  await mobile.verifyAccountAndPost(
    sessionId,
    payload.expectedAccount,
    payload.expectedAccountResourceId,
    payload.expectedPostContainerResourceId,
    payload.expectedPostUrlResourceId,
    payload.postUrl,
    payload.expectedTargetText,
    signal,
  );
  if (payload.actions.like && actionStatus(database, operationId, "like")?.status !== "confirmed") {
    assertNotCancelled(database, operationId, signal);
    if (await mobile.readLikeState(sessionId, signal)) {
      confirmPostAction(database, operationId, owner, "like", "already_active");
    } else {
      const elementId = await mobile.prepareLike(sessionId, signal);
      saveActionCheckpoint(database, operationId, payload, "like");
      assertNotCancelled(database, operationId, signal);
      armPostAction(database, operationId, owner, "like");
      await mobile.tapLike(sessionId, elementId, signal);
      if (!await mobile.readLikeState(sessionId, signal)) throw new TikTokError("TIKTOK_LIKE_NOT_CONFIRMED", "TikTok no confirmo el Like.", 422);
      confirmPostAction(database, operationId, owner, "like", "activated");
    }
  }
  if (payload.actions.comment && payload.comment) {
    assertNotCancelled(database, operationId, signal);
    await mobile.openCommentComposer(sessionId, signal);
    await mobile.assertCommentAbsent(sessionId, payload.comment.text, signal);
    await mobile.enterComment(sessionId, payload.comment.text, signal);
    if (await mobile.readCommentDraft(sessionId, signal) !== payload.comment.text) {
      throw new TikTokError("TIKTOK_COMMENT_TEXT_MISMATCH", "El compositor TikTok no contiene el texto exacto.", 422);
    }
    const submitId = await mobile.prepareCommentSubmit(sessionId, signal);
    saveActionCheckpoint(database, operationId, payload, "comment");
    assertNotCancelled(database, operationId, signal);
    armPostAction(database, operationId, owner, "comment");
    await mobile.submitComment(sessionId, submitId, signal);
    await mobile.confirmCommentVisible(sessionId, payload.comment.text, signal);
    confirmPostAction(database, operationId, owner, "comment", "sent");
  }
  return completeAssignment(database, operationId, payload);
}

async function executeLive(
  database: Database.Database,
  operationId: string,
  owner: string,
  payload: TikTokLiveExecutionPayload,
  mobile: TikTokLiveMobileDriver,
  sessionId: string,
  inspection: AdbDeviceInspection,
  signal?: AbortSignal,
) {
  await mobile.openLive(sessionId, inspection.deviceId, payload.liveUrl, signal);
  assertNotCancelled(database, operationId, signal);
  await mobile.verifyAccountAndLive(
    sessionId,
    payload.expectedAccount,
    payload.expectedAccountResourceId,
    payload.expectedLiveContainerResourceId,
    payload.expectedLiveUrlResourceId,
    payload.liveUrl,
    payload.expectedTargetText,
    signal,
  );
  const completed = confirmedLiveRounds(database, operationId);
  for (let round = completed + 1; round <= payload.rounds; round += 1) {
    assertNotCancelled(database, operationId, signal);
    saveLiveCheckpoint(database, operationId, payload, round);
    assertNotCancelled(database, operationId, signal);
    armLiveRound(database, operationId, owner, round);
    await mobile.doubleTapRound(sessionId, payload.x, payload.y, signal);
    confirmLiveRound(database, operationId, owner, payload, round);
  }
  return completeAssignment(database, operationId, payload, { confirmedRounds: payload.rounds });
}

export async function executeTikTokAssignment(
  database: Database.Database,
  operationId: string,
  owner: string,
  dependencies: TikTokExecutionDependencies,
) {
  const payload = executionPayload(database, operationId);
  const config = dependencies.config ?? readTikTokConfig();
  try {
    assertNotCancelled(database, operationId, dependencies.signal);
    assertExecutionContent(database, payload, config);
    beginExecution(database, payload);
    const defaultMobile = () => new AppiumTikTokMobileDriver(dependencies.adb, dependencies.appium, config);
    const result = await runOwnedDeviceAutomation(
      database,
      operationId,
      owner,
      {
        adb: dependencies.adb,
        appium: dependencies.appium,
        requiredPackage: TIKTOK_APP_PACKAGE,
        artifactsPath: dependencies.artifactsPath,
        cleanupTimeoutMs: dependencies.cleanupTimeoutMs,
        signal: dependencies.signal,
        leaseSignal: dependencies.leaseSignal,
      },
      async (sessionId, inspection) => payload.mode === "post"
        ? executePost(database, operationId, owner, payload, dependencies.postMobile ?? defaultMobile(), sessionId, inspection, dependencies.signal)
        : executeLive(database, operationId, owner, payload, dependencies.liveMobile ?? defaultMobile(), sessionId, inspection, dependencies.signal),
    );
    if (payload.mode === "live") attachLiveEvidence(database, operationId);
    return result;
  } catch (error) {
    if (payload.mode === "live") attachLiveEvidence(database, operationId);
    const cancellation = database.prepare("SELECT cancellation_requested_at FROM jobs WHERE operation_id = ?")
      .get(operationId) as { cancellation_requested_at: number | null } | undefined;
    const interrupted = (dependencies.signal?.aborted || dependencies.leaseSignal?.aborted)
      && cancellation?.cancellation_requested_at === null;
    if (!interrupted) {
      try {
        if (payload.mode === "post") markPostFailure(database, operationId, owner, payload, error, dependencies.signal);
        else markLiveFailure(database, operationId, owner, payload, error, dependencies.signal);
      } catch {
        if (!(error instanceof CleanupUnknownError)) throw error;
      }
    }
    throw error;
  }
}

export function recoverTikTokExecutions(database: Database.Database, owner: string) {
  return database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const rows = database.prepare(`
      SELECT j.status, j.operation_id, j.assignment_id, j.post_id, j.campaign_id, j.error,
        j.effect_phase, j.result_json, o.request_json, o.cleanup_status,
        a.status AS assignment_status
      FROM jobs j JOIN operations o ON o.id = j.operation_id
      JOIN assignments a ON a.id = j.assignment_id
      JOIN campaigns c ON c.id = j.campaign_id
      WHERE j.kind = 'assignment.execute' AND c.platform = 'tiktok'
        AND (
          j.status IN ('pending', 'failed', 'cancelled', 'outcome_unknown')
          OR (j.status = 'succeeded' AND o.cleanup_status IN ('failed', 'outcome_unknown')
            AND c.status NOT IN ('completed_with_issues', 'cancelled_with_cleanup_errors'))
        )
    `).all() as Array<{
      status: "pending" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
      operation_id: string;
      assignment_id: string;
      post_id: string;
      campaign_id: string;
      error: string | null;
      effect_phase: string;
      result_json: string | null;
      request_json: string;
      assignment_status: string;
      cleanup_status: string;
    }>;
    let changed = 0;
    const campaigns = new Set<string>();
    for (const row of rows) {
      if (row.status === "succeeded") {
        campaigns.add(row.campaign_id);
        changed += 1;
        continue;
      }
      const payload = JSON.parse(row.request_json) as TikTokExecutionPayload;
      if (row.status === "pending") {
        if (["running", "cancellation_requested"].includes(row.assignment_status) && row.effect_phase !== "effect_possible") {
          database.prepare("UPDATE assignments SET status = 'scheduled', completed_at = NULL, updated_at = ? WHERE id = ?")
            .run(Date.now(), row.assignment_id);
          campaigns.add(row.campaign_id);
          changed += 1;
        }
        continue;
      }
      if (!["running", "cancellation_requested"].includes(row.assignment_status)) continue;
      const now = Date.now();
      const message = row.error ?? "Worker TikTok interrumpido";
      if (payload.mode === "post") {
        const actions = database.prepare("SELECT status FROM assignment_action_results WHERE operation_id = ?")
          .all(row.operation_id) as Array<{ status: string }>;
        const possible = actions.some((action) => action.status === "effect_possible");
        const confirmed = actions.length > 0 && actions.every((action) => action.status === "confirmed");
        if (possible) {
          database.prepare(`
            UPDATE assignment_action_results SET status = 'outcome_unknown', error = COALESCE(error, ?), updated_at = ?, completed_at = ?
            WHERE operation_id = ? AND status = 'effect_possible'
          `).run(message, now, now, row.operation_id);
          database.prepare("UPDATE assignments SET status = 'outcome_unknown', updated_at = ?, completed_at = ? WHERE id = ?")
            .run(now, now, row.assignment_id);
        } else if (confirmed) {
          database.prepare("UPDATE assignments SET status = 'sent', updated_at = ?, completed_at = ? WHERE id = ?")
            .run(now, now, row.assignment_id);
        } else {
          database.prepare(`
            UPDATE assignment_action_results SET status = ?, error = COALESCE(error, ?), updated_at = ?, completed_at = ?
            WHERE operation_id = ? AND status = 'pending'
          `).run(row.status === "cancelled" ? "cancelled" : "failed", message, now, now, row.operation_id);
          database.prepare("UPDATE assignments SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
            .run(row.status === "cancelled" ? "cancelled" : "failed", now, now, row.assignment_id);
        }
      } else {
        const result = row.result_json ? JSON.parse(row.result_json) as { confirmedRounds?: unknown; domainCommitted?: unknown } : null;
        const status = row.effect_phase === "effect_possible"
          ? "outcome_unknown"
          : result?.domainCommitted === true && result.confirmedRounds === payload.rounds
            ? "sent"
            : row.status === "cancelled"
              ? "cancelled"
              : "failed";
        database.prepare("UPDATE assignments SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
          .run(status, now, now, row.assignment_id);
        attachLiveEvidence(database, row.operation_id);
      }
      database.prepare("UPDATE posts SET error = ?, updated_at = ? WHERE id = ?").run(message, now, row.post_id);
      campaigns.add(row.campaign_id);
      changed += 1;
    }
    for (const campaignId of campaigns) reduceTikTokCampaignExecution(database, campaignId);
    return changed;
  }).immediate();
}
