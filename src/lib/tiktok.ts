import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import { appConfig } from "./config.ts";
import { CURRENT_SETUP_REVISION } from "./device-runtime.ts";
import { completeOperation, createOperation, getOperation, IdempotencyConflictError, stableJson } from "./operations.ts";
import { enqueueJob, getJob, requestJobCancellation } from "./queue.ts";

export const TIKTOK_APP_PACKAGE = "com.zhiliaoapp.musically";
export const TIKTOK_TONES = ["Cercano", "Entusiasta", "Informativo", "Breve"] as const;
const TIKTOK_POST_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]);
const TIKTOK_SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);

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
  deviceIds: string[];
  urls: string[];
  rounds: number;
  expectedAccount: string;
  targetTexts: string[];
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

function canonicalTikTokPostUrl(value: string) {
  const url = new URL(normalizeTikTokUrl(value).normalizedUrl);
  const post = /^\/@[^/]+\/(?:video|photo)\/([1-9]\d*)$/u.exec(url.pathname);
  if (!TIKTOK_POST_HOSTS.has(url.hostname) || !post) {
    throw new TikTokError("INVALID_TIKTOK_POST_URL", "El destino debe ser una publicacion canonica TikTok, no un Live, perfil o enlace corto.");
  }
  // The numeric post ID identifies the content; share parameters do not.
  url.search = "";
  return { finalUrl: url.toString(), identity: post[1] };
}

export async function resolveTikTokPostUrl(
  value: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  timeoutMs = 10_000,
) {
  signal?.throwIfAborted();
  let current = normalizeTikTokUrl(value).sourceUrl;
  if (!TIKTOK_SHORT_HOSTS.has(new URL(current).hostname)) return canonicalTikTokPostUrl(current).finalUrl;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new RangeError("timeoutMs debe estar entre 1 y 10000.");
  const timeout = AbortSignal.timeout(timeoutMs);
  const resolutionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const seen = new Set<string>();
  try {
    for (let redirects = 0; ; redirects += 1) {
      resolutionSignal.throwIfAborted();
      const normalized = normalizeTikTokUrl(current);
      const url = new URL(normalized.sourceUrl);
      if (!TIKTOK_POST_HOSTS.has(url.hostname) && !TIKTOK_SHORT_HOSTS.has(url.hostname)) {
        throw new TikTokError("INVALID_TIKTOK_URL", "El host de redireccion TikTok no esta permitido.");
      }
      if (seen.has(normalized.sourceUrl)) throw new TikTokError("TIKTOK_REDIRECT_LOOP", "El enlace TikTok contiene un bucle de redireccion.", 422);
      seen.add(normalized.sourceUrl);
      const response = await fetcher(url.toString(), { redirect: "manual", signal: resolutionSignal });
      // Only headers are needed; do not download a post or wait on body cleanup.
      void response.body?.cancel().catch(() => undefined);
      resolutionSignal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= 5) throw new TikTokError("TIKTOK_REDIRECT_LIMIT", "El enlace TikTok supera 5 redirecciones.", 422);
        const location = response.headers.get("location");
        if (!location || /["'\u0000-\u001f\u007f]/u.test(location)) {
          throw new TikTokError("TIKTOK_REDIRECT_INVALID", "TikTok devolvio una redireccion sin destino valido.", 502);
        }
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) throw new TikTokError("TIKTOK_URL_RESOLUTION_FAILED", `TikTok respondio HTTP ${response.status} al resolver el enlace.`, 502);
      return canonicalTikTokPostUrl(url.toString()).finalUrl;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new TikTokError("TIKTOK_URL_RESOLUTION_TIMEOUT", "Se agoto el tiempo para resolver el enlace TikTok.", 504);
    if (error instanceof TikTokError) throw error;
    throw new TikTokError("TIKTOK_URL_RESOLUTION_FAILED", "No se pudo resolver el enlace TikTok.", 502);
  }
}

export function validateTikTokCampaignRequest(value: unknown): TikTokCampaignRequest {
  const input = objectValue(value);
  if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 10) {
    throw new TikTokError("INVALID_TIKTOK_URLS", "La campana TikTok requiere entre 1 y 10 URLs.");
  }
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  for (const rawUrl of input.urls) {
    if (typeof rawUrl !== "string") throw new TikTokError("INVALID_TIKTOK_URL", "Cada URL debe ser texto.");
    const normalized = normalizeTikTokUrl(rawUrl);
    if (/^\/@[^/]+\/live$/u.test(new URL(normalized.normalizedUrl).pathname)) {
      throw new TikTokError("INVALID_TIKTOK_POST_URL", "TikTok post no admite una URL Live.");
    }
    if (seenUrls.has(normalized.normalizedUrl)) {
      throw new TikTokError("DUPLICATE_TIKTOK_URL", "La lista contiene publicaciones duplicadas.");
    }
    seenUrls.add(normalized.normalizedUrl);
    urls.push(normalized.sourceUrl);
  }

  if (!Array.isArray(input.deviceIds) || input.deviceIds.length < 1 || input.deviceIds.length > 100) {
    throw new TikTokError("INVALID_DEVICE_SELECTION", "Selecciona al menos un dispositivo elegible.");
  }
  const deviceIds = input.deviceIds.map((deviceId, index) => nonEmptyString(deviceId, `deviceIds[${index}]`, 120));
  if (new Set(deviceIds).size !== deviceIds.length) {
    throw new TikTokError("DUPLICATE_DEVICE", "Cada dispositivo solo puede seleccionarse una vez.");
  }

  const rawActions = objectValue(input.actions, "actions es obligatorio.");
  if (typeof rawActions.like !== "boolean" || typeof rawActions.comment !== "boolean" || (!rawActions.like && !rawActions.comment)) {
    throw new TikTokError("INVALID_ACTIONS", "Selecciona Like, Comentario o ambos.");
  }
  const actions = { like: rawActions.like, comment: rawActions.comment };
  if (!actions.comment) return { platform: "tiktok", urls, deviceIds, actions, distribution: [] };
  if (!Array.isArray(input.distribution) || input.distribution.length < 1 || input.distribution.length > 20) {
    throw new TikTokError("INVALID_DISTRIBUTION", "La distribucion de comentarios no es valida.");
  }
  const distribution = input.distribution.map((value, index) => {
    const row = objectValue(value, `distribution[${index}] no es valida.`);
    const intention = nonEmptyString(row.intention, `distribution[${index}].intention`, 300);
    if (typeof row.tone !== "string" || !TIKTOK_TONES.includes(row.tone as (typeof TIKTOK_TONES)[number])) {
      throw new TikTokError("INVALID_DISTRIBUTION", `distribution[${index}].tone no es valido.`);
    }
    if (!Number.isInteger(row.count) || Number(row.count) < 1 || Number(row.count) > deviceIds.length) {
      throw new TikTokError("INVALID_DISTRIBUTION", `distribution[${index}].count no es valido.`);
    }
    return { intention, tone: row.tone as (typeof TIKTOK_TONES)[number], count: Number(row.count) };
  });
  if (distribution.reduce((total, row) => total + row.count, 0) !== deviceIds.length) {
    throw new TikTokError("INVALID_DISTRIBUTION", "La distribucion debe cubrir exactamente los dispositivos elegidos.");
  }
  return { platform: "tiktok", urls, deviceIds, actions, distribution };
}

function commentProfiles(input: TikTokCampaignRequest) {
  const profiles: Array<{ deviceId: string; intention: string; tone: string }> = [];
  let deviceIndex = 0;
  for (const row of input.distribution) {
    for (let index = 0; index < row.count; index++) {
      profiles.push({ deviceId: input.deviceIds[deviceIndex++], intention: row.intention, tone: row.tone });
    }
  }
  return profiles;
}

export function validateTikTokLiveRequest(value: unknown): TikTokLiveRequest {
  const input = objectValue(value);
  const integer = (name: "rounds", minimum: number, maximum: number) => {
    if (!Number.isInteger(input[name]) || Number(input[name]) < minimum || Number(input[name]) > maximum) {
      throw new TikTokError("INVALID_TIKTOK_LIVE_RANGE", `${name} debe ser un entero entre ${minimum} y ${maximum}.`);
    }
    return Number(input[name]);
  };
  if (input.confirmed !== true || input.controlledAccount !== true || input.controlledContent !== true || input.tapTapConfirmed !== true) {
    throw new TikTokError("EXPLICIT_CONFIRMATION_REQUIRED", "Confirma la cuenta, el Live, las coordenadas y los efectos publicos.", 409);
  }
  if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 10) {
    throw new TikTokError("INVALID_TIKTOK_LIVE_URLS", "La campana Live requiere entre 1 y 10 URLs Live.");
  }
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  for (const rawUrl of input.urls) {
    if (typeof rawUrl !== "string") throw new TikTokError("INVALID_TIKTOK_LIVE_URL", "Cada URL debe ser texto.");
    const normalized = normalizeTikTokLiveUrl(rawUrl);
    if (seenUrls.has(normalized.normalizedUrl)) {
      throw new TikTokError("DUPLICATE_TIKTOK_LIVE_URL", "La lista contiene Lives duplicados.");
    }
    seenUrls.add(normalized.normalizedUrl);
    urls.push(normalized.sourceUrl);
  }
  if (!Array.isArray(input.deviceIds) || input.deviceIds.length < 1 || input.deviceIds.length > 100) {
    throw new TikTokError("INVALID_DEVICE_SELECTION", "Selecciona al menos un dispositivo elegible.");
  }
  const deviceIds = input.deviceIds.map((deviceId, index) => nonEmptyString(deviceId, `deviceIds[${index}]`, 120));
  if (new Set(deviceIds).size !== deviceIds.length) {
    throw new TikTokError("DUPLICATE_DEVICE", "Cada dispositivo solo puede seleccionarse una vez.");
  }
  if (!Array.isArray(input.targetTexts) || input.targetTexts.length !== urls.length) {
    throw new TikTokError("INVALID_TARGET_TEXTS", "Cada URL Live requiere su texto visible de referencia.");
  }
  const targetTexts = input.targetTexts.map((rawText, index) => {
    const text = nonEmptyString(rawText, `targetTexts[${index}]`, 500);
    if (text.length < 5) throw new TikTokError("TARGET_TEXT_INVALID", "Cada referencia visible debe tener al menos 5 caracteres.");
    return text;
  });
  return {
    deviceIds,
    urls,
    rounds: integer("rounds", 1, 50),
    expectedAccount: nonEmptyString(input.expectedAccount, "expectedAccount", 300),
    targetTexts,
    idempotencyKey: nonEmptyString(input.idempotencyKey, "idempotencyKey", 100),
    confirmed: true,
    controlledAccount: true,
    controlledContent: true,
    tapTapConfirmed: true,
  };
}

export function recordTikTokLiveCalibration(
  database: Database.Database,
  deviceId: string,
  x: number,
  y: number,
  now = Date.now(),
) {
  const normalizedDeviceId = nonEmptyString(deviceId, "deviceId", 120);
  if (!Number.isInteger(x) || x < 0 || x > 5_000 || !Number.isInteger(y) || y < 0 || y > 5_000) {
    throw new TikTokError("INVALID_TIKTOK_LIVE_CALIBRATION", "La calibracion X/Y debe usar enteros entre 0 y 5000.");
  }
  if (!database.prepare("SELECT 1 FROM device_profiles WHERE device_id = ?").get(normalizedDeviceId)) {
    throw new TikTokError("DEVICE_NOT_ALLOWLISTED", `El dispositivo ${normalizedDeviceId} no esta registrado.`, 409);
  }
  database.prepare(`
    INSERT INTO tiktok_live_calibrations (device_id, x, y, calibrated_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      x = excluded.x, y = excluded.y, updated_at = excluded.updated_at
  `).run(normalizedDeviceId, x, y, now, now);
  return { deviceId: normalizedDeviceId, x, y, calibratedAt: now };
}

export function listTikTokLiveCalibrations(database: Database.Database) {
  const rows = database.prepare("SELECT device_id, x, y, calibrated_at FROM tiktok_live_calibrations ORDER BY device_id")
    .all() as Array<{ device_id: string; x: number; y: number; calibrated_at: number }>;
  const calibrations: Array<{ deviceId: string; x: number; y: number; calibratedAt: number | null }> = rows.map((row) => ({
    deviceId: row.device_id,
    x: row.x,
    y: row.y,
    calibratedAt: row.calibrated_at,
  }));
  const config = readTikTokConfig();
  if (config.liveCalibration && !rows.some((row) => row.device_id === config.liveCalibration!.deviceId)) {
    calibrations.push({
      deviceId: config.liveCalibration.deviceId,
      x: config.liveCalibration.x,
      y: config.liveCalibration.y,
      calibratedAt: null,
    });
  }
  return calibrations;
}

export function getTikTokLiveCalibration(database: Database.Database, deviceId: string, config = readTikTokConfig()) {
  const row = database.prepare("SELECT device_id, x, y FROM tiktok_live_calibrations WHERE device_id = ?")
    .get(deviceId) as { device_id: string; x: number; y: number } | undefined;
  if (row) return { deviceId: row.device_id, x: row.x, y: row.y };
  return config.liveCalibration?.deviceId === deviceId ? config.liveCalibration : null;
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

export function createTikTokCampaign(
  database: Database.Database,
  operationId: string,
  request: TikTokCampaignRequest,
  resolvedUrls?: string[],
) {
  const input = validateTikTokCampaignRequest(request);
  assertOperationNotCancelled(database, operationId);
  return database.transaction(() => {
    const operation = getOperation(database, operationId);
    if (!operation || operation.kind !== "campaign.create") throw new Error("La operacion de campana TikTok no existe.");
    if (operation.campaignId) return getTikTokCampaignSnapshot(database, operation.campaignId);
    if (resolvedUrls && resolvedUrls.length !== input.urls.length) throw new TikTokError("INVALID_TIKTOK_URLS", "Falta resolver una publicacion TikTok.");
    const targets = input.urls.map((url, index) => canonicalTikTokPostUrl(resolvedUrls?.[index] ?? url));
    if (new Set(targets.map((target) => target.identity)).size !== targets.length) {
      throw new TikTokError("DUPLICATE_TIKTOK_URL", "Varios enlaces identifican la misma publicacion TikTok.");
    }
    for (const deviceId of input.deviceIds) assertTikTokDeviceEligible(database, deviceId);
    const campaignId = randomUUID();
    const now = Date.now();
    database.prepare(`
      INSERT INTO campaigns (id, platform, status, like_enabled, comment_enabled, created_at, updated_at)
      VALUES (?, 'tiktok', ?, ?, ?, ?, ?)
    `).run(campaignId, input.actions.comment ? "preparing" : "ready", Number(input.actions.like), Number(input.actions.comment), now, now);
    const profiles = commentProfiles(input);
    for (const [postIndex, value] of input.urls.entries()) {
      const { sourceUrl, normalizedUrl } = normalizeTikTokUrl(value);
      const postId = randomUUID();
      database.prepare(`
        INSERT INTO posts (
          id, campaign_id, position, source_url, normalized_url, final_url, status,
          context_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        postId,
        campaignId,
        postIndex + 1,
        sourceUrl,
        normalizedUrl,
        targets[postIndex].finalUrl,
        input.actions.comment ? "queued" : "ready",
        input.actions.comment ? "queued" : "ready",
        now,
        now,
      );
      for (const [deviceIndex, deviceId] of input.deviceIds.entries()) {
        const assignmentId = randomUUID();
        database.prepare(`
          INSERT INTO assignments (id, campaign_id, post_id, device_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(assignmentId, campaignId, postId, deviceId, input.actions.comment ? "pending" : "approved", now, now);
        if (input.actions.comment) {
          const profile = profiles[deviceIndex];
          database.prepare(`
            INSERT INTO comments (
              id, assignment_id, version, intention, tone, text, status, source, created_at, updated_at
            ) VALUES (?, ?, 1, ?, ?, '', 'pending', 'generated', ?, ?)
          `).run(randomUUID(), assignmentId, profile.intention, profile.tone, now, now);
        }
      }
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
    const assignments = database.prepare("SELECT id FROM assignments WHERE post_id = ? ORDER BY id")
      .all(post.id) as Array<{ id: string }>;
    if (!assignments.length) throw new TikTokError("ASSIGNMENT_NOT_FOUND", "La publicacion TikTok no tiene asignaciones.", 404);
    if (!input.overwriteManual) {
      const manual = database.prepare(`
        SELECT 1 FROM comments c
        WHERE c.assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
          AND c.version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = c.assignment_id)
          AND (c.source = 'manual' OR c.status = 'edited') LIMIT 1
      `).get(post.id);
      if (manual) throw new TikTokError("MANUAL_COMMENT_PRESENT", "Confirma antes de sobrescribir el comentario editado manualmente.", 409);
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

export function parseGeneratedTikTokComments(content: string, assignmentIds: string[], minWords: number, maxWords: number) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
  } catch {
    throw new TikTokError("INVALID_MODEL_RESPONSE", "DeepSeek devolvio JSON invalido.", 502);
  }
  const root = objectValue(parsed, "DeepSeek devolvio una respuesta invalida.");
  if (Object.keys(root).length !== 1 || !Array.isArray(root.comments) || root.comments.length !== assignmentIds.length) {
    throw new TikTokError("INVALID_MODEL_RESPONSE", "DeepSeek no devolvio la cantidad exacta de comentarios.", 502);
  }
  const expected = new Set(assignmentIds);
  const seen = new Set<string>();
  const comments = root.comments.map((value) => {
    const row = objectValue(value, "DeepSeek devolvio un comentario invalido.");
    if (Object.keys(row).length !== 2 || typeof row.assignmentId !== "string" || typeof row.text !== "string") {
      throw new TikTokError("INVALID_MODEL_RESPONSE", "Cada comentario debe identificar assignmentId y text.", 502);
    }
    const text = row.text.trim();
    const words = text.split(/\s+/u).filter(Boolean).length;
    if (!expected.has(row.assignmentId) || seen.has(row.assignmentId) || text.length < 2 || text.length > 500 || words < minWords || words > maxWords) {
      throw new TikTokError("INVALID_MODEL_RESPONSE", "DeepSeek devolvio comentarios fuera del contrato esperado.", 502);
    }
    seen.add(row.assignmentId);
    return { assignmentId: row.assignmentId, text };
  });
  if (seen.size !== expected.size) throw new TikTokError("INVALID_MODEL_RESPONSE", "Faltan asignaciones en la respuesta de DeepSeek.", 502);
  return comments;
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
  const request = objectValue(operation.request);
  const assignments = database.prepare("SELECT id FROM assignments WHERE post_id = ? ORDER BY id")
    .all(operation.postId) as Array<{ id: string }>;
  if (!assignments.length) throw new TikTokError("ASSIGNMENT_NOT_FOUND", "La publicacion TikTok no tiene asignaciones.", 404);
  const previous = assignments.map((assignment) => {
    const comment = currentComment(database, assignment.id);
    if (!comment) throw new TikTokError("COMMENT_NOT_FOUND", "Falta un comentario TikTok para una asignacion.", 404);
    return { assignmentId: assignment.id, comment };
  });
  if (!request.overwriteManual && previous.some((item) => item.comment.source === "manual" || item.comment.status === "edited")) {
    throw new TikTokError("MANUAL_COMMENT_PRESENT", "Confirma antes de sobrescribir los comentarios manuales.", 409);
  }
  if (!apiKey) throw new TikTokError("DEEPSEEK_NOT_CONFIGURED", "Falta API_DEEPSEEK en el servidor.", 503);
  const startedAt = Date.now();
  database.transaction(() => {
    database.prepare("UPDATE posts SET status = 'generating', error = NULL, updated_at = ? WHERE id = ?").run(startedAt, operation.postId);
    database.prepare("UPDATE assignments SET status = 'generating', updated_at = ? WHERE post_id = ?").run(startedAt, operation.postId);
    const commentUpdate = database.prepare("UPDATE comments SET status = 'generating', error = NULL, updated_at = ? WHERE id = ?");
    for (const item of previous) commentUpdate.run(startedAt, item.comment.id);
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
            content: `${appConfig.commentGenerationPrompt}\nDevuelve solo {"comments":[{"assignmentId":"...","text":"..."}]}. Genera exactamente un comentario por asignacion, de ${appConfig.commentMinWords} a ${appConfig.commentMaxWords} palabras y 2..500 caracteres.`,
          },
          { role: "user", content: JSON.stringify({ context: post.context, assignments: previous.map((item) => ({ id: item.assignmentId, intention: item.comment.intention, tone: item.comment.tone })) }) },
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
    const generated = parseGeneratedTikTokComments(content, previous.map((item) => item.assignmentId), appConfig.commentMinWords, appConfig.commentMaxWords);
    assertOperationNotCancelled(database, operationId, signal);
    database.transaction(() => {
      const currentHash = (database.prepare("SELECT context_hash FROM posts WHERE id = ?").get(operation.postId) as { context_hash: string | null }).context_hash;
      if (currentHash !== post.context_hash) throw new TikTokError("CONTEXT_CHANGED", "El contexto cambio durante la generacion.", 409);
      const now = Date.now();
      const insert = database.prepare(`
        INSERT INTO comments (
          id, assignment_id, version, intention, tone, text, status, stale, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 0, 'generated', ?, ?)
      `);
      const previousById = new Map(previous.map((item) => [item.assignmentId, item.comment]));
      for (const comment of generated) {
        const prior = previousById.get(comment.assignmentId)!;
        insert.run(randomUUID(), comment.assignmentId, prior.version + 1, prior.intention, prior.tone, comment.text, now, now);
      }
      database.prepare("UPDATE assignments SET status = 'draft', updated_at = ? WHERE post_id = ?").run(now, operation.postId);
      database.prepare("UPDATE posts SET status = 'ready', error = NULL, updated_at = ? WHERE id = ?").run(now, operation.postId);
      database.prepare(`
        UPDATE campaigns SET status = 'ready', updated_at = ?
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE campaign_id = ? AND status != 'ready')
      `).run(now, operation.campaignId, operation.campaignId);
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
      database.prepare("UPDATE assignments SET status = ?, updated_at = ? WHERE post_id = ?")
        .run(cancelled ? "pending" : "failed", now, operation.postId);
      database.prepare(`
        UPDATE comments SET status = 'failed', error = ?, updated_at = ?
        WHERE id IN (
          SELECT c.id FROM comments c WHERE c.assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
            AND c.version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = c.assignment_id)
            AND c.status = 'generating'
        )
      `).run(message, now, operation.postId);
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
    database.prepare(`
      UPDATE campaigns SET status = 'ready', updated_at = ?
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE campaign_id = ? AND status != 'ready')
    `).run(now, current.campaign_id, current.campaign_id);
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
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
  if (!Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) {
    throw new TikTokError("INVALID_CONFIRMATION", "La revision confirmada no es valida.");
  }
  const expectedActionsInput = objectValue(input.expectedActions, "expectedActions es obligatorio.");
  if (typeof expectedActionsInput.like !== "boolean" || typeof expectedActionsInput.comment !== "boolean") {
    throw new TikTokError("INVALID_CONFIRMATION", "Las acciones confirmadas no son validas.");
  }
  const actions = { like: expectedActionsInput.like, comment: expectedActionsInput.comment };
  if (!config.controlledAccount) {
    throw new TikTokError("CONTROLLED_ACCOUNT_NOT_CONFIGURED", "Configura la cuenta TikTok controlada antes de ejecutar.", 503);
  }
  const expectedAccountResourceId = requiredConfig(config.accountResourceId, "TIKTOK_ACCOUNT_RESOURCE_ID");
  const expectedPostContainerResourceId = requiredConfig(config.postContainerResourceId, "TIKTOK_POST_CONTAINER_RESOURCE_ID");
  const expectedPostUrlResourceId = requiredConfig(config.postUrlResourceId, "TIKTOK_POST_URL_RESOURCE_ID");
  const expectedCommentComposerResourceId = actions.comment ? requiredConfig(config.commentComposerResourceId, "TIKTOK_COMMENT_COMPOSER_RESOURCE_ID") : null;
  const expectedCommentEditorResourceId = actions.comment ? requiredConfig(config.commentEditorResourceId, "TIKTOK_COMMENT_EDITOR_RESOURCE_ID") : null;
  const expectedCommentSubmitResourceId = actions.comment ? requiredConfig(config.commentSubmitResourceId, "TIKTOK_COMMENT_SUBMIT_RESOURCE_ID") : null;
  const expectedCommentResultContainerResourceId = actions.comment ? requiredConfig(config.commentResultContainerResourceId, "TIKTOK_COMMENT_RESULT_CONTAINER_RESOURCE_ID") : null;
  if (!Array.isArray(input.assignments) || input.assignments.length < 1 || input.assignments.length > 1_000) {
    throw new TikTokError("INVALID_CONFIRMATION", "La confirmacion debe incluir cada asignacion.");
  }
  const confirmations = input.assignments.map((raw, index) => {
    const confirmation = objectValue(raw, `assignments[${index}] no es valida.`);
    const expectedTargetText = nonEmptyString(confirmation.expectedTargetText, `assignments[${index}].expectedTargetText`, 500);
    if (expectedTargetText.length < 5) {
      throw new TikTokError("TARGET_TEXT_INVALID", "Cada referencia visible debe tener al menos 5 caracteres.");
    }
    const expectedAccount = nonEmptyString(confirmation.expectedAccount, `assignments[${index}].expectedAccount`, 300);
    if (expectedAccount !== config.controlledAccount) {
      throw new TikTokError("CONTROLLED_ACCOUNT_CHANGED", "La cuenta TikTok controlada cambio o no esta configurada.", 409);
    }
    const expectedPostUrl = normalizeTikTokUrl(nonEmptyString(confirmation.expectedPostUrl, `assignments[${index}].expectedPostUrl`, 2_048)).sourceUrl;
    let expectedComment: null | { id: string; version: number; textHash: string } = null;
    if (confirmation.expectedComment !== null) {
      const comment = objectValue(confirmation.expectedComment, `assignments[${index}].expectedComment no es valido.`);
      if (!Number.isInteger(comment.version) || Number(comment.version) < 1 || typeof comment.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(comment.textHash)) {
        throw new TikTokError("INVALID_CONFIRMATION", "La version o hash del comentario no es valido.");
      }
      expectedComment = {
        id: nonEmptyString(comment.id, `assignments[${index}].expectedComment.id`, 200),
        version: Number(comment.version),
        textHash: comment.textHash,
      };
    }
    return {
      assignmentId: nonEmptyString(confirmation.assignmentId, `assignments[${index}].assignmentId`, 200),
      postId: nonEmptyString(confirmation.postId, `assignments[${index}].postId`, 200),
      deviceId: nonEmptyString(confirmation.deviceId, `assignments[${index}].deviceId`, 120),
      expectedAccount,
      expectedPostUrl,
      expectedTargetText,
      expectedComment,
    };
  });
  if (new Set(confirmations.map((confirmation) => confirmation.assignmentId)).size !== confirmations.length) {
    throw new TikTokError("INVALID_CONFIRMATION", "Cada asignacion debe confirmarse exactamente una vez.");
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
      SELECT a.id, a.post_id, a.device_id, a.status, p.position, p.status AS post_status,
        p.source_url, p.final_url, p.context_hash
      FROM assignments a JOIN posts p ON p.id = a.post_id
      JOIN device_profiles d ON d.device_id = a.device_id
      WHERE a.campaign_id = ? ORDER BY p.position, d.physical_order, a.id
    `).all(campaignId) as Array<{
      id: string;
      post_id: string;
      device_id: string;
      status: string;
      position: number;
      post_status: string;
      source_url: string;
      final_url: string | null;
      context_hash: string | null;
    }>;
    if (rows.length !== confirmations.length) {
      throw new TikTokError("CONFIRMED_TARGET_CHANGED", "La matriz confirmada no coincide con la campana.", 409);
    }
    const confirmationByAssignment = new Map(confirmations.map((confirmation) => [confirmation.assignmentId, confirmation]));
    const payloads = rows.map((row) => {
      canonicalTikTokPostUrl(row.final_url ?? row.source_url);
      const confirmation = confirmationByAssignment.get(row.id);
      const comment = campaign.comment_enabled ? currentComment(database, row.id) : undefined;
      if (!confirmation || confirmation.postId !== row.post_id || confirmation.deviceId !== row.device_id
        || normalizeTikTokUrl(confirmation.expectedPostUrl).normalizedUrl
          !== normalizeTikTokUrl(row.final_url ?? row.source_url).normalizedUrl) {
        throw new TikTokError("CONFIRMED_TARGET_CHANGED", "Una asignacion, dispositivo o URL efectiva cambio.", 409);
      }
      if (campaign.comment_enabled && (!comment || !confirmation.expectedComment
        || comment.id !== confirmation.expectedComment.id
        || comment.version !== confirmation.expectedComment.version
        || hashText(comment.text) !== confirmation.expectedComment.textHash
        || !["ready", "edited"].includes(comment.status) || comment.stale)) {
        throw new TikTokError("CONFIRMED_COMMENT_CHANGED", "Un comentario cambio o no esta listo; revisa y confirma de nuevo.", 409);
      }
      if (!campaign.comment_enabled && confirmation.expectedComment) {
        throw new TikTokError("CONFIRMED_COMMENT_CHANGED", "La confirmacion incluye un comentario no seleccionado.", 409);
      }
      const payload: TikTokPostExecutionPayload = {
        mode: "post",
        assignmentId: row.id,
        campaignId,
        postId: row.post_id,
        deviceId: row.device_id,
        expectedRevision: Number(input.expectedRevision),
        expectedAccount: confirmation.expectedAccount,
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
        expectedTargetText: confirmation.expectedTargetText,
        postUrl: row.final_url ?? row.source_url,
        contextHash: row.context_hash,
        actions,
        comment: confirmation.expectedComment && comment ? { ...confirmation.expectedComment, text: comment.text } : null,
        authorization: {
          publicEffects: true,
          controlledAccount: true,
          controlledContent: true,
          environmentGate: "TIKTOK_PUBLIC_EFFECTS_ENABLED",
        },
      };
      return { row, payload };
    });
    const first = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey,
      request: payloads[0].payload,
      campaignId,
      postId: payloads[0].row.post_id,
      assignmentId: payloads[0].row.id,
      deviceId: payloads[0].row.device_id,
    });
    if (first.replayed) {
      const previousJob = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(first.operation.id) as { id: string } | undefined;
      if (!previousJob) throw new Error("La autorizacion idempotente no conserva su job.");
      return { operation: first.operation, job: getJob(database, previousJob.id)!, replayed: true };
    }
    if (campaign.revision !== Number(input.expectedRevision)) {
      throw new TikTokError("CAMPAIGN_REVISION_CHANGED", "La campana cambio; revisa el contenido y confirma de nuevo.", 409);
    }
    if (Boolean(campaign.like_enabled) !== actions.like || Boolean(campaign.comment_enabled) !== actions.comment) {
      throw new TikTokError("CONFIRMED_ACTIONS_CHANGED", "Las acciones seleccionadas cambiaron.", 409);
    }
    if (campaign.status !== "ready" || rows.some((row) => row.post_status !== "ready" || !["draft", "approved", "failed", "cancelled"].includes(row.status))) {
      throw new TikTokError("CAMPAIGN_NOT_EXECUTABLE", "La campana TikTok no esta lista.", 409);
    }
    for (const row of rows) {
      const blocked = database.prepare(`
        SELECT EXISTS(
          SELECT 1 FROM operations WHERE assignment_id = ? AND kind = 'assignment.execute'
            AND status IN ('pending', 'running') AND id != ?
        ) AS active,
        EXISTS(
          SELECT 1 FROM assignment_action_results WHERE assignment_id = ?
            AND status IN ('effect_possible', 'outcome_unknown')
        ) AS uncertain
      `).get(row.id, first.operation.id, row.id) as { active: 0 | 1; uncertain: 0 | 1 };
      if (blocked.uncertain) throw new TikTokError("RECONCILIATION_REQUIRED", "Existe un efecto TikTok incierto que debe reconciliarse manualmente.", 409);
      if (blocked.active) throw new TikTokError("OPERATION_IN_PROGRESS", "La asignacion TikTok ya tiene una ejecucion activa.", 409);
    }
    const deviceIds = [...new Set(rows.map((row) => row.device_id))];
    for (const deviceId of deviceIds) assertTikTokDeviceEligible(database, deviceId);
    const now = Date.now();
    database.prepare("UPDATE assignments SET status = 'approved', scheduled_at = ?, completed_at = NULL, updated_at = ? WHERE campaign_id = ?")
      .run(now, now, campaignId);
    const insertAction = database.prepare(`
      INSERT INTO assignment_action_results (
        id, assignment_id, operation_id, action, status, result,
        comment_id, comment_version, text_hash, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let firstJob = null as ReturnType<typeof getJob>;
    for (const [index, item] of payloads.entries()) {
      const operation = index === 0 ? first.operation : createOperation(database, {
        kind: "assignment.execute",
        idempotencyKey: randomUUID(),
        request: item.payload,
        campaignId,
        postId: item.row.post_id,
        assignmentId: item.row.id,
        deviceId: item.row.device_id,
      }).operation;
      if (campaign.like_enabled) {
        const prior = database.prepare(`
          SELECT 1 FROM assignment_action_results
          WHERE assignment_id = ? AND action = 'like' AND status = 'confirmed' LIMIT 1
        `).get(item.row.id);
        insertAction.run(randomUUID(), item.row.id, operation.id, "like", prior ? "confirmed" : "pending", prior ? "preserved" : null, null, null, null, now, now, prior ? now : null);
      }
      if (campaign.comment_enabled) {
        insertAction.run(randomUUID(), item.row.id, operation.id, "comment", "pending", null, item.payload.comment!.id, item.payload.comment!.version, item.payload.comment!.textHash, now, now, null);
      }
      const job = enqueueJob(database, "assignment.execute", item.payload, {
        campaignId,
        postId: item.row.post_id,
        assignmentId: item.row.id,
        operationId: operation.id,
        priority: rows.length - item.row.position,
        maxAttempts: 1,
        effectPhase: "before_effect",
      });
      if (index === 0) firstJob = job;
    }
    touchCampaign(database, campaignId, now);
    return { operation: first.operation, job: firstJob!, replayed: false };
  }).immediate();
}

export function requestTikTokLiveExecution(database: Database.Database, value: unknown, config = readTikTokConfig()) {
  const input = validateTikTokLiveRequest(value);
  if (!config.liveEffectsEnabled) {
    throw new TikTokError("TIKTOK_LIVE_EFFECTS_DISABLED", "TikTok Live esta deshabilitado; configura TIKTOK_LIVE_EFFECTS_ENABLED=true.", 503);
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
      if (payload.mode !== "live") throw new IdempotencyConflictError();
      const persisted = (database.prepare(`
        SELECT request_json FROM operations WHERE campaign_id = ? AND kind = 'assignment.execute'
        ORDER BY created_at, id
      `).all(payload.campaignId) as Array<{ request_json: string }>).map((row) => {
        const execution = JSON.parse(row.request_json) as TikTokLiveExecutionPayload;
        return {
          deviceId: execution.deviceId,
          expectedAccount: execution.expectedAccount,
          expectedTargetText: execution.expectedTargetText,
          rounds: execution.rounds,
          url: execution.liveUrl,
          x: execution.x,
          y: execution.y,
        };
      });
      const requested = input.urls.flatMap((rawUrl, postIndex) => {
        const normalized = normalizeTikTokLiveUrl(rawUrl);
        return input.deviceIds.map((deviceId) => {
          const calibration = getTikTokLiveCalibration(database, deviceId, config);
          if (!calibration) return null;
          return {
            deviceId,
            expectedAccount: input.expectedAccount,
            expectedTargetText: input.targetTexts[postIndex],
            rounds: input.rounds,
            url: normalized.sourceUrl,
            x: calibration.x,
            y: calibration.y,
          };
        });
      });
      if (persisted.length !== requested.length || requested.some((item) => !item)
        || stableJson(persisted) !== stableJson(requested)) {
        throw new IdempotencyConflictError();
      }
      const jobRow = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(operation.id) as { id: string } | undefined;
      if (!jobRow) throw new Error("La autorizacion Live idempotente no conserva su job.");
      return { operation, job: getJob(database, jobRow.id)!, campaign: getTikTokCampaignSnapshot(database, payload.campaignId), replayed: true };
    }
    const calibrations = new Map<string, { deviceId: string; x: number; y: number }>();
    for (const deviceId of input.deviceIds) {
      const calibration = getTikTokLiveCalibration(database, deviceId, config);
      if (!calibration) {
        throw new TikTokError("TIKTOK_LIVE_CALIBRATION_REQUIRED", `El dispositivo ${deviceId} no tiene calibracion Live validada.`, 409);
      }
      calibrations.set(deviceId, calibration);
    }
    for (const deviceId of input.deviceIds) {
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
            WHERE o.device_id = ? AND o.kind = 'assignment.execute'
              AND json_extract(o.request_json, '$.mode') = 'live'
              AND a.status = 'outcome_unknown'
          ) AS uncertain
      `).get(deviceId, deviceId) as { active: 0 | 1; uncertain: 0 | 1 };
      if (blocked.active) throw new TikTokError("TIKTOK_LIVE_IN_PROGRESS", "Ya existe una ejecucion Live activa para este dispositivo.", 409);
      if (blocked.uncertain) throw new TikTokError("TIKTOK_LIVE_RECONCILIATION_REQUIRED", "Este dispositivo conserva una ronda incierta y no puede repetirse.", 409);
      assertTikTokDeviceEligible(database, deviceId);
    }
    const campaignId = randomUUID();
    const now = Date.now();
    database.prepare(`
      INSERT INTO campaigns (id, platform, status, like_enabled, comment_enabled, created_at, updated_at)
      VALUES (?, 'tiktok', 'ready', 0, 0, ?, ?)
    `).run(campaignId, now, now);
    const rows = input.urls.flatMap((rawUrl, postIndex) => {
      const normalized = normalizeTikTokLiveUrl(rawUrl);
      const postId = randomUUID();
      database.prepare(`
        INSERT INTO posts (
          id, campaign_id, position, source_url, normalized_url, status, context_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'ready', 'ready', ?, ?)
      `).run(postId, campaignId, postIndex + 1, normalized.sourceUrl, normalized.normalizedUrl, now, now);
      return input.deviceIds.map((deviceId) => {
        const assignmentId = randomUUID();
        database.prepare(`
          INSERT INTO assignments (id, campaign_id, post_id, device_id, status, scheduled_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)
        `).run(assignmentId, campaignId, postId, deviceId, now, now, now);
        const calibration = calibrations.get(deviceId)!;
        return {
          row: { id: assignmentId, post_id: postId, device_id: deviceId, position: postIndex + 1 },
          payload: {
            mode: "live",
            assignmentId,
            campaignId,
            postId,
            deviceId,
            expectedRevision: 1,
            expectedAccount: input.expectedAccount,
            expectedAccountResourceId,
            expectedLiveContainerResourceId,
            expectedLiveUrlResourceId,
            expectedTargetText: input.targetTexts[postIndex],
            liveUrl: normalized.sourceUrl,
            rounds: input.rounds,
            x: calibration.x,
            y: calibration.y,
            authorization: {
              publicEffects: true,
              controlledAccount: true,
              controlledContent: true,
              calibratedCoordinates: true,
              calibration,
              environmentGate: "TIKTOK_LIVE_EFFECTS_ENABLED",
            },
          } satisfies TikTokLiveExecutionPayload,
        };
      });
    });
    const first = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: input.idempotencyKey,
      request: rows[0].payload,
      campaignId,
      postId: rows[0].row.post_id,
      assignmentId: rows[0].row.id,
      deviceId: rows[0].row.device_id,
    });
    if (first.replayed) {
      const jobRow = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(first.operation.id) as { id: string } | undefined;
      if (!jobRow) throw new Error("La autorizacion Live idempotente no conserva su job.");
      return { operation: first.operation, job: getJob(database, jobRow.id)!, campaign: getTikTokCampaignSnapshot(database, campaignId), replayed: true };
    }
    let firstJob = null as ReturnType<typeof getJob>;
    for (const [index, item] of rows.entries()) {
      const operation = index === 0 ? first.operation : createOperation(database, {
        kind: "assignment.execute",
        idempotencyKey: randomUUID(),
        request: item.payload,
        campaignId,
        postId: item.row.post_id,
        assignmentId: item.row.id,
        deviceId: item.row.device_id,
      }).operation;
      const job = enqueueJob(database, "assignment.execute", item.payload, {
        campaignId,
        postId: item.row.post_id,
        assignmentId: item.row.id,
        operationId: operation.id,
        priority: rows.length - item.row.position,
        maxAttempts: 1,
        effectPhase: "before_effect",
      });
      if (index === 0) firstJob = job;
    }
    return { operation: first.operation, job: firstJob!, campaign: getTikTokCampaignSnapshot(database, campaignId), replayed: false };
  }).immediate();
}

const TERMINAL_ASSIGNMENTS = new Set(["sent", "failed", "outcome_unknown", "cancelled"]);

function reducedPostStatus(statuses: string[]) {
  if (statuses.includes("outcome_unknown")) return "outcome_unknown";
  if (statuses.every((status) => status === "sent")) return "completed";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  if (statuses.every((status) => TERMINAL_ASSIGNMENTS.has(status))) return "partial_failed";
  if (statuses.some((status) => ["running", "cancellation_requested", "sent", "failed", "cancelled"].includes(status))) return "running";
  if (statuses.some((status) => status === "scheduled")) return "scheduled";
  if (statuses.some((status) => status === "approved")) return "ready";
  return null;
}

export function reduceTikTokCampaignExecution(database: Database.Database, campaignId: string, now = Date.now()) {
  const campaign = database.prepare("SELECT status FROM campaigns WHERE id = ? AND platform = 'tiktok'")
    .get(campaignId) as { status: string } | undefined;
  const assignments = database.prepare(`
    SELECT a.post_id, a.status FROM assignments a
    JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.campaign_id = ? AND c.platform = 'tiktok'
  `).all(campaignId) as Array<{ post_id: string; status: string }>;
  if (!campaign || !assignments.length) throw new TikTokError("CAMPAIGN_NOT_FOUND", "La campana TikTok no existe.", 404);
  const byPost = Map.groupBy(assignments, (assignment) => assignment.post_id);
  for (const [postId, rows] of byPost) {
    const status = reducedPostStatus(rows.map((row) => row.status));
    if (status) database.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, now, postId);
  }
  const statuses = assignments.map((assignment) => assignment.status);
  const allTerminal = statuses.every((status) => TERMINAL_ASSIGNMENTS.has(status));
  const hasCleanupErrors = Boolean(database.prepare(`
    SELECT 1 FROM operations
    WHERE campaign_id = ? AND kind = 'assignment.execute'
      AND cleanup_status IN ('failed', 'outcome_unknown')
    LIMIT 1
  `).get(campaignId));
  const campaignStatus = campaign.status === "cancellation_requested" && !allTerminal
    ? "cancellation_requested"
    : statuses.every((status) => status === "sent")
      ? hasCleanupErrors ? "completed_with_issues" : "completed"
      : statuses.every((status) => status === "cancelled")
        ? hasCleanupErrors ? "cancelled_with_cleanup_errors" : "cancelled"
        : allTerminal
          ? "completed_with_issues"
          : statuses.some((status) => ["running", "cancellation_requested", "sent", "failed", "outcome_unknown", "cancelled"].includes(status))
            ? "running"
            : statuses.some((status) => status === "scheduled")
              ? "scheduled"
              : statuses.some((status) => status === "approved")
                ? "ready"
                : null;
  if (campaignStatus) {
    const completedAt = ["completed", "completed_with_issues", "cancelled", "cancelled_with_cleanup_errors"].includes(campaignStatus) ? now : null;
    database.prepare(`
      UPDATE campaigns SET status = ?, completed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?
    `).run(campaignStatus, completedAt, now, campaignId);
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
  const assignments = database.prepare(`
    SELECT a.id, a.post_id, a.device_id, a.status, a.scheduled_at, a.actual_at,
      p.physical_order
    FROM assignments a JOIN device_profiles p ON p.device_id = a.device_id
    JOIN posts post ON post.id = a.post_id
    WHERE a.campaign_id = ?
    ORDER BY post.position, p.physical_order, a.id
  `).all(campaignId) as Array<{
    id: string;
    post_id: string;
    device_id: string;
    status: string;
    scheduled_at: number | null;
    actual_at: number | null;
    physical_order: number;
  }>;
  if (!assignments.length) return null;
  const comments = database.prepare(`
    SELECT c.id, c.assignment_id, c.version, c.intention, c.tone, c.text,
      c.status, c.stale, c.source, c.error
    FROM comments c
    JOIN (
      SELECT assignment_id, MAX(version) AS version FROM comments GROUP BY assignment_id
    ) current ON current.assignment_id = c.assignment_id AND current.version = c.version
    JOIN assignments a ON a.id = c.assignment_id
    WHERE a.campaign_id = ?
  `).all(campaignId) as Array<{
    id: string;
    assignment_id: string;
    version: number;
    intention: string;
    tone: string;
    text: string;
    status: string;
    stale: 0 | 1;
    source: string;
    error: string | null;
  }>;
  const commentByAssignment = new Map(comments.map((comment) => [comment.assignment_id, comment]));
  const assignmentsByPost = Map.groupBy(assignments, (assignment) => assignment.post_id);
  const posts = database.prepare("SELECT * FROM posts WHERE campaign_id = ? ORDER BY position")
    .all(campaignId) as Array<Record<string, unknown> & {
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
    }>;
  const executionRows = database.prepare(`
    SELECT o.id, o.assignment_id, o.request_json, o.status, o.effect_phase, o.session_status,
      o.cleanup_status, o.error, o.created_at, j.attempts
    FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id
    WHERE o.campaign_id = ? AND o.kind = 'assignment.execute'
    ORDER BY o.created_at DESC, o.id DESC
  `).all(campaignId) as Array<{
    id: string;
    assignment_id: string;
    request_json: string;
    status: string;
    effect_phase: string;
    session_status: string;
    cleanup_status: string;
    error: string | null;
    created_at: number;
    attempts: number | null;
  }>;
  const latestExecution = new Map<string, (typeof executionRows)[number]>();
  for (const execution of executionRows) {
    if (!latestExecution.has(execution.assignment_id)) latestExecution.set(execution.assignment_id, execution);
  }
  const liveExecutions = executionRows.filter((execution) => {
    const payload = JSON.parse(execution.request_json) as Partial<TikTokExecutionPayload>;
    return payload.mode === "live";
  });
  const actionRows = database.prepare(`
    SELECT r.operation_id, r.action, r.status, r.result, r.error
    FROM assignment_action_results r
    JOIN assignments a ON a.id = r.assignment_id
    WHERE a.campaign_id = ?
  `).all(campaignId) as Array<{
    operation_id: string;
    action: "like" | "comment";
    status: string;
    result: string | null;
    error: string | null;
  }>;
  const actionByExecution = new Map(actionRows.map((action) => [`${action.operation_id}:${action.action}`, action]));
  const evidenceRows = database.prepare(`
    SELECT e.operation_id, e.checkpoint_id, e.kind, e.path, e.created_at
    FROM evidence e JOIN operations o ON o.id = e.operation_id
    WHERE o.campaign_id = ? ORDER BY e.created_at
  `).all(campaignId) as Array<{
    operation_id: string;
    checkpoint_id: string | null;
    kind: "metadata" | "screenshot" | "page_source";
    path: string;
    created_at: number;
  }>;
  const evidenceByExecution = Map.groupBy(evidenceRows, (evidence) => evidence.operation_id);
  const checkpointRows = database.prepare(`
    SELECT c.operation_id, c.id, c.phase, c.sequence, c.created_at
    FROM checkpoints c JOIN operations o ON o.id = c.operation_id
    WHERE o.campaign_id = ? ORDER BY c.created_at, c.sequence
  `).all(campaignId) as Array<{
    operation_id: string;
    id: string;
    phase: string;
    sequence: number;
    created_at: number;
  }>;
  const checkpointsByExecution = Map.groupBy(checkpointRows, (checkpoint) => checkpoint.operation_id);
  const livePosts = posts.some((post) => /^\/@[^/]+\/live$/u.test(new URL(post.normalized_url).pathname));
  const mode = liveExecutions.length || livePosts ? "live" : "post";
  return {
    id: campaign.id,
    platform: "tiktok" as const,
    mode,
    status: campaign.status,
    revision: campaign.revision,
    cancellationReason: campaign.cancellation_reason,
    actions: { like: Boolean(campaign.like_enabled), comment: Boolean(campaign.comment_enabled) },
    controlledAccount: readTikTokConfig().controlledAccount || null,
    deviceIds: [...new Set(assignments.map((assignment) => assignment.device_id))],
    createdAt: campaign.created_at,
    updatedAt: campaign.updated_at,
    posts: posts.map((post) => {
      const postAssignments = assignmentsByPost.get(post.id) ?? [];
      const postComments = postAssignments
        .map((assignment) => commentByAssignment.get(assignment.id))
        .filter((comment): comment is NonNullable<typeof comment> => Boolean(comment));
      return {
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
        comments: postComments.map((comment) => ({
          id: comment.id,
          assignmentId: comment.assignment_id,
          deviceId: assignments.find((assignment) => assignment.id === comment.assignment_id)!.device_id,
          version: comment.version,
          intention: comment.intention,
          tone: comment.tone,
          text: comment.text,
          status: comment.status,
          stale: Boolean(comment.stale),
          source: comment.source,
          textHash: hashText(comment.text),
          error: comment.error,
        })),
      };
    }),
    assignments: assignments.map((assignment) => {
      const execution = latestExecution.get(assignment.id);
      const executionPayload = execution ? JSON.parse(execution.request_json) as Partial<TikTokExecutionPayload> : null;
      const action = (name: "like" | "comment") => {
        const row = actionByExecution.get(`${execution!.id}:${name}`);
        return row ? { status: row.status, result: row.result, error: row.error } : null;
      };
      const like = execution ? action("like") : null;
      const commentAction = execution ? action("comment") : null;
      const checkpoints = execution ? (checkpointsByExecution.get(execution.id) ?? []) : [];
      const evidence = execution ? (evidenceByExecution.get(execution.id) ?? []) : [];
      return {
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
      };
    }),
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
