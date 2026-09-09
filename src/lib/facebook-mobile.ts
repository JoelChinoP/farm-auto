import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { AdbClient, AdbDeviceInspection } from "./adb.ts";
import type { AppiumClient, AppiumElement } from "./appium-client.ts";
import { appConfig } from "./config.ts";
import {
  assertRuntimeOwnership,
  CleanupUnknownError,
  runOwnedDeviceAutomation,
} from "./device-runtime.ts";
import {
  FACEBOOK_APP_PACKAGE,
  facebookContentKind,
  FacebookError,
  type FacebookContentKind,
  type FacebookExecutionPayload,
  normalizeFacebookUrl,
  reduceFacebookCampaignExecution,
} from "./facebook.ts";
import { getOperation, stableJson } from "./operations.ts";

type FacebookAction = "like" | "comment" | "share";
const STRUCTURAL_SELECTOR = "@accessibility";

export type FacebookMobileDriver = {
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
    contentKind?: FacebookContentKind,
  ): Promise<void>;
  readLikeState(sessionId: string, signal?: AbortSignal): Promise<boolean>;
  prepareLike(sessionId: string, signal?: AbortSignal): Promise<string>;
  tapLike(sessionId: string, elementId: string, signal?: AbortSignal): Promise<void>;
  prepareShare(sessionId: string, signal?: AbortSignal): Promise<string>;
  openShareMenu(sessionId: string, elementId: string, signal?: AbortSignal): Promise<void>;
  prepareShareNow(sessionId: string, signal?: AbortSignal): Promise<string>;
  submitShare(sessionId: string, elementId: string, signal?: AbortSignal): Promise<void>;
  confirmShare(sessionId: string, signal?: AbortSignal): Promise<void>;
  assertCommentAbsent(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
  openCommentComposer(sessionId: string, signal?: AbortSignal): Promise<void>;
  enterComment(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
  readCommentDraft(sessionId: string, signal?: AbortSignal): Promise<string>;
  prepareCommentSubmit(sessionId: string, signal?: AbortSignal): Promise<string>;
  submitComment(sessionId: string, elementId: string, signal?: AbortSignal): Promise<void>;
  confirmCommentVisible(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
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

export class AppiumFacebookMobileDriver implements FacebookMobileDriver {
  readonly #adb: AdbClient;
  readonly #appium: AppiumClient;
  readonly #commentResourceIds: { composer: string; editor: string; submit: string; result: string };
  readonly #targets = new Map<string, {
    text: string;
    containerResourceId: string;
    urlResourceId: string;
    url: string;
    contentKind: FacebookContentKind;
  }>();
  readonly #postContainers = new Map<string, AppiumElement>();
  readonly #devices = new Map<string, string>();
  readonly #commentSurfaces = new Map<string, string>();

  constructor(
    adb: AdbClient,
    appium: AppiumClient,
    commentResourceIds = {
      composer: appConfig.facebookCommentComposerResourceId,
      editor: appConfig.facebookCommentEditorResourceId,
      submit: appConfig.facebookCommentSubmitResourceId,
      result: appConfig.facebookCommentResultContainerResourceId,
    },
  ) {
    this.#adb = adb;
    this.#appium = appium;
    this.#commentResourceIds = commentResourceIds;
  }

  async #waitFor<T>(read: () => Promise<T | null>, message: string, signal?: AbortSignal) {
    const startedAt = Date.now();
    while (true) {
      signal?.throwIfAborted();
      const value = await read();
      if (value !== null) return value;
      if (Date.now() - startedAt >= appConfig.facebookUiTimeoutMs) throw new FacebookError("FACEBOOK_UI_NOT_VERIFIED", message, 422);
      await delay(250, undefined, { signal });
    }
  }

  async #elementsForLabels(sessionId: string, labels: string[], signal?: AbortSignal, parentElementId?: string) {
    const elements = new Map<string, AppiumElement>();
    for (const label of labels) {
      const foundByAccessibility = parentElementId
        ? await this.#appium.findElementsFromElement(sessionId, parentElementId, "accessibility id", label, { signal })
        : await this.#appium.findElements(sessionId, "accessibility id", label, { signal });
      const literal = xpathLiteral(visibleText(label));
      const foundByText = parentElementId
        ? await this.#appium.findElementsFromElement(
          sessionId,
          parentElementId,
          "xpath",
          `.//*[normalize-space(@text) = ${literal} or normalize-space(@content-desc) = ${literal}]`,
          { signal },
        )
        : await this.#appium.findElements(
          sessionId,
          "xpath",
          `//*[normalize-space(@text) = ${literal} or normalize-space(@content-desc) = ${literal}]`,
          { signal },
        );
      for (const element of [...foundByAccessibility, ...foundByText]) {
        elements.set(element.elementId, element);
      }
    }
    return [...elements.values()];
  }

  async #uniqueLabelElement(sessionId: string, labels: string[], description: string, signal?: AbortSignal, parentElementId?: string) {
    return this.#waitFor(async () => {
      const elements = await this.#elementsForLabels(sessionId, labels, signal, parentElementId);
      if (elements.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", `${description} es ambiguo.`, 422);
      return elements[0] ?? null;
    }, `No se pudo verificar ${description}.`, signal);
  }

  async #commentComposer(sessionId: string, signal?: AbortSignal) {
    if (this.#commentResourceIds.composer === STRUCTURAL_SELECTOR) {
      return this.#waitFor(async () => {
        const editors = await this.#appium.findElements(sessionId, "xpath", "//android.widget.EditText", { signal });
        if (editors.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "Hay mas de un compositor de comentarios.", 422);
        return editors[0] ?? null;
      }, "la estructura del compositor de comentarios", signal);
    }
    return this.#waitFor(async () => {
      const composers = await this.#appium.findElements(sessionId, "id", this.#commentResourceIds.composer, { signal });
      if (composers.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "Hay mas de un compositor de comentarios.", 422);
      return composers[0] ?? null;
    }, "la estructura del compositor de comentarios", signal);
  }

  async #commentEditors(sessionId: string, signal?: AbortSignal) {
    const composer = await this.#commentComposer(sessionId, signal);
    if (this.#commentResourceIds.editor === STRUCTURAL_SELECTOR) return [composer];
    return this.#appium.findElementsFromElement(
      sessionId,
      composer.elementId,
      "id",
      this.#commentResourceIds.editor,
      { signal },
    );
  }

  async #commentSurface(sessionId: string, signal?: AbortSignal) {
    if (this.#commentResourceIds.result === STRUCTURAL_SELECTOR) {
      return this.#waitFor(async () => {
        const surfaces = await this.#appium.findElements(
          sessionId,
          "xpath",
          "//androidx.recyclerview.widget.RecyclerView[.//*[@text != '' or @content-desc != '']]",
          { signal },
        );
        if (surfaces.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "Hay mas de una superficie de comentarios.", 422);
        return surfaces[0] ?? null;
      }, "la superficie de comentarios de la publicacion objetivo", signal);
    }
    return this.#waitFor(async () => {
      const surfaces = await this.#appium.findElements(sessionId, "id", this.#commentResourceIds.result, { signal });
      if (surfaces.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "Hay mas de una superficie de comentarios.", 422);
      return surfaces[0] ?? null;
    }, "la superficie de comentarios de la publicacion objetivo", signal);
  }

  #target(sessionId: string) {
    const target = this.#targets.get(sessionId);
    if (!target) throw new FacebookError("FACEBOOK_TARGET_NOT_VERIFIED", "La publicacion no fue verificada en esta sesion.", 422);
    return target;
  }

  async #postContainer(sessionId: string, signal?: AbortSignal) {
    const target = this.#target(sessionId);
    const targetText = visibleText(target.text);
    const locator = `.//*[contains(normalize-space(@text), ${xpathLiteral(targetText)}) or contains(normalize-space(@content-desc), ${xpathLiteral(targetText)})]`;
    if (target.containerResourceId === STRUCTURAL_SELECTOR && target.urlResourceId === STRUCTURAL_SELECTOR) {
      const cached = this.#postContainers.get(sessionId);
      if (cached) return cached;
      // ponytail: la app movil trunca el caption con "Ver mas"; un prefijo corto aun identifica la publicacion exacta.
      const prefixLocator = `.//*[contains(normalize-space(@text), ${xpathLiteral(targetText.slice(0, 60))}) or contains(normalize-space(@content-desc), ${xpathLiteral(targetText.slice(0, 60))})]`;
      const structuralLocator = target.contentKind === "reel"
        ? `//androidx.recyclerview.widget.RecyclerView[${prefixLocator}]`
        : `${prefixLocator}/ancestor::android.view.ViewGroup[parent::androidx.recyclerview.widget.RecyclerView][1]`;
      const container = await this.#waitFor(async () => {
        const found = await this.#appium.findElements(sessionId, "xpath", structuralLocator, { signal });
        const containers = [...new Map(found.map((element) => [element.elementId, element])).values()];
        if (containers.length > 1) throw new FacebookError("FACEBOOK_TARGET_AMBIGUOUS", "Mas de una publicacion coincide con la referencia.", 422);
        return containers[0] ?? null;
      }, "el contenedor estructural de la publicacion exacta", signal);
      this.#postContainers.set(sessionId, container);
      return container;
    }
    return this.#waitFor(async () => {
      const containers = await this.#appium.findElements(sessionId, "id", target.containerResourceId, { signal });
      const matches: AppiumElement[] = [];
      let textMatches = 0;
      for (const container of containers) {
        const targets = await this.#appium.findElementsFromElement(sessionId, container.elementId, "xpath", locator, { signal });
        if (targets.length > 1) {
          throw new FacebookError("FACEBOOK_TARGET_AMBIGUOUS", "La referencia aparece mas de una vez dentro de la publicacion.", 422);
        }
        if (targets.length !== 1) continue;
        textMatches += 1;
        const urls = await this.#appium.findElementsFromElement(sessionId, container.elementId, "id", target.urlResourceId, { signal });
        if (urls.length > 1) throw new FacebookError("FACEBOOK_TARGET_AMBIGUOUS", "El permalink de la publicacion es ambiguo.", 422);
        if (!urls[0]) continue;
        const [text, description] = await Promise.all([
          this.#appium.getElementText(sessionId, urls[0].elementId, { signal }),
          this.#appium.getElementAttribute(sessionId, urls[0].elementId, "content-desc", { signal }),
        ]);
        const expectedUrl = normalizeFacebookUrl(target.url).normalizedUrl;
        const matchesUrl = [text, description].some((value) => {
          try {
            return value !== null && normalizeFacebookUrl(value).normalizedUrl === expectedUrl;
          } catch {
            return false;
          }
        });
        if (matchesUrl) matches.push(container);
      }
      if (matches.length > 1) throw new FacebookError("FACEBOOK_TARGET_AMBIGUOUS", "Mas de una publicacion coincide con la referencia.", 422);
      if (textMatches > 0 && matches.length === 0) {
        throw new FacebookError("FACEBOOK_POST_URL_MISMATCH", "La publicacion visible no expone la URL efectiva autorizada.", 422);
      }
      return matches[0] ?? null;
    }, "el contenedor estructural de la publicacion exacta", signal);
  }

  async #scrollTargetPostControls(sessionId: string, signal?: AbortSignal) {
    const lists = await this.#appium.findElements(sessionId, "id", "android:id/list", { signal });
    const locator = lists.length
      ? 'new UiScrollable(new UiSelector().resourceId("android:id/list")).scrollForward()'
      : 'new UiScrollable(new UiSelector().scrollable(true).instance(0)).scrollForward()';
    await this.#appium.findElements(
      sessionId,
      "-android uiautomator",
      locator,
      { signal },
    );
  }

  async #exactTextElements(sessionId: string, parentElementId: string, text: string, signal?: AbortSignal) {
    const expected = visibleText(text);
    const literal = xpathLiteral(expected);
    return this.#appium.findElementsFromElement(
      sessionId,
      parentElementId,
      "xpath",
      `.//*[normalize-space(@text) = ${literal} or normalize-space(@content-desc) = ${literal}]`,
      { signal },
    );
  }

  async openPost(sessionId: string, deviceId: string, url: string, signal?: AbortSignal) {
    this.#devices.set(sessionId, deviceId);
    await this.#appium.activateApp(sessionId, FACEBOOK_APP_PACKAGE, { signal });
    await this.#appium.executeScript(sessionId, "mobile: deepLink", [{ url, package: FACEBOOK_APP_PACKAGE }], { signal });
    await this.#waitFor(async () => {
      const foreground = await this.#adb.getForeground(deviceId, { signal });
      return foreground?.packageName === FACEBOOK_APP_PACKAGE ? true : null;
    }, "Facebook en primer plano.", signal);
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
    contentKind?: FacebookContentKind,
  ) {
    // La identidad estructural ya esta ligada al dispositivo; openPost abre directamente el objetivo en Lite.
    if (accountResourceId !== STRUCTURAL_SELECTOR
      || postContainerResourceId !== STRUCTURAL_SELECTOR
      || postUrlResourceId !== STRUCTURAL_SELECTOR) {
      await this.#waitFor(async () => {
        const accounts = await this.#appium.findElements(sessionId, "id", accountResourceId, { signal });
        if (accounts.length > 1) throw new FacebookError("FACEBOOK_ACCOUNT_AMBIGUOUS", "El indicador de cuenta activa es ambiguo.", 422);
        if (!accounts[0]) return null;
        const [text, description] = await Promise.all([
          this.#appium.getElementText(sessionId, accounts[0].elementId, { signal }),
          this.#appium.getElementAttribute(sessionId, accounts[0].elementId, "content-desc", { signal }),
        ]);
        if (![text, description].some((value) => value !== null && normalized(value) === normalized(account))) {
          throw new FacebookError("FACEBOOK_ACCOUNT_MISMATCH", "El indicador de cuenta activa no coincide con la cuenta controlada.", 422);
        }
        return true;
      }, "el indicador estable de la cuenta controlada", signal);
    }
    this.#targets.set(sessionId, {
      text: targetText,
      containerResourceId: postContainerResourceId,
      urlResourceId: postUrlResourceId,
      url: postUrl,
      contentKind: contentKind ?? facebookContentKind(postUrl),
    });
    await this.#postContainer(sessionId, signal);
  }

  async #structuralButtons(sessionId: string, parentElementId: string, signal?: AbortSignal) {
    const buttons = await this.#appium.findElementsFromElement(sessionId, parentElementId, "xpath", ".//android.widget.Button", { signal });
    return Promise.all(buttons.map(async (element) => {
      const [text, description] = await Promise.all([
        this.#appium.getElementText(sessionId, element.elementId, { signal }),
        this.#appium.getElementAttribute(sessionId, element.elementId, "content-desc", { signal }),
      ]);
      return { element, label: visibleText(description || text || "") };
    }));
  }

  async #structuralLike(sessionId: string, signal?: AbortSignal) {
    const container = await this.#postContainer(sessionId, signal);
    for (let attempt = 0; attempt < 4; attempt++) {
      const buttons = await this.#structuralButtons(sessionId, container.elementId, signal);
      let matches = buttons.filter(({ label }) => {
        const value = normalized(label);
        return value.includes("me gusta") || /(^|\s)like(\s|$)/u.test(value);
      });
      if (!matches.length) {
        const reactions = await this.#appium.findElementsFromElement(
          sessionId,
          container.elementId,
          "xpath",
          ".//android.widget.Button[(contains(@content-desc, 'reacciones') or contains(@content-desc, 'reactions')) and .//android.view.ViewGroup]",
          { signal },
        );
        matches = await Promise.all(reactions.map(async (element) => ({
          element,
          label: visibleText(await this.#appium.getElementAttribute(sessionId, element.elementId, "content-desc", { signal }) ?? ""),
        })));
      }
      if (matches.length === 1) {
        const label = normalized(matches[0].label);
        const [selected, checked] = await Promise.all([
          this.#appium.getElementAttribute(sessionId, matches[0].element.elementId, "selected", { signal }),
          this.#appium.getElementAttribute(sessionId, matches[0].element.elementId, "checked", { signal }),
        ]);
        const active = selected === "true"
          || checked === "true"
          || label.includes("presionado")
          || label.includes("pressed")
          || label.includes("ya no me gusta")
          || label.includes("unlike")
          || label.includes("remove like")
          || label.includes("quitar me gusta");
        return { element: matches[0].element, active };
      }
      if (matches.length > 1) throw new FacebookError("FACEBOOK_LIKE_STATE_AMBIGUOUS", "No existe un unico control Like verificable en la publicacion objetivo.", 422);
      if (attempt < 3) await this.#scrollTargetPostControls(sessionId, signal);
    }
    throw new FacebookError("FACEBOOK_LIKE_STATE_AMBIGUOUS", "No existe un unico control Like verificable en la publicacion objetivo.", 422);
  }

  async readLikeState(sessionId: string, signal?: AbortSignal) {
    const target = this.#target(sessionId);
    if (target.containerResourceId === STRUCTURAL_SELECTOR) return (await this.#structuralLike(sessionId, signal)).active;
    const container = await this.#postContainer(sessionId, signal);
    const active = await this.#elementsForLabels(sessionId, appConfig.facebookLikeActiveLabels, signal, container.elementId);
    const inactive = await this.#elementsForLabels(sessionId, appConfig.facebookLikeInactiveLabels, signal, container.elementId);
    if (active.length === 1 && inactive.length === 0) return true;
    if (active.length === 0 && inactive.length === 1) {
      const selected = await this.#appium.getElementAttribute(sessionId, inactive[0].elementId, "selected", { signal });
      const checked = await this.#appium.getElementAttribute(sessionId, inactive[0].elementId, "checked", { signal });
      return selected === "true" || checked === "true";
    }
    throw new FacebookError("FACEBOOK_LIKE_STATE_AMBIGUOUS", "No se pudo determinar el estado exacto del Like.", 422);
  }

  async prepareLike(sessionId: string, signal?: AbortSignal) {
    const target = this.#target(sessionId);
    if (target.containerResourceId === STRUCTURAL_SELECTOR) return (await this.#structuralLike(sessionId, signal)).element.elementId;
    const container = await this.#postContainer(sessionId, signal);
    return (await this.#uniqueLabelElement(sessionId, appConfig.facebookLikeInactiveLabels, "el boton Like de la publicacion objetivo", signal, container.elementId)).elementId;
  }

  async tapLike(sessionId: string, elementId: string, signal?: AbortSignal) {
    await this.#appium.clickElement(sessionId, elementId, { signal });
  }

  async prepareShare(sessionId: string, signal?: AbortSignal) {
    const container = await this.#postContainer(sessionId, signal);
    for (let attempt = 0; attempt < 4; attempt++) {
      const target = this.#target(sessionId);
      const shares = target.containerResourceId === STRUCTURAL_SELECTOR
        ? (await this.#structuralButtons(sessionId, container.elementId, signal))
          .filter(({ label }) => appConfig.facebookShareLabels.some((shareLabel) => normalized(label) === normalized(shareLabel))
            || target.contentKind === "reel" && /^(?:compartir|share),/u.test(normalized(label)))
          .map(({ element }) => element)
        : await this.#elementsForLabels(sessionId, appConfig.facebookShareLabels, signal, container.elementId);
      if (shares.length === 1) return shares[0].elementId;
      if (shares.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "No existe un unico control Compartir en la publicacion objetivo.", 422);
      if (attempt < 3) await this.#scrollTargetPostControls(sessionId, signal);
    }
    throw new FacebookError("FACEBOOK_UI_NOT_VERIFIED", "No se pudo verificar Compartir dentro de la publicacion objetivo.", 422);
  }

  async openShareMenu(sessionId: string, elementId: string, signal?: AbortSignal) {
    await this.#appium.clickElement(sessionId, elementId, { signal });
  }

  async prepareShareNow(sessionId: string, signal?: AbortSignal) {
    return (await this.#uniqueLabelElement(sessionId, appConfig.facebookShareNowLabels, "la confirmacion Compartir ahora", signal)).elementId;
  }

  async submitShare(sessionId: string, elementId: string, signal?: AbortSignal) {
    await this.#appium.clickElement(sessionId, elementId, { signal });
  }

  async confirmShare(sessionId: string, signal?: AbortSignal) {
    await this.#uniqueLabelElement(sessionId, appConfig.facebookShareConfirmationLabels, "la confirmacion visible de que Facebook compartio", signal);
  }

  async assertCommentAbsent(sessionId: string, text: string, signal?: AbortSignal) {
    const surfaceId = this.#commentSurfaces.get(sessionId);
    if (!surfaceId) throw new FacebookError("FACEBOOK_TARGET_NOT_VERIFIED", "La superficie de comentarios no fue abierta desde la publicacion objetivo.", 422);
    if ((await this.#exactTextElements(sessionId, surfaceId, text, signal)).length) {
      throw new FacebookError(
        "FACEBOOK_COMMENT_ALREADY_VISIBLE",
        "El comentario exacto ya es visible; verifica manualmente antes de intentar enviarlo.",
        409,
      );
    }
  }

  async openCommentComposer(sessionId: string, signal?: AbortSignal) {
    const container = await this.#postContainer(sessionId, signal);
    if (this.#commentResourceIds.composer === STRUCTURAL_SELECTOR) {
      const existing = await this.#appium.findElements(sessionId, "xpath", "//android.widget.EditText", { signal });
      if (existing.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "Hay mas de un compositor de comentarios.", 422);
      if (existing.length === 1) {
        this.#commentSurfaces.set(sessionId, (await this.#commentSurface(sessionId, signal)).elementId);
        return;
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const buttons = await this.#structuralButtons(sessionId, container.elementId, signal);
        const exact = buttons.filter(({ label }) => ["comentar", "comment", "agregar un comentario", "add a comment"].includes(normalized(label)));
        const fallback = buttons.filter(({ label }) => {
          const value = normalized(label);
          return value.includes("comentario") || value.includes("comment");
        });
        const triggers = exact.length ? exact : fallback;
        if (triggers.length === 1) {
          await this.#appium.clickElement(sessionId, triggers[0].element.elementId, { signal });
          await this.#commentComposer(sessionId, signal);
          this.#commentSurfaces.set(sessionId, (await this.#commentSurface(sessionId, signal)).elementId);
          return;
        }
        if (triggers.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "No existe un unico acceso a comentarios en la publicacion objetivo.", 422);
        if (attempt < 3) await this.#scrollTargetPostControls(sessionId, signal);
      }
      throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "No existe un unico acceso a comentarios en la publicacion objetivo.", 422);
    }
    const trigger = await this.#uniqueLabelElement(sessionId, appConfig.facebookCommentLabels, "el compositor de comentarios de la publicacion objetivo", signal, container.elementId);
    const existing = await this.#appium.findElements(sessionId, "id", this.#commentResourceIds.composer, { signal });
    const existingSurfaces = await this.#appium.findElements(sessionId, "id", this.#commentResourceIds.result, { signal });
    if (existing.length || existingSurfaces.length) {
      throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "Ya habia un compositor abierto antes de seleccionar la publicacion objetivo.", 422);
    }
    await this.#appium.clickElement(sessionId, trigger.elementId, { signal });
    await this.#waitFor(async () => {
      const editors = await this.#commentEditors(sessionId, signal);
      if (editors.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "Hay mas de un compositor editable.", 422);
      return editors[0] ?? null;
    }, "el campo de comentario", signal);
    this.#commentSurfaces.set(sessionId, (await this.#commentSurface(sessionId, signal)).elementId);
  }

  async enterComment(sessionId: string, text: string, signal?: AbortSignal) {
    const editors = await this.#commentEditors(sessionId, signal);
    if (editors.length !== 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "No existe un unico campo de comentario.", 422);
    await this.#appium.clearElement(sessionId, editors[0].elementId, { signal });
    await this.#appium.setElementValue(sessionId, editors[0].elementId, text, { signal });
  }

  async readCommentDraft(sessionId: string, signal?: AbortSignal) {
    const editors = await this.#commentEditors(sessionId, signal);
    if (editors.length !== 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "No existe un unico campo de comentario.", 422);
    return this.#appium.getElementText(sessionId, editors[0].elementId, { signal });
  }

  async prepareCommentSubmit(sessionId: string, signal?: AbortSignal) {
    if (this.#commentResourceIds.submit === STRUCTURAL_SELECTOR) {
      const submits = [
        ...await this.#appium.findElements(sessionId, "accessibility id", "Enviar", { signal }),
        ...await this.#appium.findElements(sessionId, "accessibility id", "Send", { signal }),
      ];
      const unique = [...new Map(submits.map((element) => [element.elementId, element])).values()];
      if (unique.length !== 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "No existe un unico boton para publicar dentro del compositor.", 422);
      return unique[0].elementId;
    }
    const composer = await this.#commentComposer(sessionId, signal);
    const submits = await this.#appium.findElementsFromElement(
      sessionId,
      composer.elementId,
      "id",
      this.#commentResourceIds.submit,
      { signal },
    );
    if (submits.length !== 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "No existe un unico boton para publicar dentro del compositor.", 422);
    return submits[0].elementId;
  }

  async submitComment(sessionId: string, elementId: string, signal?: AbortSignal) {
    await this.#appium.clickElement(sessionId, elementId, { signal });
  }

  async confirmCommentVisible(sessionId: string, text: string, signal?: AbortSignal) {
    const surfaceId = this.#commentSurfaces.get(sessionId);
    if (!surfaceId) throw new FacebookError("FACEBOOK_TARGET_NOT_VERIFIED", "La superficie de comentarios no fue abierta desde la publicacion objetivo.", 422);
    if (this.#commentResourceIds.composer === STRUCTURAL_SELECTOR) {
      await this.#waitFor(async () => {
        const sent = await this.#exactTextElements(sessionId, surfaceId, text, signal);
        const editors = await this.#appium.findElements(sessionId, "xpath", "//android.widget.EditText", { signal });
        const drafts = await Promise.all(editors.map((element) => this.#appium.getElementText(sessionId, element.elementId, { signal })));
        return sent.length === 1 && !drafts.includes(text) ? true : null;
      }, "la visibilidad del comentario enviado", signal);
      return;
    }
    await this.#waitFor(async () => {
      const composers = await this.#appium.findElements(sessionId, "id", this.#commentResourceIds.composer, { signal });
      if (composers.length > 1) throw new FacebookError("FACEBOOK_UI_AMBIGUOUS", "Hay mas de un compositor de comentarios.", 422);
      const editors = composers[0]
        ? await this.#appium.findElementsFromElement(sessionId, composers[0].elementId, "id", this.#commentResourceIds.editor, { signal })
        : [];
      return (await this.#exactTextElements(sessionId, surfaceId, text, signal)).length === 1 && editors.length === 0 ? true : null;
    }, "la visibilidad del comentario enviado", signal);
  }
}

type FacebookExecutionDependencies = {
  adb: AdbClient;
  appium: AppiumClient;
  mobile?: FacebookMobileDriver;
  controlledAccount?: string;
  controlledAccountResourceId?: string;
  postContainerResourceId?: string;
  postUrlResourceId?: string;
  commentComposerResourceId?: string;
  commentEditorResourceId?: string;
  commentSubmitResourceId?: string;
  commentResultContainerResourceId?: string;
  artifactsPath?: string;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
  leaseSignal?: AbortSignal;
};

function executionPayload(database: Database.Database, operationId: string) {
  const operation = getOperation(database, operationId);
  if (!operation?.campaignId || !operation.postId || !operation.assignmentId || !operation.deviceId
    || operation.kind !== "assignment.execute" || operation.status !== "running") {
    throw new Error("La operacion de ejecucion Facebook no es valida.");
  }
  const request = operation.request as FacebookExecutionPayload;
  return {
    operation,
    payload: {
      ...request,
      actions: { ...request.actions, share: request.actions.share === true },
      expectedShareLabels: request.expectedShareLabels ?? null,
      expectedShareNowLabels: request.expectedShareNowLabels ?? null,
      expectedShareConfirmationLabels: request.expectedShareConfirmationLabels ?? null,
    },
  };
}

function assertExecutionContent(
  database: Database.Database,
  payload: FacebookExecutionPayload,
  controlledAccount: string,
  accountResourceId: string,
  postContainerResourceId: string,
  postUrlResourceId: string,
  commentComposerResourceId: string,
  commentEditorResourceId: string,
  commentSubmitResourceId: string,
  commentResultContainerResourceId: string,
) {
  if (payload.expectedAccount !== controlledAccount.trim() || !controlledAccount.trim()
    || payload.expectedAccountResourceId !== accountResourceId.trim() || !accountResourceId.trim()
    || payload.expectedPostContainerResourceId !== postContainerResourceId.trim() || !postContainerResourceId.trim()
    || payload.expectedPostUrlResourceId !== postUrlResourceId.trim() || !postUrlResourceId.trim()) {
    throw new FacebookError("CONTROLLED_ACCOUNT_CHANGED", "La cuenta controlada configurada cambio antes de ejecutar.", 409);
  }
  if (payload.actions.comment && (
    payload.expectedCommentComposerResourceId !== commentComposerResourceId.trim()
    || payload.expectedCommentEditorResourceId !== commentEditorResourceId.trim()
    || payload.expectedCommentSubmitResourceId !== commentSubmitResourceId.trim()
    || payload.expectedCommentResultContainerResourceId !== commentResultContainerResourceId.trim()
    || !commentComposerResourceId.trim()
    || !commentEditorResourceId.trim()
    || !commentSubmitResourceId.trim()
    || !commentResultContainerResourceId.trim()
  )) {
    throw new FacebookError("FACEBOOK_COMMENT_STRUCTURE_CHANGED", "La estructura configurada del compositor cambio antes de ejecutar.", 409);
  }
  const row = database.prepare(`
    SELECT c.like_enabled, c.comment_enabled, c.share_enabled, p.context_hash, p.source_url, p.final_url,
      a.status AS assignment_status, p.content_kind
    FROM assignments a
    JOIN campaigns c ON c.id = a.campaign_id
    JOIN posts p ON p.id = a.post_id
    WHERE a.id = ? AND a.campaign_id = ? AND a.post_id = ? AND a.device_id = ?
  `).get(payload.assignmentId, payload.campaignId, payload.postId, payload.deviceId) as {
    like_enabled: 0 | 1;
    comment_enabled: 0 | 1;
    share_enabled: 0 | 1;
    context_hash: string | null;
    source_url: string;
    final_url: string | null;
    assignment_status: string;
    content_kind: FacebookContentKind | null;
  } | undefined;
  if (!row || !["approved", "scheduled"].includes(row.assignment_status)
    || Boolean(row.like_enabled) !== payload.actions.like
    || Boolean(row.comment_enabled) !== payload.actions.comment
    || Boolean(row.share_enabled) !== payload.actions.share
    || row.context_hash !== payload.contextHash
    || (row.final_url ?? row.source_url) !== payload.postUrl
    || row.content_kind !== payload.contentKind) {
    throw new FacebookError("EXECUTION_CONTENT_CHANGED", "La campana cambio antes de la ejecucion.", 409);
  }
  if (payload.actions.share && (!payload.contentKind || payload.contentKind !== facebookContentKind(payload.postUrl))) {
    throw new FacebookError("SHARE_CONTENT_NOT_VERIFIED", "La publicacion debe resolverse y verificarse antes de compartir.", 409);
  }
  if (payload.actions.comment) {
    const comment = database.prepare(`
      SELECT id, version, text, status, stale FROM comments
      WHERE assignment_id = ? AND version = (
        SELECT MAX(version) FROM comments WHERE assignment_id = ?
      )
    `).get(payload.assignmentId, payload.assignmentId) as {
      id: string;
      version: number;
      text: string;
      status: string;
      stale: 0 | 1;
    } | undefined;
    if (!payload.comment || !comment
      || comment.id !== payload.comment.id
      || comment.version !== payload.comment.version
      || comment.text !== payload.comment.text
      || comment.status !== "ready" && comment.status !== "edited"
      || comment.stale) {
      throw new FacebookError("EXECUTION_COMMENT_CHANGED", "El comentario cambio antes de la ejecucion.", 409);
    }
  }
  if (payload.actions.share && (
    stableJson(payload.expectedShareLabels) !== stableJson(appConfig.facebookShareLabels)
    || stableJson(payload.expectedShareNowLabels) !== stableJson(appConfig.facebookShareNowLabels)
    || stableJson(payload.expectedShareConfirmationLabels) !== stableJson(appConfig.facebookShareConfirmationLabels)
  )) {
    throw new FacebookError("FACEBOOK_SHARE_STRUCTURE_CHANGED", "Los selectores de Compartir cambiaron antes de ejecutar.", 409);
  }
}

function assertNotCancelled(database: Database.Database, operationId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const job = database.prepare("SELECT cancellation_requested_at FROM jobs WHERE operation_id = ?")
    .get(operationId) as { cancellation_requested_at: number | null } | undefined;
  if (!job || job.cancellation_requested_at !== null) throw new DOMException("Cancelacion solicitada", "AbortError");
}

function beginExecution(database: Database.Database, payload: FacebookExecutionPayload) {
  const now = Date.now();
  database.transaction(() => {
    database.prepare("UPDATE assignments SET status = 'running', actual_at = COALESCE(actual_at, ?), updated_at = ? WHERE id = ?")
      .run(now, now, payload.assignmentId);
    reduceFacebookCampaignExecution(database, payload.campaignId, now);
  })();
}

function actionStatus(database: Database.Database, operationId: string, action: FacebookAction) {
  return database.prepare(`
    SELECT status FROM assignment_action_results WHERE operation_id = ? AND action = ?
  `).get(operationId, action) as { status: string } | undefined;
}

function startAction(database: Database.Database, operationId: string, action: FacebookAction) {
  database.prepare(`
    UPDATE assignment_action_results
    SET started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE operation_id = ? AND action = ? AND status = 'pending'
  `).run(Date.now(), Date.now(), operationId, action);
}

function failAction(database: Database.Database, operationId: string, action: FacebookAction, error: unknown) {
  const now = Date.now();
  database.prepare(`
    UPDATE assignment_action_results
    SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
    WHERE operation_id = ? AND action = ? AND status = 'pending'
  `).run(error instanceof Error ? error.message : String(error), now, now, operationId, action);
}

function saveCheckpoint(
  database: Database.Database,
  operationId: string,
  payload: FacebookExecutionPayload,
  action: FacebookAction,
) {
  return database.transaction(() => {
    const phase = `before_${action}`;
    const previous = database.prepare("SELECT id FROM checkpoints WHERE operation_id = ? AND phase = ? AND sequence = 1")
      .get(operationId, phase) as { id: string } | undefined;
    const checkpointId = previous?.id ?? randomUUID();
    if (!previous) {
      database.prepare(`
        INSERT INTO checkpoints (id, operation_id, assignment_id, phase, sequence, data_json, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(checkpointId, operationId, payload.assignmentId, phase, stableJson({
        action,
        expectedAccount: payload.expectedAccount,
        expectedTargetText: payload.expectedTargetText,
        postUrl: payload.postUrl,
        commentId: action === "comment" ? payload.comment?.id ?? null : null,
        commentVersion: action === "comment" ? payload.comment?.version ?? null : null,
      }), Date.now());
    }
    database.prepare(`
      UPDATE assignment_action_results SET checkpoint_id = ?, updated_at = ?
      WHERE operation_id = ? AND action = ?
    `).run(checkpointId, Date.now(), operationId, action);
    return checkpointId;
  }).immediate();
}

function armAction(database: Database.Database, operationId: string, owner: string, action: FacebookAction) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const job = database.prepare(`
      SELECT id, effect_phase, cancellation_requested_at FROM jobs
      WHERE operation_id = ? AND status = 'running' AND lock_owner = ?
    `).get(operationId, owner) as {
      id: string;
      effect_phase: string;
      cancellation_requested_at: number | null;
    } | undefined;
    if (!job) throw new Error("El job de ejecucion no pertenece al worker.");
    if (job.cancellation_requested_at !== null) throw new DOMException("Cancelacion solicitada", "AbortError");
    if (job.effect_phase !== "before_effect") throw new Error("La frontera de efecto anterior no fue resuelta.");
    const updated = database.prepare(`
      UPDATE assignment_action_results
      SET status = 'effect_possible', updated_at = ?
      WHERE operation_id = ? AND action = ? AND status = 'pending' AND checkpoint_id IS NOT NULL
    `).run(Date.now(), operationId, action);
    if (updated.changes !== 1) throw new Error("La accion no esta lista para cruzar la frontera de efecto.");
    const now = Date.now();
    database.prepare("UPDATE jobs SET effect_phase = 'effect_possible', updated_at = ? WHERE id = ?")
      .run(now, job.id);
    database.prepare("UPDATE operations SET effect_phase = 'effect_possible', updated_at = ? WHERE id = ?")
      .run(now, operationId);
  }).immediate();
}

function confirmAction(
  database: Database.Database,
  operationId: string,
  owner: string,
  action: FacebookAction,
  result: "already_active" | "activated" | "sent",
) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const current = actionStatus(database, operationId, action);
    if (!current) throw new Error("La accion no existe.");
    if (current.status === "confirmed") return;
    if (!['pending', 'effect_possible'].includes(current.status)) throw new Error("La accion no puede confirmarse.");
    const now = Date.now();
    database.prepare(`
      UPDATE assignment_action_results
      SET status = 'confirmed', result = ?, error = NULL, updated_at = ?, completed_at = ?
      WHERE operation_id = ? AND action = ?
    `).run(result, now, now, operationId, action);
    const pending = (database.prepare(`
      SELECT COUNT(*) AS total FROM assignment_action_results
      WHERE operation_id = ? AND status != 'confirmed'
    `).get(operationId) as { total: number }).total;
    const effectPhase = pending === 0 ? "effect_confirmed" : "before_effect";
    database.prepare("UPDATE jobs SET effect_phase = ?, updated_at = ? WHERE operation_id = ?")
      .run(effectPhase, now, operationId);
    database.prepare("UPDATE operations SET effect_phase = ?, updated_at = ? WHERE id = ?")
      .run(effectPhase, now, operationId);
  }).immediate();
}

function completeExecution(database: Database.Database, operationId: string, payload: FacebookExecutionPayload) {
  return database.transaction(() => {
    const pending = (database.prepare(`
      SELECT COUNT(*) AS total FROM assignment_action_results
      WHERE operation_id = ? AND status IN ('pending', 'effect_possible')
    `).get(operationId) as { total: number }).total;
    if (pending) throw new Error("No todas las acciones terminaron.");
    const failed = (database.prepare(`
      SELECT COUNT(*) AS total FROM assignment_action_results
      WHERE operation_id = ? AND status = 'failed'
    `).get(operationId) as { total: number }).total;
    const now = Date.now();
    const result = { assignmentId: payload.assignmentId, domainCommitted: true, failedActions: failed };
    database.prepare("UPDATE assignments SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
      .run(failed ? "failed" : "sent", now, now, payload.assignmentId);
    database.prepare("UPDATE operations SET result_json = ?, updated_at = ? WHERE id = ?")
      .run(stableJson(result), now, operationId);
    database.prepare("UPDATE jobs SET result_json = ?, updated_at = ? WHERE operation_id = ?")
      .run(stableJson(result), now, operationId);
    return reduceFacebookCampaignExecution(database, payload.campaignId, now);
  }).immediate();
}

function markExecutionFailure(
  database: Database.Database,
  operationId: string,
  owner: string,
  payload: FacebookExecutionPayload,
  error: unknown,
  signal?: AbortSignal,
) {
  database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const job = database.prepare(`
      SELECT status, lock_owner, cancellation_requested_at FROM jobs WHERE operation_id = ?
    `).get(operationId) as {
      status: string;
      lock_owner: string | null;
      cancellation_requested_at: number | null;
    } | undefined;
    if (!job || job.status !== "running" || job.lock_owner !== owner) return;
    const possible = database.prepare(`
      SELECT action FROM assignment_action_results
      WHERE operation_id = ? AND status = 'effect_possible' LIMIT 1
    `).get(operationId) as { action: FacebookAction } | undefined;
    const confirmed = (database.prepare(`
      SELECT COUNT(*) AS total FROM assignment_action_results
      WHERE operation_id = ? AND status = 'confirmed'
    `).get(operationId) as { total: number }).total;
    const total = (database.prepare(`
      SELECT COUNT(*) AS total FROM assignment_action_results WHERE operation_id = ?
    `).get(operationId) as { total: number }).total;
    const cancelled = signal?.aborted || job.cancellation_requested_at !== null;
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (possible) {
      database.prepare(`
        UPDATE assignment_action_results
        SET status = 'outcome_unknown', error = ?, updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND action = ? AND status = 'effect_possible'
      `).run(message, now, now, operationId, possible.action);
      database.prepare(`
        UPDATE assignment_action_results
        SET status = 'cancelled', error = 'No ejecutada porque otra accion quedo incierta.',
          updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND status = 'pending'
      `).run(now, now, operationId);
      database.prepare("UPDATE assignments SET status = 'outcome_unknown', updated_at = ?, completed_at = ? WHERE id = ?")
        .run(now, now, payload.assignmentId);
      database.prepare("UPDATE posts SET error = ?, updated_at = ? WHERE id = ?").run(message, now, payload.postId);
    } else if (confirmed === total && total > 0) {
      database.prepare("UPDATE assignments SET status = 'sent', updated_at = ?, completed_at = ? WHERE id = ?")
        .run(now, now, payload.assignmentId);
    } else {
      const assignmentStatus = cancelled && confirmed === 0 ? "cancelled" : "failed";
      database.prepare(`
        UPDATE assignment_action_results SET status = ?, error = ?, updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND status = 'pending'
      `).run(cancelled ? "cancelled" : "failed", message, now, now, operationId);
      database.prepare("UPDATE assignments SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(assignmentStatus, now, now, payload.assignmentId);
      database.prepare("UPDATE posts SET error = ?, updated_at = ? WHERE id = ?").run(message, now, payload.postId);
    }
    reduceFacebookCampaignExecution(database, payload.campaignId, now);
  }).immediate();
}

export async function executeFacebookAssignment(
  database: Database.Database,
  operationId: string,
  owner: string,
  dependencies: FacebookExecutionDependencies,
) {
  const { payload } = executionPayload(database, operationId);
  const persistedIdentity = database.prepare("SELECT account_label FROM facebook_device_identities WHERE device_id = ?")
    .get(payload.deviceId) as { account_label: string } | undefined;
  const controlledAccount = dependencies.controlledAccount
    ?? persistedIdentity?.account_label
    ?? appConfig.facebookControlledAccount;
  try {
    assertNotCancelled(database, operationId, dependencies.signal);
    assertExecutionContent(
      database,
      payload,
      controlledAccount,
      dependencies.controlledAccountResourceId ?? appConfig.facebookAccountResourceId,
      dependencies.postContainerResourceId ?? appConfig.facebookPostContainerResourceId,
      dependencies.postUrlResourceId ?? appConfig.facebookPostUrlResourceId,
      dependencies.commentComposerResourceId ?? appConfig.facebookCommentComposerResourceId,
      dependencies.commentEditorResourceId ?? appConfig.facebookCommentEditorResourceId,
      dependencies.commentSubmitResourceId ?? appConfig.facebookCommentSubmitResourceId,
      dependencies.commentResultContainerResourceId ?? appConfig.facebookCommentResultContainerResourceId,
    );
    beginExecution(database, payload);
    const mobile = dependencies.mobile ?? new AppiumFacebookMobileDriver(dependencies.adb, dependencies.appium, {
      composer: payload.expectedCommentComposerResourceId ?? "",
      editor: payload.expectedCommentEditorResourceId ?? "",
      submit: payload.expectedCommentSubmitResourceId ?? "",
      result: payload.expectedCommentResultContainerResourceId ?? "",
    });
    return await runOwnedDeviceAutomation(
      database,
      operationId,
      owner,
      {
        adb: dependencies.adb,
        appium: dependencies.appium,
        requiredPackage: FACEBOOK_APP_PACKAGE,
        cleanupPackage: FACEBOOK_APP_PACKAGE,
        artifactsPath: dependencies.artifactsPath,
        cleanupTimeoutMs: dependencies.cleanupTimeoutMs,
        signal: dependencies.signal,
        leaseSignal: dependencies.leaseSignal,
      },
      async (sessionId: string, inspection: AdbDeviceInspection) => {
        await mobile.openPost(sessionId, inspection.deviceId, payload.postUrl, dependencies.signal);
        assertNotCancelled(database, operationId, dependencies.signal);
        await mobile.verifyAccountAndPost(
          sessionId,
          payload.expectedAccount,
          payload.expectedAccountResourceId,
          payload.expectedPostContainerResourceId,
          payload.expectedPostUrlResourceId,
          payload.postUrl,
          payload.expectedTargetText,
          dependencies.signal,
          payload.contentKind ?? undefined,
        );

        const runAction = async (action: FacebookAction, execute: (signal: AbortSignal) => Promise<void>) => {
          if (actionStatus(database, operationId, action)?.status === "confirmed") return;
          const timeout = AbortSignal.timeout(appConfig.facebookActionTimeoutMs);
          const signal = dependencies.signal
            ? AbortSignal.any([dependencies.signal, timeout])
            : timeout;
          startAction(database, operationId, action);
          try {
            await execute(signal);
          } catch (error) {
            if (dependencies.signal?.aborted || dependencies.leaseSignal?.aborted || actionStatus(database, operationId, action)?.status === "effect_possible") {
              throw error;
            }
            failAction(database, operationId, action, error);
          }
        };

        if (payload.actions.like) await runAction("like", async (signal) => {
          assertNotCancelled(database, operationId, signal);
          if (await mobile.readLikeState(sessionId, signal)) {
            confirmAction(database, operationId, owner, "like", "already_active");
            return;
          }
          const likeElementId = await mobile.prepareLike(sessionId, signal);
          saveCheckpoint(database, operationId, payload, "like");
          assertNotCancelled(database, operationId, signal);
          armAction(database, operationId, owner, "like");
          await mobile.tapLike(sessionId, likeElementId, signal);
          if (!await mobile.readLikeState(sessionId, signal)) {
            throw new FacebookError("FACEBOOK_LIKE_NOT_CONFIRMED", "Facebook no confirmo el Like.", 422);
          }
          confirmAction(database, operationId, owner, "like", "activated");
        });

        const comment = payload.comment;
        if (payload.actions.comment && comment) await runAction("comment", async (signal) => {
          assertNotCancelled(database, operationId, signal);
          await mobile.openCommentComposer(sessionId, signal);
          await mobile.assertCommentAbsent(sessionId, comment.text, signal);
          await mobile.enterComment(sessionId, comment.text, signal);
          const observed = await mobile.readCommentDraft(sessionId, signal);
          if (observed !== comment.text) {
            throw new FacebookError("FACEBOOK_COMMENT_TEXT_MISMATCH", "El compositor no contiene el texto exacto.", 422);
          }
          const submitElementId = await mobile.prepareCommentSubmit(sessionId, signal);
          saveCheckpoint(database, operationId, payload, "comment");
          assertNotCancelled(database, operationId, signal);
          armAction(database, operationId, owner, "comment");
          await mobile.submitComment(sessionId, submitElementId, signal);
          await mobile.confirmCommentVisible(sessionId, comment.text, signal);
          confirmAction(database, operationId, owner, "comment", "sent");
        });

        if (payload.actions.share) await runAction("share", async (signal) => {
          assertNotCancelled(database, operationId, signal);
          const shareElementId = await mobile.prepareShare(sessionId, signal);
          await mobile.openShareMenu(sessionId, shareElementId, signal);
          const shareNowElementId = await mobile.prepareShareNow(sessionId, signal);
          saveCheckpoint(database, operationId, payload, "share");
          assertNotCancelled(database, operationId, signal);
          armAction(database, operationId, owner, "share");
          await mobile.submitShare(sessionId, shareNowElementId, signal);
          await mobile.confirmShare(sessionId, signal);
          confirmAction(database, operationId, owner, "share", "sent");
        });
        return completeExecution(database, operationId, payload);
      },
    );
  } catch (error) {
    const cancellation = database.prepare("SELECT cancellation_requested_at FROM jobs WHERE operation_id = ?")
      .get(operationId) as { cancellation_requested_at: number | null } | undefined;
    const interrupted = (dependencies.signal?.aborted || dependencies.leaseSignal?.aborted)
      && cancellation?.cancellation_requested_at === null;
    if (!interrupted) {
      try {
        markExecutionFailure(database, operationId, owner, payload, error, dependencies.signal);
      } catch {
        if (!(error instanceof CleanupUnknownError)) throw error;
      }
    }
    throw error;
  }
}

export function recoverFacebookExecutions(database: Database.Database, owner: string) {
  return database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    const rows = database.prepare(`
      SELECT j.status, j.operation_id, j.assignment_id, j.post_id, j.campaign_id, j.error,
        a.status AS assignment_status, o.cleanup_status
      FROM jobs j JOIN operations o ON o.id = j.operation_id
      JOIN assignments a ON a.id = j.assignment_id
      JOIN campaigns c ON c.id = j.campaign_id
      WHERE j.kind = 'assignment.execute' AND c.platform = 'facebook'
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
      assignment_status: string;
      cleanup_status: string;
    }>;
    let changed = 0;
    const changedCampaigns = new Set<string>();
    for (const row of rows) {
      if (row.status === "succeeded") {
        changedCampaigns.add(row.campaign_id);
        changed += 1;
        continue;
      }
      const actions = database.prepare(`
        SELECT status FROM assignment_action_results WHERE operation_id = ?
      `).all(row.operation_id) as Array<{ status: string }>;
      const hasPossible = actions.some((action) => action.status === "effect_possible");
      const hasPending = actions.some((action) => action.status === "pending");
      if (row.status === "pending") {
        if (["running", "cancellation_requested"].includes(row.assignment_status) && !hasPossible) {
          const now = Date.now();
          database.prepare(`
            UPDATE assignments SET status = 'scheduled', completed_at = NULL, updated_at = ? WHERE id = ?
          `).run(now, row.assignment_id);
          changedCampaigns.add(row.campaign_id);
          changed += 1;
        }
        continue;
      }
      if (!hasPossible && !hasPending && !["running", "cancellation_requested"].includes(row.assignment_status)) continue;
      const now = Date.now();
      const message = row.error ?? "Worker interrumpido";
      if (hasPossible) {
        database.prepare(`
          UPDATE assignment_action_results
          SET status = 'outcome_unknown', error = COALESCE(error, ?), updated_at = ?, completed_at = ?
          WHERE operation_id = ? AND status = 'effect_possible'
        `).run(message, now, now, row.operation_id);
        database.prepare(`
          UPDATE assignment_action_results
          SET status = ?, error = COALESCE(error, ?), updated_at = ?, completed_at = ?
          WHERE operation_id = ? AND status = 'pending'
        `).run(row.status === "cancelled" ? "cancelled" : "failed", message, now, now, row.operation_id);
        database.prepare("UPDATE assignments SET status = 'outcome_unknown', updated_at = ?, completed_at = ? WHERE id = ?")
          .run(now, now, row.assignment_id);
        database.prepare("UPDATE posts SET error = ?, updated_at = ? WHERE id = ?").run(message, now, row.post_id);
      } else if (actions.length > 0 && actions.every((action) => action.status === "confirmed")) {
        database.prepare("UPDATE assignments SET status = 'sent', updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
          .run(now, now, row.assignment_id);
      } else {
        const status = row.status === "cancelled" ? "cancelled" : "failed";
        database.prepare(`
          UPDATE assignment_action_results
          SET status = ?, error = COALESCE(error, ?), updated_at = ?, completed_at = ?
          WHERE operation_id = ? AND status = 'pending'
        `).run(status, message, now, now, row.operation_id);
        database.prepare("UPDATE assignments SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
          .run(status, now, now, row.assignment_id);
        database.prepare("UPDATE posts SET error = ?, updated_at = ? WHERE id = ?").run(message, now, row.post_id);
      }
      changedCampaigns.add(row.campaign_id);
      changed += 1;
    }
    for (const campaignId of changedCampaigns) reduceFacebookCampaignExecution(database, campaignId);
    return changed;
  }).immediate();
}
