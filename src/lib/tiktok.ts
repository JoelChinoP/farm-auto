import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import { appConfig } from "./config.ts";
import { CURRENT_SETUP_REVISION } from "./device-runtime.ts";
import { completeOperation, createOperation, getOperation, IdempotencyConflictError, stableJson } from "./operations.ts";
import { enqueueJob, getJob, requestJobCancellation } from "./queue.ts";

export const TIKTOK_APP_PACKAGE = "com.zhiliaoapp.musically";
export const TIKTOK_TONES = ["Cercano", "Entusiasta", "Informativo", "Breve"] as const;

export class TikTokError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TikTokError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type TikTokConfig = {
  controlledAccount: string;
  accountResourceId: string;
  postContainerResourceId: string;
  postUrlResourceId: string;
  commentComposerResourceId: string;
  commentEditorResourceId: string;
  commentSubmitResourceId: string;
  commentResultContainerResourceId: string;
  liveContainerResourceId: string;
  liveUrlResourceId: string;
  likeActiveLabels: string[];
  likeInactiveLabels: string[];
  commentLabels: string[];
  uiTimeoutMs: number;
  publicEffectsEnabled: boolean;
  liveEffectsEnabled: boolean;
  liveCalibration: null | { deviceId: string; x: number; y: number };
};

function envPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const value = Number(env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new TikTokError("TIKTOK_CONFIG_INVALID", `${name} debe ser un entero positivo.`, 503);
  return value;
}

function envLabels(env: NodeJS.ProcessEnv, name: string, fallback: string) {
  const values = (env[name]?.trim() || fallback).split("|").map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new TikTokError("TIKTOK_CONFIG_INVALID", `${name} debe contener al menos una etiqueta.`, 503);
  return values;
}

export function readTikTokConfig(env: NodeJS.ProcessEnv = process.env): TikTokConfig {
  const calibrationValues = [
    env.TIKTOK_LIVE_CALIBRATED_DEVICE_ID?.trim() || "",
    env.TIKTOK_LIVE_CALIBRATED_X?.trim() || "",
    env.TIKTOK_LIVE_CALIBRATED_Y?.trim() || "",
  ];
  if (calibrationValues.some(Boolean) && !calibrationValues.every(Boolean)) {
    throw new TikTokError("TIKTOK_CONFIG_INVALID", "La calibracion Live requiere dispositivo, X e Y.", 503);
  }
  const liveCalibration = calibrationValues.every(Boolean)
    ? { deviceId: calibrationValues[0], x: Number(calibrationValues[1]), y: Number(calibrationValues[2]) }
    : null;
  if (liveCalibration && (!Number.isInteger(liveCalibration.x) || liveCalibration.x < 0 || liveCalibration.x > 5_000
    || !Number.isInteger(liveCalibration.y) || liveCalibration.y < 0 || liveCalibration.y > 5_000)) {
    throw new TikTokError("TIKTOK_CONFIG_INVALID", "La calibracion Live X/Y debe usar enteros entre 0 y 5000.", 503);
  }
  return {
    controlledAccount: env.TIKTOK_CONTROLLED_ACCOUNT?.trim() || "",
    accountResourceId: env.TIKTOK_ACCOUNT_RESOURCE_ID?.trim() || "",
    postContainerResourceId: env.TIKTOK_POST_CONTAINER_RESOURCE_ID?.trim() || "",
    postUrlResourceId: env.TIKTOK_POST_URL_RESOURCE_ID?.trim() || "",
    commentComposerResourceId: env.TIKTOK_COMMENT_COMPOSER_RESOURCE_ID?.trim() || "",
    commentEditorResourceId: env.TIKTOK_COMMENT_EDITOR_RESOURCE_ID?.trim() || "",
    commentSubmitResourceId: env.TIKTOK_COMMENT_SUBMIT_RESOURCE_ID?.trim() || "",
    commentResultContainerResourceId: env.TIKTOK_COMMENT_RESULT_CONTAINER_RESOURCE_ID?.trim() || "",
    liveContainerResourceId: env.TIKTOK_LIVE_CONTAINER_RESOURCE_ID?.trim() || "",
    liveUrlResourceId: env.TIKTOK_LIVE_URL_RESOURCE_ID?.trim() || "",
    likeActiveLabels: envLabels(env, "TIKTOK_LIKE_ACTIVE_LABELS", "Unlike|Remove like|Quitar Me gusta"),
    likeInactiveLabels: envLabels(env, "TIKTOK_LIKE_INACTIVE_LABELS", "Like|Me gusta"),
    commentLabels: envLabels(env, "TIKTOK_COMMENT_LABELS", "Comments|Comment|Comentarios|Comentar"),
    uiTimeoutMs: envPositiveInteger(env, "TIKTOK_UI_TIMEOUT_MS", 15_000),
    publicEffectsEnabled: env.TIKTOK_PUBLIC_EFFECTS_ENABLED === "true",
    liveEffectsEnabled: env.TIKTOK_LIVE_EFFECTS_ENABLED === "true",
    liveCalibration,
  };
}

export type TikTokCampaignRequest = {
  platform: "tiktok";
  urls: string[];
  deviceIds: string[];
  actions: { like: boolean; comment: boolean };
  distribution: Array<{ intention: string; tone: (typeof TIKTOK_TONES)[number]; count: number }>;
};

export type TikTokPostExecutionPayload = {
  mode: "post";
  assignmentId: string;
  campaignId: string;
  postId: string;
  deviceId: string;
  expectedRevision: number;
  expectedAccount: string;
  expectedAccountResourceId: string;
  expectedPostContainerResourceId: string;
  expectedPostUrlResourceId: string;
  expectedLikeActiveLabels: string[];
  expectedLikeInactiveLabels: string[];
  expectedCommentLabels: string[];
  expectedCommentComposerResourceId: string | null;
  expectedCommentEditorResourceId: string | null;
  expectedCommentSubmitResourceId: string | null;
  expectedCommentResultContainerResourceId: string | null;
  expectedTargetText: string;
  postUrl: string;
  contextHash: string | null;
  actions: { like: boolean; comment: boolean };
  comment: null | { id: string; version: number; text: string; textHash: string };
  authorization: {
    publicEffects: true;
    controlledAccount: true;
    controlledContent: true;
    environmentGate: "TIKTOK_PUBLIC_EFFECTS_ENABLED";
  };
};

export type TikTokLiveRequest = {
  deviceId: string;
  url: string;
  rounds: number;
  x: number;
  y: number;
  expectedAccount: string;
  expectedTargetText: string;
  idempotencyKey: string;
  confirmed: true;
  controlledAccount: true;
  controlledContent: true;
  tapTapConfirmed: true;
};

export type TikTokLiveExecutionPayload = {
  mode: "live";
  assignmentId: string;
  campaignId: string;
  postId: string;
  deviceId: string;
  expectedRevision: number;
  expectedAccount: string;
  expectedAccountResourceId: string;
  expectedLiveContainerResourceId: string;
  expectedLiveUrlResourceId: string;
  expectedTargetText: string;
  liveUrl: string;
  rounds: number;
  x: number;
  y: number;
  authorization: {
    publicEffects: true;
    controlledAccount: true;
    controlledContent: true;
    calibratedCoordinates: true;
    calibration: { deviceId: string; x: number; y: number };
    environmentGate: "TIKTOK_LIVE_EFFECTS_ENABLED";
  };
};

export type TikTokExecutionPayload = TikTokPostExecutionPayload | TikTokLiveExecutionPayload;
export type TikTokDeepSeekFetch = typeof fetch;

function objectValue(value: unknown, message = "El payload debe ser un objeto JSON.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TikTokError("INVALID_REQUEST", message);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string, maxLength: number) {
  if (typeof value !== "string") throw new TikTokError("INVALID_REQUEST", `${name} es obligatorio.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TikTokError("INVALID_REQUEST", `${name} no es valido.`);
  }
  return normalized;
}

function requiredConfig(value: string, name: string) {
  return nonEmptyString(value, name, 300);
}

export function normalizeTikTokUrl(value: string) {
  if (typeof value !== "string" || !value || value.length > 2_048 || /["'\u0000-\u001f\u007f]/u.test(value)) {
    throw new TikTokError("INVALID_TIKTOK_URL", "El enlace contiene caracteres no permitidos.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TikTokError("INVALID_TIKTOK_URL", "El enlace de TikTok no es valido.");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new TikTokError("INVALID_TIKTOK_URL", "El enlace debe usar HTTPS sin credenciales ni puertos no estandar.");
  }
  if (hostname !== "tiktok.com" && !hostname.endsWith(".tiktok.com")) {
    throw new TikTokError("INVALID_TIKTOK_URL", "El dominio no pertenece a TikTok.");
  }
  url.hash = "";
  const sourceUrl = url.toString();
  const normalized = new URL(sourceUrl);
  for (const parameter of ["_r", "_t", "is_from_webapp", "sender_device", "utm_campaign", "utm_medium", "utm_source", "web_id"]) {
    normalized.searchParams.delete(parameter);
  }
  normalized.searchParams.sort();
  if (normalized.pathname.length > 1) normalized.pathname = normalized.pathname.replace(/\/+$/u, "");
  return { sourceUrl, normalizedUrl: normalized.toString() };
}

export function normalizeTikTokLiveUrl(value: string) {
  const normalized = normalizeTikTokUrl(value);
  const url = new URL(normalized.normalizedUrl);
  if (!/^\/@[^/]+\/live$/u.test(url.pathname)) {
    throw new TikTokError("INVALID_TIKTOK_LIVE_URL", "El enlace debe identificar un Live de TikTok con /@usuario/live.");
  }
  return normalized;
}

export function validateTikTokCampaignRequest(value: unknown): TikTokCampaignRequest {
  const input = objectValue(value);
  if (!Array.isArray(input.urls) || input.urls.length !== 1 || typeof input.urls[0] !== "string") {
    throw new TikTokError("TIKTOK_REQUIRES_1X1", "TikTok post requiere exactamente una publicacion.");
  }
  if (!Array.isArray(input.deviceIds) || input.deviceIds.length !== 1) {
    throw new TikTokError("TIKTOK_REQUIRES_1X1", "TikTok post requiere exactamente un dispositivo.");
  }
  const deviceId = nonEmptyString(input.deviceIds[0], "deviceIds[0]", 120);
  const normalizedUrl = normalizeTikTokUrl(input.urls[0]);
  if (/^\/@[^/]+\/live$/u.test(new URL(normalizedUrl.normalizedUrl).pathname)) {
    throw new TikTokError("INVALID_TIKTOK_POST_URL", "TikTok post no admite una URL Live.");
  }
  const url = normalizedUrl.sourceUrl;
  const rawActions = objectValue(input.actions, "actions es obligatorio.");
  if (typeof rawActions.like !== "boolean" || typeof rawActions.comment !== "boolean" || (!rawActions.like && !rawActions.comment)) {
    throw new TikTokError("INVALID_ACTIONS", "Selecciona Like, Comentario o ambos.");
  }
  const actions = { like: rawActions.like, comment: rawActions.comment };
  if (!actions.comment) return { platform: "tiktok", urls: [url], deviceIds: [deviceId], actions, distribution: [] };
  if (!Array.isArray(input.distribution) || input.distribution.length !== 1) {
    throw new TikTokError("INVALID_DISTRIBUTION", "TikTok 1x1 requiere una unica configuracion de comentario.");
  }
  const row = objectValue(input.distribution[0], "distribution[0] no es valida.");
  const intention = nonEmptyString(row.intention, "distribution[0].intention", 300);
  if (typeof row.tone !== "string" || !TIKTOK_TONES.includes(row.tone as (typeof TIKTOK_TONES)[number]) || row.count !== 1) {
    throw new TikTokError("INVALID_DISTRIBUTION", "La distribucion debe usar un tono valido y cantidad 1.");
  }
  return {
    platform: "tiktok",
    urls: [url],
    deviceIds: [deviceId],
    actions,
    distribution: [{ intention, tone: row.tone as (typeof TIKTOK_TONES)[number], count: 1 }],
  };
}

export function validateTikTokLiveRequest(value: unknown): TikTokLiveRequest {
  const input = objectValue(value);
  const integer = (name: "rounds" | "x" | "y", minimum: number, maximum: number) => {
    if (!Number.isInteger(input[name]) || Number(input[name]) < minimum || Number(input[name]) > maximum) {
      throw new TikTokError("INVALID_TIKTOK_LIVE_RANGE", `${name} debe ser un entero entre ${minimum} y ${maximum}.`);
    }
    return Number(input[name]);
  };
  if (input.confirmed !== true || input.controlledAccount !== true || input.controlledContent !== true || input.tapTapConfirmed !== true) {
    throw new TikTokError("EXPLICIT_CONFIRMATION_REQUIRED", "Confirma la cuenta, el Live, las coordenadas y los efectos publicos.", 409);
  }
  const expectedTargetText = nonEmptyString(input.expectedTargetText, "expectedTargetText", 500);
  if (expectedTargetText.length < 5) throw new TikTokError("TARGET_TEXT_INVALID", "La referencia visible debe tener al menos 5 caracteres.");
  return {
    deviceId: nonEmptyString(input.deviceId, "deviceId", 120),
    url: normalizeTikTokLiveUrl(nonEmptyString(input.url, "url", 2_048)).sourceUrl,
    rounds: integer("rounds", 1, 50),
    x: integer("x", 0, 5_000),
    y: integer("y", 0, 5_000),
    expectedAccount: nonEmptyString(input.expectedAccount, "expectedAccount", 300),
    expectedTargetText,
    idempotencyKey: nonEmptyString(input.idempotencyKey, "idempotencyKey", 100),
    confirmed: true,
    controlledAccount: true,
    controlledContent: true,
    tapTapConfirmed: true,
  };
}

export function assertTikTokDeviceEligible(database: Database.Database, deviceId: string, options: { allowBusy?: boolean } = {}) {
  const row = database.prepare(`
    SELECT p.hardware_id, o.connection, o.hardware_id AS observed_hardware_id,
      o.packages_json, pr.status AS preparation_status, r.status AS retirement_status,
      CASE WHEN l.device_id IS NULL THEN 0 ELSE 1 END AS busy
    FROM device_profiles p
    LEFT JOIN device_observations o ON o.device_id = p.device_id
    LEFT JOIN device_locks l ON l.device_id = p.device_id
    LEFT JOIN device_retirements r ON r.device_id = p.device_id
    LEFT JOIN device_preparations pr ON pr.id = (
      SELECT id FROM device_preparations
      WHERE device_id = p.device_id AND setup_revision = ?
      ORDER BY updated_at DESC LIMIT 1
    )
    WHERE p.device_id = ?
  `).get(CURRENT_SETUP_REVISION, deviceId) as {
    hardware_id: string;
    connection: string | null;
    observed_hardware_id: string | null;
    packages_json: string | null;
    preparation_status: string | null;
    retirement_status: string | null;
    busy: 0 | 1;
  } | undefined;
  if (!row) throw new TikTokError("DEVICE_NOT_ALLOWLISTED", `El dispositivo ${deviceId} no esta registrado.`, 409);
  if (row.retirement_status) throw new TikTokError("DEVICE_RETIRED", `El dispositivo ${deviceId} esta retirado o pendiente de retiro.`, 409);
  if (row.connection !== "connected") throw new TikTokError("DEVICE_NOT_CONNECTED", `El dispositivo ${deviceId} no esta conectado.`, 409);
  if (row.hardware_id !== row.observed_hardware_id) throw new TikTokError("DEVICE_IDENTITY_MISMATCH", `No se pudo confirmar la identidad de ${deviceId}.`, 409);
  if (row.preparation_status !== "ready") throw new TikTokError("DEVICE_NOT_READY", `El dispositivo ${deviceId} no esta preparado.`, 409);
  if (row.busy && !options.allowBusy) throw new TikTokError("DEVICE_BUSY", `El dispositivo ${deviceId} no esta disponible.`, 409);
  const packages = row.packages_json ? JSON.parse(row.packages_json) as unknown : [];
  if (!Array.isArray(packages) || !packages.includes(TIKTOK_APP_PACKAGE)) {
    throw new TikTokError("TIKTOK_NOT_INSTALLED", `TikTok no esta instalado en ${deviceId}.`, 409);
  }
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function touchCampaign(database: Database.Database, campaignId: string, now = Date.now()) {
  database.prepare("UPDATE campaigns SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, campaignId);
}

function assertOperationNotCancelled(database: Database.Database, operationId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const row = database.prepare(`
    SELECT o.status, j.cancellation_requested_at
    FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id WHERE o.id = ?
  `).get(operationId) as { status: string; cancellation_requested_at: number | null } | undefined;
  if (row?.status === "cancelled" || row?.cancellation_requested_at != null) {
    throw new DOMException("Cancelacion solicitada", "AbortError");
  }
}

function currentComment(database: Database.Database, assignmentId: string) {
  return database.prepare(`
    SELECT id, version, intention, tone, text, status, stale, source, error
    FROM comments WHERE assignment_id = ? AND version = (
      SELECT MAX(version) FROM comments WHERE assignment_id = ?
    )
  `).get(assignmentId, assignmentId) as {
    id: string;
    version: number;
    intention: string;
    tone: string;
    text: string;
    status: string;
    stale: 0 | 1;
    source: "generated" | "manual";
    error: string | null;
  } | undefined;
}

export function createTikTokCampaign(database: Database.Database, operationId: string, request: TikTokCampaignRequest) {
  const input = validateTikTokCampaignRequest(request);
  assertOperationNotCancelled(database, operationId);
  return database.transaction(() => {
    const operation = getOperation(database, operationId);
    if (!operation || operation.kind !== "campaign.create") throw new Error("La operacion de campana TikTok no existe.");
    if (operation.campaignId) return getTikTokCampaignSnapshot(database, operation.campaignId);
    assertTikTokDeviceEligible(database, input.deviceIds[0]);
    const campaignId = randomUUID();
    const postId = randomUUID();
    const assignmentId = randomUUID();
    const now = Date.now();
    const { sourceUrl, normalizedUrl } = normalizeTikTokUrl(input.urls[0]);
    database.prepare(`
      INSERT INTO campaigns (id, platform, status, like_enabled, comment_enabled, created_at, updated_at)
      VALUES (?, 'tiktok', ?, ?, ?, ?, ?)
    `).run(campaignId, input.actions.comment ? "preparing" : "ready", Number(input.actions.like), Number(input.actions.comment), now, now);
    database.prepare(`
      INSERT INTO posts (
        id, campaign_id, position, source_url, normalized_url, status,
        context_status, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(postId, campaignId, sourceUrl, normalizedUrl, input.actions.comment ? "queued" : "ready", input.actions.comment ? "queued" : "ready", now, now);
    database.prepare(`
      INSERT INTO assignments (id, campaign_id, post_id, device_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(assignmentId, campaignId, postId, input.deviceIds[0], input.actions.comment ? "pending" : "approved", now, now);
    if (input.actions.comment) {
      const profile = input.distribution[0];
      database.prepare(`
        INSERT INTO comments (
          id, assignment_id, version, intention, tone, text, status, source, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, '', 'pending', 'generated', ?, ?)
      `).run(randomUUID(), assignmentId, profile.intention, profile.tone, now, now);
    }
    const result = stableJson({ domainCommitted: true });
    database.prepare("UPDATE operations SET campaign_id = ?, result_json = ?, updated_at = ? WHERE id = ?")
      .run(campaignId, result, now, operationId);
    database.prepare("UPDATE jobs SET campaign_id = ?, result_json = ?, updated_at = ? WHERE operation_id = ?")
      .run(campaignId, result, now, operationId);
    return getTikTokCampaignSnapshot(database, campaignId);
  }).immediate();
}

function assertPostEditable(database: Database.Database, postId: string) {
  const blocked = database.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM operations WHERE post_id = ? AND kind = 'assignment.execute'
        AND status IN ('pending', 'running')
    ) AS active,
    EXISTS(
      SELECT 1 FROM assignments WHERE post_id = ?
        AND status IN ('running', 'sent', 'outcome_unknown', 'cancellation_requested')
    ) AS finalized
  `).get(postId, postId) as { active: 0 | 1; finalized: 0 | 1 };
  if (blocked.active || blocked.finalized) {
    throw new TikTokError("EXECUTION_LOCKED", "El contenido no puede cambiar durante o despues de una accion publica.", 409);
  }
}

export function editTikTokPostContext(database: Database.Database, campaignId: string, postId: string, value: unknown) {
  const context = nonEmptyString(value, "context", 1_200);
  if (context.length < 5) throw new TikTokError("CONTEXT_INVALID", "El contexto manual debe tener entre 5 y 1200 caracteres.");
  return database.transaction(() => {
    assertPostEditable(database, postId);
    const post = database.prepare(`
      SELECT p.context, p.context_hash FROM posts p JOIN campaigns c ON c.id = p.campaign_id
      WHERE p.id = ? AND p.campaign_id = ? AND c.platform = 'tiktok'
    `).get(postId, campaignId) as { context: string | null; context_hash: string | null } | undefined;
    if (!post) throw new TikTokError("POST_NOT_FOUND", "La publicacion TikTok no existe.", 404);
    const contextHash = hashText(context);
    if (post.context === context && post.context_hash === contextHash) return getTikTokCampaignSnapshot(database, campaignId)!;
    const version = (database.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM post_context_versions WHERE post_id = ?")
      .get(postId) as { version: number }).version;
    const now = Date.now();
    const generationJobs = database.prepare(`
      SELECT j.id FROM jobs j JOIN operations o ON o.id = j.operation_id
      WHERE o.post_id = ? AND o.kind = 'comments.generate' AND j.status IN ('pending', 'running')
    `).all(postId) as Array<{ id: string }>;
    for (const job of generationJobs) requestJobCancellation(database, job.id, now);
    database.prepare(`
      INSERT INTO post_context_versions (id, post_id, version, context, context_hash, source, created_at)
      VALUES (?, ?, ?, ?, ?, 'manual', ?)
    `).run(randomUUID(), postId, version, context, contextHash, now);
    database.prepare(`
      UPDATE posts SET context = ?, context_hash = ?, context_source = 'manual',
        context_status = 'edited', context_version = ?, status = 'context_ready', error = NULL, updated_at = ?
      WHERE id = ?
    `).run(context, contextHash, version, now, postId);
    database.prepare(`
      UPDATE comments SET stale = CASE WHEN length(text) > 0 THEN 1 ELSE stale END,
        status = CASE WHEN status IN ('generating', 'regenerating') THEN 'failed' ELSE status END,
        error = CASE WHEN status IN ('generating', 'regenerating') THEN 'El contexto cambio durante la generacion.' ELSE error END,
        updated_at = ?
      WHERE assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
    `).run(now, postId);
    database.prepare("UPDATE assignments SET status = CASE WHEN status = 'generating' THEN 'pending' ELSE status END, updated_at = ? WHERE post_id = ?")
      .run(now, postId);
    database.prepare("UPDATE campaigns SET status = 'preparing' WHERE id = ?").run(campaignId);
    touchCampaign(database, campaignId, now);
    return getTikTokCampaignSnapshot(database, campaignId)!;
  }).immediate();
}

export function requestTikTokCommentGeneration(
  database: Database.Database,
  input: { postId: string; idempotencyKey: string; overwriteManual?: boolean },
) {
  return database.transaction(() => {
    const post = database.prepare(`
      SELECT p.id, p.campaign_id, p.context, p.context_status, c.comment_enabled
      FROM posts p JOIN campaigns c ON c.id = p.campaign_id
      WHERE p.id = ? AND c.platform = 'tiktok'
    `).get(input.postId) as {
      id: string;
      campaign_id: string;
      context: string | null;
      context_status: string;
      comment_enabled: 0 | 1;
    } | undefined;
    if (!post) throw new TikTokError("POST_NOT_FOUND", "La publicacion TikTok no existe.", 404);
    if (!post.comment_enabled) throw new TikTokError("COMMENTS_DISABLED", "La campana no requiere comentarios.", 409);
    if (!post.context?.trim() || post.context_status !== "edited") {
      throw new TikTokError("MANUAL_CONTEXT_REQUIRED", "Guarda contexto manual antes de generar el comentario.", 409);
    }
    const assignment = database.prepare("SELECT id FROM assignments WHERE post_id = ?").get(post.id) as { id: string };
    const comment = currentComment(database, assignment.id);
    if (!input.overwriteManual && (comment?.source === "manual" || comment?.status === "edited")) {
      throw new TikTokError("MANUAL_COMMENT_PRESENT", "Confirma antes de sobrescribir el comentario editado manualmente.", 409);
    }
    const created = createOperation(database, {
      kind: "comments.generate",
      idempotencyKey: input.idempotencyKey,
      request: { postId: post.id, overwriteManual: input.overwriteManual === true },
      campaignId: post.campaign_id,
      postId: post.id,
    });
    if (created.replayed) {
      const previousJob = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(created.operation.id) as { id: string } | undefined;
      if (!previousJob) throw new Error("La operacion idempotente no conserva su job.");
      return { operation: created.operation, job: getJob(database, previousJob.id)!, replayed: true };
    }
    const active = database.prepare(`
      SELECT 1 FROM operations WHERE post_id = ? AND kind = 'comments.generate'
        AND status IN ('pending', 'running') AND id != ?
    `).get(post.id, created.operation.id);
    if (active) throw new TikTokError("OPERATION_IN_PROGRESS", "Ya existe una generacion activa para esta publicacion.", 409);
    const job = enqueueJob(database, "comments.generate", created.operation.request, {
      campaignId: post.campaign_id,
      postId: post.id,
      operationId: created.operation.id,
      maxAttempts: 2,
    });
    return { operation: created.operation, job, replayed: false };
  }).immediate();
}

export function parseGeneratedTikTokComment(content: string, assignmentId: string, minWords: number, maxWords: number) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
  } catch {
    throw new TikTokError("INVALID_MODEL_RESPONSE", "DeepSeek devolvio JSON invalido.", 502);
  }
  const root = objectValue(parsed, "DeepSeek devolvio una respuesta invalida.");
  if (Object.keys(root).length !== 1 || !Array.isArray(root.comments) || root.comments.length !== 1) {
    throw new TikTokError("INVALID_MODEL_RESPONSE", "DeepSeek debe devolver exactamente un comentario.", 502);
  }
  const row = objectValue(root.comments[0], "DeepSeek devolvio un comentario invalido.");
  if (Object.keys(row).length !== 2 || row.assignmentId !== assignmentId || typeof row.text !== "string") {
    throw new TikTokError("INVALID_MODEL_RESPONSE", "El comentario no identifica la asignacion esperada.", 502);
  }
  const text = row.text.trim();
  const words = text.split(/\s+/u).filter(Boolean).length;
  if (text.length < 2 || text.length > 500 || words < minWords || words > maxWords) {
    throw new TikTokError("INVALID_MODEL_RESPONSE", "El comentario esta fuera del contrato esperado.", 502);
  }
  return { assignmentId, text };
}

export async function generateTikTokComment(
  database: Database.Database,
  operationId: string,
  fetcher: TikTokDeepSeekFetch = fetch,
  signal?: AbortSignal,
  apiKey = appConfig.deepSeekApiKey,
) {
  const operation = getOperation(database, operationId);
  if (!operation?.postId || !operation.campaignId || operation.kind !== "comments.generate") {
    throw new Error("La operacion de generacion TikTok no es valida.");
  }
  if ((operation.result as { domainCommitted?: unknown } | null)?.domainCommitted === true) {
    return getTikTokCampaignSnapshot(database, operation.campaignId)!;
  }
  const post = database.prepare("SELECT context, context_hash, context_status FROM posts WHERE id = ?")
    .get(operation.postId) as { context: string | null; context_hash: string | null; context_status: string } | undefined;
  if (!post?.context || !post.context_hash || post.context_status !== "edited") {
    throw new TikTokError("MANUAL_CONTEXT_REQUIRED", "La generacion requiere contexto manual vigente.", 409);
  }
  const assignment = database.prepare("SELECT id FROM assignments WHERE post_id = ?").get(operation.postId) as { id: string } | undefined;
  if (!assignment) throw new TikTokError("ASSIGNMENT_NOT_FOUND", "La asignacion TikTok no existe.", 404);
  const previous = currentComment(database, assignment.id);
  if (!previous) throw new TikTokError("COMMENT_NOT_FOUND", "El comentario TikTok no existe.", 404);
  const request = objectValue(operation.request);
  if (!request.overwriteManual && (previous.source === "manual" || previous.status === "edited")) {
    throw new TikTokError("MANUAL_COMMENT_PRESENT", "Confirma antes de sobrescribir el comentario manual.", 409);
  }
  if (!apiKey) throw new TikTokError("DEEPSEEK_NOT_CONFIGURED", "Falta API_DEEPSEEK en el servidor.", 503);
  const startedAt = Date.now();
  database.transaction(() => {
    database.prepare("UPDATE posts SET status = 'generating', error = NULL, updated_at = ? WHERE id = ?").run(startedAt, operation.postId);
    database.prepare("UPDATE assignments SET status = 'generating', updated_at = ? WHERE id = ?").run(startedAt, assignment.id);
    database.prepare("UPDATE comments SET status = 'generating', error = NULL, updated_at = ? WHERE id = ?").run(startedAt, previous.id);
    touchCampaign(database, operation.campaignId!, startedAt);
  })();
  try {
    const timeout = AbortSignal.timeout(appConfig.deepSeekTimeoutMs);
    const response = await fetcher("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: appConfig.deepSeekModel,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `${appConfig.commentGenerationPrompt}\nDevuelve solo {"comments":[{"assignmentId":"...","text":"..."}]}. Genera exactamente un comentario de ${appConfig.commentMinWords} a ${appConfig.commentMaxWords} palabras y 2..500 caracteres.`,
          },
          { role: "user", content: JSON.stringify({ context: post.context, assignment: { id: assignment.id, intention: previous.intention, tone: previous.tone } }) },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new TikTokError(
        response.status === 401 ? "DEEPSEEK_AUTH_FAILED" : "DEEPSEEK_ERROR",
        response.status === 401 ? "DeepSeek rechazo API_DEEPSEEK." : `DeepSeek respondio HTTP ${response.status}.`,
        response.status === 401 ? 503 : 502,
      );
    }
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new TikTokError("EMPTY_MODEL_RESPONSE", "DeepSeek no devolvio un comentario.", 502);
    const generated = parseGeneratedTikTokComment(content, assignment.id, appConfig.commentMinWords, appConfig.commentMaxWords);
    assertOperationNotCancelled(database, operationId, signal);
    database.transaction(() => {
      const currentHash = (database.prepare("SELECT context_hash FROM posts WHERE id = ?").get(operation.postId) as { context_hash: string | null }).context_hash;
      if (currentHash !== post.context_hash) throw new TikTokError("CONTEXT_CHANGED", "El contexto cambio durante la generacion.", 409);
      const now = Date.now();
      database.prepare(`
        INSERT INTO comments (
          id, assignment_id, version, intention, tone, text, status, stale, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 0, 'generated', ?, ?)
      `).run(randomUUID(), assignment.id, previous.version + 1, previous.intention, previous.tone, generated.text, now, now);
      database.prepare("UPDATE assignments SET status = 'draft', updated_at = ? WHERE id = ?").run(now, assignment.id);
      database.prepare("UPDATE posts SET status = 'ready', error = NULL, updated_at = ? WHERE id = ?").run(now, operation.postId);
      database.prepare("UPDATE campaigns SET status = 'ready' WHERE id = ?").run(operation.campaignId);
      const result = stableJson({ domainCommitted: true });
      database.prepare("UPDATE operations SET result_json = ?, updated_at = ? WHERE id = ?").run(result, now, operationId);
      database.prepare("UPDATE jobs SET result_json = ?, updated_at = ? WHERE operation_id = ?").run(result, now, operationId);
      touchCampaign(database, operation.campaignId!, now);
    }).immediate();
    return getTikTokCampaignSnapshot(database, operation.campaignId)!;
  } catch (error) {
    const now = Date.now();
    database.transaction(() => {
      const current = database.prepare("SELECT context_hash, status FROM posts WHERE id = ?").get(operation.postId) as { context_hash: string | null; status: string };
      if (current.context_hash !== post.context_hash || current.status !== "generating") return;
      const cancelled = signal?.aborted || (database.prepare("SELECT cancellation_requested_at FROM jobs WHERE operation_id = ?")
        .get(operationId) as { cancellation_requested_at: number | null } | undefined)?.cancellation_requested_at != null;
      const message = error instanceof Error ? error.message : String(error);
      database.prepare("UPDATE posts SET status = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(cancelled ? "context_ready" : "partial_failed", message, now, operation.postId);
      database.prepare("UPDATE assignments SET status = ?, updated_at = ? WHERE id = ?")
        .run(cancelled ? "pending" : "failed", now, assignment.id);
      database.prepare("UPDATE comments SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run(message, now, previous.id);
      touchCampaign(database, operation.campaignId!, now);
    })();
    throw error;
  }
}

export function editTikTokComment(
  database: Database.Database,
  commentId: string,
  value: { text: unknown; intention: unknown; tone: unknown },
) {
  const text = nonEmptyString(value.text, "text", 500);
  if (text.length < 2) throw new TikTokError("COMMENT_INVALID", "El comentario debe tener entre 2 y 500 caracteres.");
  const intention = nonEmptyString(value.intention, "intention", 300);
  if (typeof value.tone !== "string" || !TIKTOK_TONES.includes(value.tone as (typeof TIKTOK_TONES)[number])) {
    throw new TikTokError("COMMENT_INVALID", "El tono no es valido.");
  }
  return database.transaction(() => {
    const current = database.prepare(`
      SELECT c.*, a.post_id, a.campaign_id FROM comments requested
      JOIN comments c ON c.assignment_id = requested.assignment_id
      JOIN assignments a ON a.id = c.assignment_id
      JOIN campaigns campaign ON campaign.id = a.campaign_id
      WHERE requested.id = ? AND campaign.platform = 'tiktok'
        AND c.version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = c.assignment_id)
    `).get(commentId) as {
      assignment_id: string;
      version: number;
      text: string;
      intention: string;
      tone: string;
      post_id: string;
      campaign_id: string;
    } | undefined;
    if (!current) throw new TikTokError("COMMENT_NOT_FOUND", "El comentario TikTok no existe.", 404);
    assertPostEditable(database, current.post_id);
    if (current.text === text && current.intention === intention && current.tone === value.tone) {
      return getTikTokCampaignSnapshot(database, current.campaign_id)!;
    }
    const now = Date.now();
    const generationJobs = database.prepare(`
      SELECT j.id FROM jobs j JOIN operations o ON o.id = j.operation_id
      WHERE o.post_id = ? AND o.kind = 'comments.generate' AND j.status IN ('pending', 'running')
    `).all(current.post_id) as Array<{ id: string }>;
    for (const job of generationJobs) requestJobCancellation(database, job.id, now);
    database.prepare(`
      INSERT INTO comments (
        id, assignment_id, version, intention, tone, text, status, stale, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'edited', 0, 'manual', ?, ?)
    `).run(randomUUID(), current.assignment_id, current.version + 1, intention, value.tone, text, now, now);
    database.prepare("UPDATE assignments SET status = 'draft', updated_at = ? WHERE id = ?").run(now, current.assignment_id);
    database.prepare("UPDATE posts SET status = 'ready', updated_at = ? WHERE id = ?").run(now, current.post_id);
    database.prepare("UPDATE campaigns SET status = 'ready' WHERE id = ?").run(current.campaign_id);
    touchCampaign(database, current.campaign_id, now);
    return getTikTokCampaignSnapshot(database, current.campaign_id)!;
  }).immediate();
}

export function requestTikTokPostExecution(
  database: Database.Database,
  campaignId: string,
  value: unknown,
  config = readTikTokConfig(),
) {
  const input = objectValue(value);
  if (!config.publicEffectsEnabled) {
    throw new TikTokError("TIKTOK_EFFECTS_DISABLED", "TikTok post esta deshabilitado; configura TIKTOK_PUBLIC_EFFECTS_ENABLED=true.", 503);
  }
  if (input.confirmed !== true || input.controlledAccount !== true || input.controlledContent !== true) {
    throw new TikTokError("EXPLICIT_CONFIRMATION_REQUIRED", "Confirma la cuenta, el contenido y los efectos publicos.", 409);
  }
  if (!Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) {
    throw new TikTokError("INVALID_CONFIRMATION", "La revision confirmada no es valida.");
  }
  const expectedActionsInput = objectValue(input.expectedActions, "expectedActions es obligatorio.");
  if (typeof expectedActionsInput.like !== "boolean" || typeof expectedActionsInput.comment !== "boolean") {
    throw new TikTokError("INVALID_CONFIRMATION", "Las acciones confirmadas no son validas.");
  }
  const actions = { like: expectedActionsInput.like, comment: expectedActionsInput.comment };
  const expectedAccount = nonEmptyString(input.expectedAccount, "expectedAccount", 300);
  if (!config.controlledAccount || expectedAccount !== config.controlledAccount) {
    throw new TikTokError("CONTROLLED_ACCOUNT_CHANGED", "La cuenta TikTok controlada cambio o no esta configurada.", 409);
  }
  const expectedAccountResourceId = requiredConfig(config.accountResourceId, "TIKTOK_ACCOUNT_RESOURCE_ID");
  const expectedPostContainerResourceId = requiredConfig(config.postContainerResourceId, "TIKTOK_POST_CONTAINER_RESOURCE_ID");
  const expectedPostUrlResourceId = requiredConfig(config.postUrlResourceId, "TIKTOK_POST_URL_RESOURCE_ID");
  const expectedCommentComposerResourceId = actions.comment ? requiredConfig(config.commentComposerResourceId, "TIKTOK_COMMENT_COMPOSER_RESOURCE_ID") : null;
  const expectedCommentEditorResourceId = actions.comment ? requiredConfig(config.commentEditorResourceId, "TIKTOK_COMMENT_EDITOR_RESOURCE_ID") : null;
  const expectedCommentSubmitResourceId = actions.comment ? requiredConfig(config.commentSubmitResourceId, "TIKTOK_COMMENT_SUBMIT_RESOURCE_ID") : null;
  const expectedCommentResultContainerResourceId = actions.comment ? requiredConfig(config.commentResultContainerResourceId, "TIKTOK_COMMENT_RESULT_CONTAINER_RESOURCE_ID") : null;
  const expectedAssignmentId = nonEmptyString(input.expectedAssignmentId, "expectedAssignmentId", 200);
  const expectedPostId = nonEmptyString(input.expectedPostId, "expectedPostId", 200);
  const expectedDeviceId = nonEmptyString(input.expectedDeviceId, "expectedDeviceId", 120);
  const expectedPostUrl = normalizeTikTokUrl(nonEmptyString(input.expectedPostUrl, "expectedPostUrl", 2_048)).sourceUrl;
  const expectedTargetText = nonEmptyString(input.expectedTargetText, "expectedTargetText", 500);
  if (expectedTargetText.length < 5) throw new TikTokError("TARGET_TEXT_INVALID", "La referencia visible debe tener al menos 5 caracteres.");
  let expectedComment: null | { id: string; version: number; textHash: string } = null;
  if (input.expectedComment !== null) {
    const comment = objectValue(input.expectedComment, "expectedComment no es valido.");
    if (!Number.isInteger(comment.version) || Number(comment.version) < 1 || typeof comment.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(comment.textHash)) {
      throw new TikTokError("INVALID_CONFIRMATION", "La version o hash del comentario no es valido.");
    }
    expectedComment = {
      id: nonEmptyString(comment.id, "expectedComment.id", 200),
      version: Number(comment.version),
      textHash: comment.textHash,
    };
  }
  return database.transaction(() => {
    const campaign = database.prepare(`
      SELECT status, revision, like_enabled, comment_enabled FROM campaigns
      WHERE id = ? AND platform = 'tiktok'
    `).get(campaignId) as { status: string; revision: number; like_enabled: 0 | 1; comment_enabled: 0 | 1 } | undefined;
    if (!campaign) throw new TikTokError("CAMPAIGN_NOT_FOUND", "La campana TikTok no existe.", 404);
    if (database.prepare(`
      SELECT 1 FROM operations WHERE campaign_id = ?
        AND json_extract(request_json, '$.mode') = 'live' LIMIT 1
    `).get(campaignId)) {
      throw new TikTokError("TIKTOK_POST_REQUIRED", "La ejecucion solicitada pertenece a TikTok Live.", 409);
    }
    const rows = database.prepare(`
      SELECT a.id, a.post_id, a.device_id, a.status, p.status AS post_status,
        p.source_url, p.final_url, p.context_hash
      FROM assignments a JOIN posts p ON p.id = a.post_id WHERE a.campaign_id = ?
    `).all(campaignId) as Array<{
      id: string;
      post_id: string;
      device_id: string;
      status: string;
      post_status: string;
      source_url: string;
      final_url: string | null;
      context_hash: string | null;
    }>;
    if (rows.length !== 1) throw new TikTokError("TIKTOK_REQUIRES_1X1", "La campana TikTok ya no es 1x1.", 409);
    const row = rows[0];
    if (row.id !== expectedAssignmentId || row.post_id !== expectedPostId || row.device_id !== expectedDeviceId) {
      throw new TikTokError("CONFIRMED_TARGET_CHANGED", "La asignacion TikTok confirmada cambio.", 409);
    }
    const effectiveUrl = row.final_url ?? row.source_url;
    if (normalizeTikTokUrl(effectiveUrl).normalizedUrl !== normalizeTikTokUrl(expectedPostUrl).normalizedUrl) {
      throw new TikTokError("CONFIRMED_TARGET_CHANGED", "La URL TikTok efectiva cambio.", 409);
    }
    const comment = campaign.comment_enabled ? currentComment(database, row.id) : undefined;
    const payload: TikTokPostExecutionPayload = {
      mode: "post",
      assignmentId: row.id,
      campaignId,
      postId: row.post_id,
      deviceId: row.device_id,
      expectedRevision: Number(input.expectedRevision),
      expectedAccount,
      expectedAccountResourceId,
      expectedPostContainerResourceId,
      expectedPostUrlResourceId,
      expectedLikeActiveLabels: config.likeActiveLabels,
      expectedLikeInactiveLabels: config.likeInactiveLabels,
      expectedCommentLabels: config.commentLabels,
      expectedCommentComposerResourceId,
      expectedCommentEditorResourceId,
      expectedCommentSubmitResourceId,
      expectedCommentResultContainerResourceId,
      expectedTargetText,
      postUrl: effectiveUrl,
      contextHash: row.context_hash,
      actions,
      comment: expectedComment && comment ? { ...expectedComment, text: comment.text } : null,
      authorization: {
        publicEffects: true,
        controlledAccount: true,
        controlledContent: true,
        environmentGate: "TIKTOK_PUBLIC_EFFECTS_ENABLED",
      },
    };
    const created = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : "",
      request: payload,
      campaignId,
      postId: row.post_id,
      assignmentId: row.id,
      deviceId: row.device_id,
    });
    if (created.replayed) {
      const previousJob = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(created.operation.id) as { id: string } | undefined;
      if (!previousJob) throw new Error("La autorizacion idempotente no conserva su job.");
      return { operation: created.operation, job: getJob(database, previousJob.id)!, replayed: true };
    }
    if (campaign.revision !== payload.expectedRevision) throw new TikTokError("CAMPAIGN_REVISION_CHANGED", "La campana cambio; confirma de nuevo.", 409);
    if (Boolean(campaign.like_enabled) !== actions.like || Boolean(campaign.comment_enabled) !== actions.comment) {
      throw new TikTokError("CONFIRMED_ACTIONS_CHANGED", "Las acciones seleccionadas cambiaron.", 409);
    }
    if (campaign.status !== "ready" || row.post_status !== "ready" || !["draft", "approved", "failed", "cancelled"].includes(row.status)) {
      throw new TikTokError("CAMPAIGN_NOT_EXECUTABLE", "La campana TikTok no esta lista.", 409);
    }
    if (actions.comment && (!comment || !expectedComment || comment.id !== expectedComment.id
      || comment.version !== expectedComment.version || hashText(comment.text) !== expectedComment.textHash
      || !["ready", "edited"].includes(comment.status) || comment.stale)) {
      throw new TikTokError("CONFIRMED_COMMENT_CHANGED", "El comentario TikTok cambio o no esta listo.", 409);
    }
    if (!actions.comment && expectedComment) throw new TikTokError("CONFIRMED_COMMENT_CHANGED", "La confirmacion incluye un comentario no seleccionado.", 409);
    const blocked = database.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM operations WHERE assignment_id = ? AND kind = 'assignment.execute'
          AND status IN ('pending', 'running') AND id != ?
      ) AS active,
      EXISTS(
        SELECT 1 FROM assignment_action_results WHERE assignment_id = ?
          AND status IN ('effect_possible', 'outcome_unknown')
      ) AS uncertain
    `).get(row.id, created.operation.id, row.id) as { active: 0 | 1; uncertain: 0 | 1 };
    if (blocked.uncertain) throw new TikTokError("RECONCILIATION_REQUIRED", "Existe un efecto TikTok incierto que debe reconciliarse manualmente.", 409);
    if (blocked.active) throw new TikTokError("OPERATION_IN_PROGRESS", "La asignacion TikTok ya tiene una ejecucion activa.", 409);
    assertTikTokDeviceEligible(database, row.device_id);
    const now = Date.now();
    const insertAction = database.prepare(`
      INSERT INTO assignment_action_results (
        id, assignment_id, operation_id, action, status, result,
        comment_id, comment_version, text_hash, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (actions.like) {
      const prior = database.prepare(`
        SELECT 1 FROM assignment_action_results
        WHERE assignment_id = ? AND action = 'like' AND status = 'confirmed' LIMIT 1
      `).get(row.id);
      insertAction.run(randomUUID(), row.id, created.operation.id, "like", prior ? "confirmed" : "pending", prior ? "preserved" : null, null, null, null, now, now, prior ? now : null);
    }
    if (actions.comment) {
      insertAction.run(randomUUID(), row.id, created.operation.id, "comment", "pending", null, comment!.id, comment!.version, hashText(comment!.text), now, now, null);
    }
    database.prepare("UPDATE assignments SET status = 'approved', completed_at = NULL, updated_at = ? WHERE id = ?").run(now, row.id);
    const job = enqueueJob(database, "assignment.execute", payload, {
      campaignId,
      postId: row.post_id,
      assignmentId: row.id,
      operationId: created.operation.id,
      maxAttempts: 1,
      effectPhase: "before_effect",
    });
    touchCampaign(database, campaignId, now);
    return { operation: created.operation, job, replayed: false };
  }).immediate();
}

export function requestTikTokLiveExecution(database: Database.Database, value: unknown, config = readTikTokConfig()) {
  const input = validateTikTokLiveRequest(value);
  if (!config.liveEffectsEnabled) {
    throw new TikTokError("TIKTOK_LIVE_EFFECTS_DISABLED", "TikTok Live esta deshabilitado; configura TIKTOK_LIVE_EFFECTS_ENABLED=true.", 503);
  }
  const liveCalibration = config.liveCalibration;
  if (!liveCalibration
    || input.deviceId !== liveCalibration.deviceId
    || input.x !== liveCalibration.x
    || input.y !== liveCalibration.y) {
    throw new TikTokError("TIKTOK_LIVE_CALIBRATION_REQUIRED", "El dispositivo y las coordenadas no coinciden con la calibracion Live validada.", 409);
  }
  if (!config.controlledAccount || input.expectedAccount !== config.controlledAccount) {
    throw new TikTokError("CONTROLLED_ACCOUNT_CHANGED", "La cuenta TikTok controlada cambio o no esta configurada.", 409);
  }
  const expectedAccountResourceId = requiredConfig(config.accountResourceId, "TIKTOK_ACCOUNT_RESOURCE_ID");
  const expectedLiveContainerResourceId = requiredConfig(config.liveContainerResourceId, "TIKTOK_LIVE_CONTAINER_RESOURCE_ID");
  const expectedLiveUrlResourceId = requiredConfig(config.liveUrlResourceId, "TIKTOK_LIVE_URL_RESOURCE_ID");
  return database.transaction(() => {
    const normalizedKey = input.idempotencyKey.trim().toLowerCase();
    const priorRow = database.prepare("SELECT id FROM operations WHERE idempotency_key = ?").get(normalizedKey) as { id: string } | undefined;
    if (priorRow) {
      const operation = getOperation(database, priorRow.id)!;
      const payload = operation.request as TikTokLiveExecutionPayload;
      const comparable = payload.mode === "live" ? {
        deviceId: payload.deviceId,
        expectedAccount: payload.expectedAccount,
        expectedTargetText: payload.expectedTargetText,
        rounds: payload.rounds,
        url: payload.liveUrl,
        x: payload.x,
        y: payload.y,
      } : null;
      const requested = {
        deviceId: input.deviceId,
        expectedAccount: input.expectedAccount,
        expectedTargetText: input.expectedTargetText,
        rounds: input.rounds,
        url: input.url,
        x: input.x,
        y: input.y,
      };
      if (!comparable || stableJson(comparable) !== stableJson(requested)) throw new IdempotencyConflictError();
      const jobRow = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(operation.id) as { id: string } | undefined;
      if (!jobRow) throw new Error("La autorizacion Live idempotente no conserva su job.");
      return { operation, job: getJob(database, jobRow.id)!, campaign: getTikTokCampaignSnapshot(database, payload.campaignId), replayed: true };
    }
    const normalized = normalizeTikTokLiveUrl(input.url);
    const blocked = database.prepare(`
      SELECT
        EXISTS(
          SELECT 1 FROM operations o
          WHERE o.device_id = ? AND o.kind = 'assignment.execute'
            AND json_extract(o.request_json, '$.mode') = 'live'
            AND o.status IN ('pending', 'running')
        ) AS active,
        EXISTS(
          SELECT 1 FROM operations o
          JOIN assignments a ON a.id = o.assignment_id
          JOIN posts p ON p.id = o.post_id
          WHERE o.device_id = ? AND o.kind = 'assignment.execute'
            AND json_extract(o.request_json, '$.mode') = 'live'
            AND a.status = 'outcome_unknown' AND p.normalized_url = ?
        ) AS uncertain
    `).get(input.deviceId, input.deviceId, normalized.normalizedUrl) as { active: 0 | 1; uncertain: 0 | 1 };
    if (blocked.active) throw new TikTokError("TIKTOK_LIVE_IN_PROGRESS", "Ya existe una ejecucion Live activa para este dispositivo.", 409);
    if (blocked.uncertain) throw new TikTokError("TIKTOK_LIVE_RECONCILIATION_REQUIRED", "Este Live conserva una ronda incierta y no puede repetirse.", 409);
    assertTikTokDeviceEligible(database, input.deviceId);
    const campaignId = randomUUID();
    const postId = randomUUID();
    const assignmentId = randomUUID();
    const now = Date.now();
    database.prepare(`
      INSERT INTO campaigns (id, platform, status, like_enabled, comment_enabled, created_at, updated_at)
      VALUES (?, 'tiktok', 'ready', 0, 0, ?, ?)
    `).run(campaignId, now, now);
    database.prepare(`
      INSERT INTO posts (
        id, campaign_id, position, source_url, normalized_url, status, context_status, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, 'ready', 'ready', ?, ?)
    `).run(postId, campaignId, normalized.sourceUrl, normalized.normalizedUrl, now, now);
    database.prepare(`
      INSERT INTO assignments (id, campaign_id, post_id, device_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'approved', ?, ?)
    `).run(assignmentId, campaignId, postId, input.deviceId, now, now);
    const payload: TikTokLiveExecutionPayload = {
      mode: "live",
      assignmentId,
      campaignId,
      postId,
      deviceId: input.deviceId,
      expectedRevision: 1,
      expectedAccount: input.expectedAccount,
      expectedAccountResourceId,
      expectedLiveContainerResourceId,
      expectedLiveUrlResourceId,
      expectedTargetText: input.expectedTargetText,
      liveUrl: normalized.sourceUrl,
      rounds: input.rounds,
      x: input.x,
      y: input.y,
      authorization: {
        publicEffects: true,
        controlledAccount: true,
        controlledContent: true,
        calibratedCoordinates: true,
        calibration: liveCalibration,
        environmentGate: "TIKTOK_LIVE_EFFECTS_ENABLED",
      },
    };
    const created = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: input.idempotencyKey,
      request: payload,
      campaignId,
      postId,
      assignmentId,
      deviceId: input.deviceId,
    });
    const job = enqueueJob(database, "assignment.execute", payload, {
      campaignId,
      postId,
      assignmentId,
      operationId: created.operation.id,
      maxAttempts: 1,
      effectPhase: "before_effect",
    });
    return { operation: created.operation, job, campaign: getTikTokCampaignSnapshot(database, campaignId), replayed: false };
  }).immediate();
}

const TERMINAL_ASSIGNMENTS = new Set(["sent", "failed", "outcome_unknown", "cancelled"]);

export function reduceTikTokCampaignExecution(database: Database.Database, campaignId: string, now = Date.now()) {
  const campaign = database.prepare("SELECT status FROM campaigns WHERE id = ? AND platform = 'tiktok'")
    .get(campaignId) as { status: string } | undefined;
  const assignments = database.prepare("SELECT id, post_id, status FROM assignments WHERE campaign_id = ?")
    .all(campaignId) as Array<{ id: string; post_id: string; status: string }>;
  if (!campaign || assignments.length !== 1) throw new TikTokError("CAMPAIGN_NOT_FOUND", "La campana TikTok 1x1 no existe.", 404);
  const assignment = assignments[0];
  const postStatus = assignment.status === "sent"
    ? "completed"
    : assignment.status === "outcome_unknown"
      ? "outcome_unknown"
      : ["failed", "cancelled"].includes(assignment.status)
        ? "partial_failed"
        : ["running", "cancellation_requested"].includes(assignment.status)
          ? "running"
          : assignment.status === "scheduled"
            ? "scheduled"
            : null;
  if (postStatus) database.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(postStatus, now, assignment.post_id);
  const cleanupIssue = Boolean(database.prepare(`
    SELECT 1 FROM operations WHERE assignment_id = ? AND kind = 'assignment.execute'
      AND cleanup_status IN ('failed', 'outcome_unknown') LIMIT 1
  `).get(assignment.id));
  const campaignStatus = campaign.status === "cancellation_requested" && !TERMINAL_ASSIGNMENTS.has(assignment.status)
    ? "cancellation_requested"
    : assignment.status === "sent"
      ? cleanupIssue ? "completed_with_issues" : "completed"
      : assignment.status === "cancelled"
        ? cleanupIssue ? "cancelled_with_cleanup_errors" : "cancelled"
        : TERMINAL_ASSIGNMENTS.has(assignment.status)
          ? "completed_with_issues"
          : ["running", "cancellation_requested"].includes(assignment.status)
            ? "running"
            : null;
  if (campaignStatus) {
    database.prepare("UPDATE campaigns SET status = ?, completed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(campaignStatus, TERMINAL_ASSIGNMENTS.has(assignment.status) ? now : null, now, campaignId);
  }
  return getTikTokCampaignSnapshot(database, campaignId)!;
}

export function requestTikTokExecutionCancellation(
  database: Database.Database,
  jobId: string,
  options: { global?: boolean; now?: number } = {},
) {
  return database.transaction(() => {
    const current = getJob(database, jobId);
    if (!current || current.kind !== "assignment.execute" || !current.assignmentId || !current.campaignId) {
      throw new TikTokError("EXECUTION_NOT_FOUND", "La ejecucion TikTok no existe.", 404);
    }
    const platform = database.prepare("SELECT platform FROM campaigns WHERE id = ?").get(current.campaignId) as { platform: string } | undefined;
    if (platform?.platform !== "tiktok") throw new TikTokError("EXECUTION_NOT_FOUND", "La ejecucion TikTok no existe.", 404);
    if (!["pending", "running"].includes(current.status)) return current;
    const now = options.now ?? Date.now();
    if (options.global) database.prepare("UPDATE campaigns SET status = 'cancellation_requested', cancellation_reason = ?, updated_at = ? WHERE id = ?")
      .run("Cancelacion global solicitada por el operador.", now, current.campaignId);
    const cancelled = requestJobCancellation(database, jobId, now);
    if (current.status === "pending") {
      database.prepare(`
        UPDATE assignment_action_results SET status = 'cancelled', error = 'Cancelada por el operador.', updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND status = 'pending'
      `).run(now, now, current.operationId);
      database.prepare("UPDATE assignments SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ?")
        .run(now, now, current.assignmentId);
    } else {
      const status = (database.prepare("SELECT status FROM assignments WHERE id = ?").get(current.assignmentId) as { status: string }).status;
      if (status !== "sent") database.prepare("UPDATE assignments SET status = 'cancellation_requested', updated_at = ? WHERE id = ?").run(now, current.assignmentId);
    }
    reduceTikTokCampaignExecution(database, current.campaignId, now);
    return cancelled;
  }).immediate();
}

export function reconcileTikTokAssignment(database: Database.Database, assignmentId: string, value: unknown) {
  const input = objectValue(value);
  if (input.action !== "like" && input.action !== "comment") throw new TikTokError("RECONCILIATION_INVALID", "La accion no es valida.");
  if (input.resolution !== "sent" && input.resolution !== "not_sent") throw new TikTokError("RECONCILIATION_INVALID", "La resolucion debe ser sent o not_sent.");
  const operationId = nonEmptyString(input.operationId, "operationId", 200);
  return database.transaction(() => {
    const assignment = database.prepare(`
      SELECT a.id, a.campaign_id, a.post_id, a.device_id, a.status, c.like_enabled, c.comment_enabled
      FROM assignments a JOIN campaigns c ON c.id = a.campaign_id
      WHERE a.id = ? AND c.platform = 'tiktok'
    `).get(assignmentId) as {
      id: string;
      campaign_id: string;
      post_id: string;
      device_id: string;
      status: string;
      like_enabled: 0 | 1;
      comment_enabled: 0 | 1;
    } | undefined;
    if (!assignment) throw new TikTokError("ASSIGNMENT_NOT_FOUND", "La asignacion TikTok no existe.", 404);
    if (database.prepare("SELECT 1 FROM jobs WHERE assignment_id = ? AND status IN ('pending', 'running')").get(assignmentId)) {
      throw new TikTokError("EXECUTION_IN_PROGRESS", "Espera a que el worker termine antes de reconciliar.", 409);
    }
    const created = createOperation(database, {
      kind: "operation.reconcile",
      idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : "",
      request: { assignmentId, operationId, action: input.action, resolution: input.resolution },
      campaignId: assignment.campaign_id,
      postId: assignment.post_id,
      assignmentId,
      deviceId: assignment.device_id,
    });
    if (created.replayed) return { operation: created.operation, campaign: getTikTokCampaignSnapshot(database, assignment.campaign_id), replayed: true };
    const uncertain = database.prepare(`
      SELECT id FROM assignment_action_results WHERE assignment_id = ? AND operation_id = ? AND action = ?
        AND status IN ('effect_possible', 'outcome_unknown')
    `).get(assignmentId, operationId, input.action) as { id: string } | undefined;
    if (!uncertain || assignment.status !== "outcome_unknown") {
      throw new TikTokError("RECONCILIATION_NOT_REQUIRED", "La asignacion no tiene ese efecto incierto.", 409);
    }
    const session = database.prepare("SELECT cleanup_status, closed_at FROM appium_sessions WHERE operation_id = ?")
      .get(operationId) as { cleanup_status: string; closed_at: number | null } | undefined;
    if (!session || session.closed_at === null || session.cleanup_status !== "home_confirmed") {
      throw new TikTokError("EXECUTION_NOT_QUIESCENT", "Confirma cierre de sesion y Home antes de reconciliar.", 409);
    }
    const now = Date.now();
    database.prepare("UPDATE assignment_action_results SET status = ?, result = ?, error = NULL, updated_at = ?, completed_at = ? WHERE id = ?")
      .run(input.resolution === "sent" ? "confirmed" : "reconciled_not_sent", input.resolution === "sent" ? (input.action === "like" ? "activated" : "sent") : "not_sent", now, now, uncertain.id);
    const confirmed = database.prepare(`
      SELECT EXISTS(SELECT 1 FROM assignment_action_results WHERE assignment_id = ? AND action = 'like' AND status = 'confirmed') AS liked,
        EXISTS(SELECT 1 FROM assignment_action_results WHERE assignment_id = ? AND action = 'comment' AND status = 'confirmed') AS commented
    `).get(assignmentId, assignmentId) as { liked: 0 | 1; commented: 0 | 1 };
    const complete = (!assignment.like_enabled || confirmed.liked) && (!assignment.comment_enabled || confirmed.commented);
    database.prepare("UPDATE assignments SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?")
      .run(complete ? "sent" : "approved", complete ? now : null, now, assignmentId);
    if (!complete) {
      database.prepare("UPDATE posts SET status = 'ready', error = NULL, updated_at = ? WHERE id = ?").run(now, assignment.post_id);
      database.prepare("UPDATE campaigns SET status = 'ready', completed_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now, assignment.campaign_id);
    }
    completeOperation(database, created.operation.id, { assignmentId, operationId, action: input.action, resolution: input.resolution });
    reduceTikTokCampaignExecution(database, assignment.campaign_id, now);
    return { operation: getOperation(database, created.operation.id)!, campaign: getTikTokCampaignSnapshot(database, assignment.campaign_id), replayed: false };
  }).immediate();
}

export function getTikTokCampaignSnapshot(database: Database.Database, campaignId: string) {
  const campaign = database.prepare(`
    SELECT id, status, like_enabled, comment_enabled, revision, cancellation_reason, created_at, updated_at
    FROM campaigns WHERE id = ? AND platform = 'tiktok'
  `).get(campaignId) as {
    id: string;
    status: string;
    like_enabled: 0 | 1;
    comment_enabled: 0 | 1;
    revision: number;
    cancellation_reason: string | null;
    created_at: number;
    updated_at: number;
  } | undefined;
  if (!campaign) return null;
  const assignment = database.prepare(`
    SELECT id, post_id, device_id, status, scheduled_at, actual_at
    FROM assignments WHERE campaign_id = ?
  `).get(campaignId) as {
    id: string;
    post_id: string;
    device_id: string;
    status: string;
    scheduled_at: number | null;
    actual_at: number | null;
  } | undefined;
  const post = database.prepare("SELECT * FROM posts WHERE campaign_id = ?")
    .get(campaignId) as (Record<string, unknown> & {
      id: string;
      position: number;
      source_url: string;
      normalized_url: string;
      final_url: string | null;
      status: string;
      context_status: string;
      context: string | null;
      context_hash: string | null;
      context_source: string | null;
      context_version: number;
      error: string | null;
    }) | undefined;
  if (!assignment || !post) return null;
  const comment = currentComment(database, assignment.id);
  const execution = database.prepare(`
    SELECT o.id, o.request_json, o.status, o.effect_phase, o.session_status, o.cleanup_status,
      o.error, o.created_at, j.attempts
    FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id
    WHERE o.assignment_id = ? AND o.kind = 'assignment.execute'
    ORDER BY o.created_at DESC, o.id DESC LIMIT 1
  `).get(assignment.id) as {
    id: string;
    request_json: string;
    status: string;
    effect_phase: string;
    session_status: string;
    cleanup_status: string;
    error: string | null;
    created_at: number;
    attempts: number | null;
  } | undefined;
  const executionPayload = execution ? JSON.parse(execution.request_json) as Partial<TikTokExecutionPayload> : null;
  const mode = executionPayload?.mode === "live" ? "live" : "post";
  const actions = execution ? database.prepare(`
    SELECT action, status, result, error FROM assignment_action_results WHERE operation_id = ?
  `).all(execution.id) as Array<{ action: "like" | "comment"; status: string; result: string | null; error: string | null }> : [];
  const action = (name: "like" | "comment") => {
    const row = actions.find((item) => item.action === name);
    return row ? { status: row.status, result: row.result, error: row.error } : null;
  };
  const checkpoints = execution ? database.prepare(`
    SELECT id, phase, sequence, created_at FROM checkpoints WHERE operation_id = ? ORDER BY created_at, sequence
  `).all(execution.id) as Array<{ id: string; phase: string; sequence: number; created_at: number }> : [];
  const evidence = execution ? database.prepare(`
    SELECT checkpoint_id, kind, path, created_at FROM evidence WHERE operation_id = ? ORDER BY created_at
  `).all(execution.id) as Array<{ checkpoint_id: string | null; kind: "metadata" | "screenshot" | "page_source"; path: string; created_at: number }> : [];
  const like = action("like");
  const commentAction = action("comment");
  return {
    id: campaign.id,
    platform: "tiktok" as const,
    mode,
    status: campaign.status,
    revision: campaign.revision,
    cancellationReason: campaign.cancellation_reason,
    actions: { like: Boolean(campaign.like_enabled), comment: Boolean(campaign.comment_enabled) },
    controlledAccount: readTikTokConfig().controlledAccount || null,
    deviceIds: [assignment.device_id],
    createdAt: campaign.created_at,
    updatedAt: campaign.updated_at,
    posts: [{
      id: post.id,
      position: post.position,
      url: post.source_url,
      normalizedUrl: post.normalized_url,
      finalUrl: post.final_url,
      status: post.status,
      contextStatus: post.context_status,
      context: post.context ?? "",
      contextHash: post.context_hash,
      contextVersion: post.context_version,
      extractedContext: "",
      contextSource: post.context_source,
      extractorVersion: null,
      extractedAt: null,
      error: post.error,
      comments: comment ? [{
        id: comment.id,
        assignmentId: assignment.id,
        deviceId: assignment.device_id,
        version: comment.version,
        intention: comment.intention,
        tone: comment.tone,
        text: comment.text,
        status: comment.status,
        stale: Boolean(comment.stale),
        source: comment.source,
        textHash: hashText(comment.text),
        error: comment.error,
      }] : [],
    }],
    assignments: [{
      id: assignment.id,
      postId: assignment.post_id,
      deviceId: assignment.device_id,
      status: assignment.status,
      scheduledAt: assignment.scheduled_at,
      actualAt: assignment.actual_at,
      execution: execution ? {
        operationId: execution.id,
        mode,
        status: execution.status,
        effectPhase: execution.effect_phase,
        sessionStatus: execution.session_status,
        cleanupStatus: execution.cleanup_status,
        attempts: execution.attempts ?? 0,
        ...(mode === "live" ? {
          confirmedRounds: checkpoints.filter((item) => item.phase === "tiktok_live_round_confirmed").length,
          requestedRounds: executionPayload?.mode === "live" ? executionPayload.rounds : 0,
        } : {}),
        error: execution.error,
        uncertainAction: like?.status === "outcome_unknown" || like?.status === "effect_possible"
          ? "like"
          : commentAction?.status === "outcome_unknown" || commentAction?.status === "effect_possible"
            ? "comment"
            : mode === "live" && execution.effect_phase === "effect_possible"
              ? "live_round"
              : null,
        like,
        comment: commentAction,
        checkpoints: checkpoints.map((item) => ({ id: item.id, phase: item.phase, sequence: item.sequence, createdAt: item.created_at })),
        evidence: evidence.map((item) => ({ checkpointId: item.checkpoint_id, kind: item.kind, path: item.path, createdAt: item.created_at })),
      } : null,
    }],
  };
}

export function getLatestTikTokCampaignSnapshot(database: Database.Database) {
  const row = database.prepare("SELECT id FROM campaigns WHERE platform = 'tiktok' ORDER BY created_at DESC, id DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return row ? getTikTokCampaignSnapshot(database, row.id) : null;
}

export function listTikTokCampaignSnapshots(database: Database.Database) {
  const rows = database.prepare("SELECT id FROM campaigns WHERE platform = 'tiktok' ORDER BY created_at DESC, id DESC")
    .all() as Array<{ id: string }>;
  return rows.map((row) => getTikTokCampaignSnapshot(database, row.id)!);
}
