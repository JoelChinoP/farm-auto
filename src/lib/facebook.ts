import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import { appConfig } from "./config.ts";
import { CURRENT_SETUP_REVISION } from "./device-runtime.ts";
import { completeOperation, createOperation, getOperation, stableJson } from "./operations.ts";
import { enqueueJob, getJob, requestJobCancellation } from "./queue.ts";

export const FACEBOOK_TONES = ["Cercano", "Entusiasta", "Informativo", "Breve"] as const;
export const FACEBOOK_APP_PACKAGE = "com.facebook.katana";

export class FacebookError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FacebookError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type FacebookCampaignRequest = {
  urls: string[];
  deviceIds: string[];
  actions: { like: boolean; comment: boolean };
  distribution: Array<{ intention: string; tone: string; count: number }>;
};

type NormalizedFacebookUrl = { sourceUrl: string; normalizedUrl: string };
type FacebookExtraction = { context: string; finalUrl: string; extractorVersion: string };
export type FacebookExtractor = {
  extract(url: string, signal?: AbortSignal): Promise<FacebookExtraction>;
};
export type DeepSeekFetch = typeof fetch;

function objectValue(value: unknown, message = "El payload debe ser un objeto JSON.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FacebookError("INVALID_REQUEST", message);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string, maxLength: number) {
  if (typeof value !== "string") throw new FacebookError("INVALID_REQUEST", `${name} es obligatorio.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new FacebookError("INVALID_REQUEST", `${name} no es valido.`);
  }
  return normalized;
}

export function normalizeFacebookUrl(value: string): NormalizedFacebookUrl {
  if (typeof value !== "string" || !value || value.length > 2_048 || /["'\u0000-\u001f\u007f]/u.test(value)) {
    throw new FacebookError("INVALID_FACEBOOK_URL", "El enlace contiene caracteres no permitidos.");
  }

  let source: URL;
  try {
    source = new URL(value);
  } catch {
    throw new FacebookError("INVALID_FACEBOOK_URL", "El enlace de Facebook no es valido.");
  }
  const hostname = source.hostname.toLowerCase();
  const allowed = hostname === "facebook.com" || hostname.endsWith(".facebook.com") || hostname === "fb.watch";
  if (source.protocol !== "https:") {
    throw new FacebookError("INVALID_FACEBOOK_URL", "El enlace debe usar HTTPS.");
  }
  if (source.username || source.password || source.port) {
    throw new FacebookError("INVALID_FACEBOOK_URL", "El enlace no puede incluir credenciales ni puertos no estandar.");
  }
  if (!allowed) {
    throw new FacebookError("INVALID_FACEBOOK_URL", "El dominio no pertenece a Facebook.");
  }

  source.hash = "";
  const sourceUrl = source.toString();
  const normalized = new URL(sourceUrl);
  if (hostname === "facebook.com" || hostname.endsWith(".facebook.com")) normalized.hostname = "www.facebook.com";
  for (const parameter of ["__cft__", "__tn__", "fbclid", "mibextid", "ref", "refsrc"]) {
    normalized.searchParams.delete(parameter);
  }
  normalized.searchParams.sort();
  if (normalized.pathname.length > 1) normalized.pathname = normalized.pathname.replace(/\/+$/u, "");
  return { sourceUrl, normalizedUrl: normalized.toString() };
}

export function validateFacebookCampaignRequest(value: unknown): FacebookCampaignRequest {
  const input = objectValue(value);
  if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 10) {
    throw new FacebookError("INVALID_FACEBOOK_URLS", "La campana requiere entre 1 y 10 URLs.");
  }
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  for (const rawUrl of input.urls) {
    if (typeof rawUrl !== "string") throw new FacebookError("INVALID_FACEBOOK_URL", "Cada URL debe ser texto.");
    const normalized = normalizeFacebookUrl(rawUrl);
    if (seenUrls.has(normalized.normalizedUrl)) {
      throw new FacebookError("DUPLICATE_FACEBOOK_URL", "La lista contiene publicaciones duplicadas.");
    }
    seenUrls.add(normalized.normalizedUrl);
    urls.push(normalized.sourceUrl);
  }

  if (!Array.isArray(input.deviceIds) || input.deviceIds.length < 1 || input.deviceIds.length > 100) {
    throw new FacebookError("INVALID_DEVICE_SELECTION", "Selecciona al menos un dispositivo elegible.");
  }
  const deviceIds = input.deviceIds.map((deviceId, index) => nonEmptyString(deviceId, `deviceIds[${index}]`, 120));
  if (new Set(deviceIds).size !== deviceIds.length) {
    throw new FacebookError("DUPLICATE_DEVICE", "Cada dispositivo solo puede seleccionarse una vez.");
  }

  const rawActions = objectValue(input.actions, "actions es obligatorio.");
  if (typeof rawActions.like !== "boolean" || typeof rawActions.comment !== "boolean") {
    throw new FacebookError("INVALID_ACTIONS", "Like y Comentario deben ser valores booleanos.");
  }
  const actions = { like: rawActions.like, comment: rawActions.comment };
  if (!actions.like && !actions.comment) throw new FacebookError("INVALID_ACTIONS", "Selecciona al menos una accion.");

  if (!actions.comment) return { urls, deviceIds, actions, distribution: [] };
  if (!Array.isArray(input.distribution) || input.distribution.length < 1 || input.distribution.length > 20) {
    throw new FacebookError("INVALID_DISTRIBUTION", "La distribucion de comentarios no es valida.");
  }
  const distribution = input.distribution.map((value, index) => {
    const row = objectValue(value, `distribution[${index}] no es valida.`);
    const intention = nonEmptyString(row.intention, `distribution[${index}].intention`, 300);
    if (typeof row.tone !== "string" || !FACEBOOK_TONES.includes(row.tone as (typeof FACEBOOK_TONES)[number])) {
      throw new FacebookError("INVALID_DISTRIBUTION", `distribution[${index}].tone no es valido.`);
    }
    if (!Number.isInteger(row.count) || Number(row.count) < 1 || Number(row.count) > deviceIds.length) {
      throw new FacebookError("INVALID_DISTRIBUTION", `distribution[${index}].count no es valido.`);
    }
    return { intention, tone: row.tone, count: Number(row.count) };
  });
  if (distribution.reduce((total, row) => total + row.count, 0) !== deviceIds.length) {
    throw new FacebookError("INVALID_DISTRIBUTION", "La distribucion debe cubrir exactamente los dispositivos elegidos.");
  }
  return { urls, deviceIds, actions, distribution };
}

export function assertFacebookCampaignDevicesEligible(
  database: Database.Database,
  deviceIds: string[],
  options: { allowBusy?: boolean } = {},
) {
  const rows = database.prepare(`
    SELECT p.device_id, p.hardware_id, o.connection, o.hardware_id AS observed_hardware_id,
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
  `);
  for (const deviceId of deviceIds) {
    const row = rows.get(CURRENT_SETUP_REVISION, deviceId) as {
      device_id: string;
      hardware_id: string;
      connection: string | null;
      observed_hardware_id: string | null;
      packages_json: string | null;
      preparation_status: string | null;
      retirement_status: string | null;
      busy: 0 | 1;
    } | undefined;
    if (!row) throw new FacebookError("DEVICE_NOT_ALLOWLISTED", `El dispositivo ${deviceId} no esta registrado.`, 409);
    if (row.retirement_status) throw new FacebookError("DEVICE_RETIRED", `El dispositivo ${deviceId} esta retirado o pendiente de retiro.`, 409);
    if (row.connection !== "connected") throw new FacebookError("DEVICE_NOT_CONNECTED", `El dispositivo ${deviceId} no esta conectado.`, 409);
    if (row.hardware_id !== row.observed_hardware_id) {
      throw new FacebookError("DEVICE_IDENTITY_MISMATCH", `No se pudo confirmar la identidad de ${deviceId}.`, 409);
    }
    if (row.preparation_status !== "ready") throw new FacebookError("DEVICE_NOT_READY", `El dispositivo ${deviceId} no esta preparado.`, 409);
    if (row.busy && !options.allowBusy) throw new FacebookError("DEVICE_BUSY", `El dispositivo ${deviceId} no esta disponible para Farm Appium.`, 409);
    const packages = row.packages_json ? JSON.parse(row.packages_json) as unknown : [];
    if (!Array.isArray(packages) || !packages.includes(FACEBOOK_APP_PACKAGE)) {
      throw new FacebookError("FACEBOOK_NOT_INSTALLED", `Facebook no esta instalado en ${deviceId}.`, 409);
    }
  }
}

function commentProfiles(input: FacebookCampaignRequest) {
  const profiles: Array<{ deviceId: string; intention: string; tone: string }> = [];
  let deviceIndex = 0;
  for (const row of input.distribution) {
    for (let index = 0; index < row.count; index++) {
      profiles.push({ deviceId: input.deviceIds[deviceIndex++], intention: row.intention, tone: row.tone });
    }
  }
  return profiles;
}

export function touchFacebookCampaign(database: Database.Database, campaignId: string, now = Date.now()) {
  database.prepare("UPDATE campaigns SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, campaignId);
}

const touchCampaign = touchFacebookCampaign;

function normalizeAccountLabel(value: string) {
  return nonEmptyString(value, "accountLabel", 300).normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("es");
}

export function recordFacebookDeviceIdentity(
  database: Database.Database,
  deviceId: string,
  accountLabel: string,
  now = Date.now(),
) {
  const normalizedDeviceId = nonEmptyString(deviceId, "deviceId", 120);
  const label = nonEmptyString(accountLabel, "accountLabel", 300);
  const fingerprint = createHash("sha256").update(normalizeAccountLabel(label)).digest("hex");
  const existing = database.prepare("SELECT account_fingerprint FROM facebook_device_identities WHERE device_id = ?")
    .get(normalizedDeviceId) as { account_fingerprint: string } | undefined;
  if (existing?.account_fingerprint !== undefined && existing.account_fingerprint !== fingerprint) {
    const active = database.prepare(`
      SELECT 1 FROM jobs j JOIN operations o ON o.id = j.operation_id
      WHERE o.device_id = ? AND j.status IN ('pending', 'running') LIMIT 1
    `).get(normalizedDeviceId);
    if (active) throw new FacebookError("FACEBOOK_ACCOUNT_LOCKED", "La cuenta no puede cambiar mientras el dispositivo tiene trabajo programado.", 409);
  }
  const result = database.prepare(`
    INSERT INTO facebook_device_identities (
      device_id, account_label, account_fingerprint, verified_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      account_label = excluded.account_label,
      account_fingerprint = excluded.account_fingerprint,
      verified_at = excluded.verified_at,
      updated_at = excluded.updated_at
  `).run(normalizedDeviceId, label, fingerprint, now, now);
  if (result.changes !== 1) throw new Error("No se pudo guardar la identidad Facebook del dispositivo.");
  return { deviceId: normalizedDeviceId, accountLabel: label, accountFingerprint: fingerprint, verifiedAt: now };
}

export function freezeFacebookCampaignManifest(
  database: Database.Database,
  campaignId: string,
  scheduledAt: number,
  allowSharedAccounts = false,
) {
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0) {
    throw new FacebookError("INVALID_SCHEDULE", "La fecha programada no es valida.");
  }
  return database.transaction(() => {
    const existing = database.prepare("SELECT * FROM facebook_campaign_manifests WHERE campaign_id = ?")
      .get(campaignId) as (Record<string, unknown> & { scheduled_at: number; allow_shared_accounts: 0 | 1 }) | undefined;
    if (existing) {
      if (existing.scheduled_at !== scheduledAt || Boolean(existing.allow_shared_accounts) !== allowSharedAccounts) {
        throw new FacebookError("SCHEDULE_ALREADY_FROZEN", "El plan ya fue congelado con otros parametros.", 409);
      }
      return existing;
    }
    const campaign = database.prepare(`
      SELECT status, revision FROM campaigns WHERE id = ? AND platform = 'facebook'
    `).get(campaignId) as { status: string; revision: number } | undefined;
    if (!campaign) throw new FacebookError("CAMPAIGN_NOT_FOUND", "La campana no existe.", 404);
    if (campaign.status !== "ready") {
      throw new FacebookError("CAMPAIGN_NOT_READY", "La campana debe estar lista antes de programarla.", 409);
    }
    const posts = database.prepare(`
      SELECT id, position, COALESCE(final_url, source_url) AS url, context_hash
      FROM posts WHERE campaign_id = ? ORDER BY position, id
    `).all(campaignId) as Array<{ id: string; position: number; url: string; context_hash: string | null }>;
    const assignments = database.prepare(`
      SELECT a.id, a.post_id, a.device_id, a.status, p.position AS post_position,
        d.physical_order, i.account_label, i.account_fingerprint
      FROM assignments a
      JOIN posts p ON p.id = a.post_id
      JOIN device_profiles d ON d.device_id = a.device_id
      LEFT JOIN facebook_device_identities i ON i.device_id = a.device_id
      WHERE a.campaign_id = ?
      ORDER BY p.position, d.physical_order, a.id
    `).all(campaignId) as Array<{
      id: string;
      post_id: string;
      device_id: string;
      status: string;
      post_position: number;
      physical_order: number;
      account_label: string | null;
      account_fingerprint: string | null;
    }>;
    const devices = [...new Map(assignments.map((assignment) => [assignment.device_id, {
      id: assignment.device_id,
      physicalOrder: assignment.physical_order,
      accountLabel: assignment.account_label,
      accountFingerprint: assignment.account_fingerprint,
    }])).values()].toSorted((left, right) => left.physicalOrder - right.physicalOrder);
    if (!posts.length || assignments.length !== posts.length * devices.length
      || assignments.some((assignment) => assignment.status !== "approved")) {
      throw new FacebookError("CAMPAIGN_NOT_READY", "La matriz de asignaciones no esta completa y aprobada.", 409);
    }
    if (devices.some((device) => !device.accountFingerprint)) {
      throw new FacebookError("FACEBOOK_ACCOUNT_IDENTITY_REQUIRED", "Verifica la cuenta Facebook de cada dispositivo antes de programar.", 409);
    }
    const collisions = Map.groupBy(devices, (device) => device.accountFingerprint!);
    const shared = [...collisions.values()].filter((group) => group.length > 1);
    const activeShared = database.prepare(`
      SELECT DISTINCT i.device_id
      FROM facebook_device_identities i
      JOIN operations o ON o.device_id = i.device_id
      JOIN jobs j ON j.operation_id = o.id
      WHERE j.status IN ('pending', 'running')
        AND i.account_fingerprint IN (${devices.map(() => "?").join(", ")})
        AND i.device_id NOT IN (${devices.map(() => "?").join(", ")})
    `).all(
      ...devices.map((device) => device.accountFingerprint),
      ...devices.map((device) => device.id),
    ) as Array<{ device_id: string }>;
    if ((shared.length || activeShared.length) && !allowSharedAccounts) {
      throw new FacebookError("FACEBOOK_ACCOUNT_COLLISION", "Dos o mas dispositivos apuntan a la misma cuenta Facebook.", 409, {
        devices: [...new Set([
          ...shared.flatMap((group) => group.map((device) => device.id)),
          ...activeShared.map((device) => device.device_id),
        ])],
      });
    }
    const nextRevision = campaign.revision + 1;
    const now = Date.now();
    const frozenPosts = posts.map((post) => ({
      id: post.id,
      position: post.position,
      url: post.url,
      contextHash: post.context_hash,
    }));
    const frozenDevices = devices.map((device) => ({
      id: device.id,
      physicalOrder: device.physicalOrder,
      accountLabel: device.accountLabel,
      accountFingerprint: device.accountFingerprint,
    }));
    const frozenAssignments = assignments.map((assignment) => ({
      id: assignment.id,
      postId: assignment.post_id,
      deviceId: assignment.device_id,
      postPosition: assignment.post_position,
      deviceOrder: assignment.physical_order,
    }));
    database.prepare(`
      INSERT INTO facebook_campaign_manifests (
        campaign_id, campaign_revision, scheduled_at, posts_json, devices_json,
        assignments_json, allow_shared_accounts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      campaignId,
      nextRevision,
      scheduledAt,
      stableJson(frozenPosts),
      stableJson(frozenDevices),
      stableJson(frozenAssignments),
      Number(allowSharedAccounts),
      now,
    );
    const insertSchedule = database.prepare(`
      INSERT INTO schedules (id, assignment_id, scheduled_at, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `);
    for (const assignment of assignments) insertSchedule.run(randomUUID(), assignment.id, scheduledAt, now, now);
    database.prepare(`
      UPDATE assignments SET status = 'scheduled', scheduled_at = ?, updated_at = ?
      WHERE campaign_id = ?
    `).run(scheduledAt, now, campaignId);
    database.prepare("UPDATE posts SET status = 'scheduled', updated_at = ? WHERE campaign_id = ?")
      .run(now, campaignId);
    database.prepare(`
      UPDATE campaigns SET status = 'scheduled', revision = ?, updated_at = ?, completed_at = NULL WHERE id = ?
    `).run(nextRevision, now, campaignId);
    return database.prepare("SELECT * FROM facebook_campaign_manifests WHERE campaign_id = ?").get(campaignId) as Record<string, unknown>;
  }).immediate();
}

const TERMINAL_ASSIGNMENT_STATUSES = new Set(["sent", "failed", "outcome_unknown", "cancelled"]);

function reducedPostStatus(statuses: string[]) {
  if (statuses.includes("outcome_unknown")) return "outcome_unknown";
  if (statuses.every((status) => status === "sent")) return "completed";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  if (statuses.every((status) => TERMINAL_ASSIGNMENT_STATUSES.has(status))) return "partial_failed";
  if (statuses.some((status) => ["running", "cancellation_requested", "sent", "failed", "cancelled"].includes(status))) return "running";
  if (statuses.some((status) => status === "scheduled")) return "scheduled";
  if (statuses.some((status) => status === "approved")) return "ready";
  return null;
}

export function reduceFacebookCampaignExecution(database: Database.Database, campaignId: string, now = Date.now()) {
  const campaign = database.prepare("SELECT status FROM campaigns WHERE id = ? AND platform = 'facebook'")
    .get(campaignId) as { status: string } | undefined;
  const assignments = database.prepare(`
    SELECT a.post_id, a.status FROM assignments a
    JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.campaign_id = ? AND c.platform = 'facebook'
  `).all(campaignId) as Array<{ post_id: string; status: string }>;
  if (!campaign || !assignments.length) throw new FacebookError("CAMPAIGN_NOT_FOUND", "La campana no existe.", 404);
  const byPost = Map.groupBy(assignments, (assignment) => assignment.post_id);
  for (const [postId, rows] of byPost) {
    const status = reducedPostStatus(rows.map((row) => row.status));
    if (status) database.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, now, postId);
  }
  const statuses = assignments.map((assignment) => assignment.status);
  const allTerminal = statuses.every((status) => TERMINAL_ASSIGNMENT_STATUSES.has(status));
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
  return getFacebookCampaignSnapshot(database, campaignId)!;
}

export function requestFacebookExecutionCancellation(
  database: Database.Database,
  jobId: string,
  options: { global?: boolean; now?: number } = {},
) {
  return database.transaction(() => {
    const current = getJob(database, jobId);
    if (!current || current.kind !== "assignment.execute" || !current.assignmentId || !current.campaignId) {
      throw new FacebookError("EXECUTION_NOT_FOUND", "La ejecucion Facebook no existe.", 404);
    }
    if (!["pending", "running"].includes(current.status)) return current;
    const now = options.now ?? Date.now();
    if (options.global) {
      database.prepare(`
        UPDATE campaigns SET status = 'cancellation_requested',
          cancellation_reason = 'Cancelacion global solicitada por el operador.', updated_at = ?
        WHERE id = ?
      `).run(now, current.campaignId);
    }
    const cancelled = requestJobCancellation(database, jobId, now);
    if (current.status === "pending") {
      database.prepare(`
        UPDATE assignment_action_results SET status = 'cancelled',
          error = 'Cancelada por el operador.', updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND status = 'pending'
      `).run(now, now, current.operationId);
      database.prepare("UPDATE assignments SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ?")
        .run(now, now, current.assignmentId);
    } else {
      const assignment = database.prepare("SELECT status FROM assignments WHERE id = ?").get(current.assignmentId) as { status: string };
      if (assignment.status === "sent") {
        reduceFacebookCampaignExecution(database, current.campaignId, now);
        return cancelled;
      }
      database.prepare("UPDATE assignments SET status = 'cancellation_requested', updated_at = ? WHERE id = ?")
        .run(now, current.assignmentId);
    }
    reduceFacebookCampaignExecution(database, current.campaignId, now);
    return cancelled;
  }).immediate();
}

function activePostOperation(database: Database.Database, postId: string, kind: "post.extract" | "comments.generate") {
  return database.prepare(`
    SELECT id FROM operations
    WHERE post_id = ? AND kind = ? AND status IN ('pending', 'running')
    LIMIT 1
  `).get(postId, kind) as { id: string } | undefined;
}

function enqueuePostOperation(
  database: Database.Database,
  input: { postId: string; kind: "post.extract" | "comments.generate"; idempotencyKey: string; overwriteManual?: boolean },
) {
  const post = database.prepare(`
    SELECT p.id, p.campaign_id, p.context, p.context_status, c.comment_enabled
    FROM posts p JOIN campaigns c ON c.id = p.campaign_id
    WHERE p.id = ? AND c.platform = 'facebook'
  `).get(input.postId) as {
    id: string;
    campaign_id: string;
    context: string | null;
    context_status: string;
    comment_enabled: 0 | 1;
  } | undefined;
  if (!post) throw new FacebookError("POST_NOT_FOUND", "La publicacion no existe.", 404);
  if (!post.comment_enabled) throw new FacebookError("COMMENTS_DISABLED", "La campana no requiere contexto ni comentarios.", 409);
  if (input.kind === "comments.generate" && (!post.context?.trim() || !["ready", "cached", "edited"].includes(post.context_status))) {
    throw new FacebookError("CONTEXT_INVALID", "La generacion requiere un contexto valido.", 409);
  }
  if (input.kind === "comments.generate" && !input.overwriteManual) {
    const manual = database.prepare(`
      SELECT 1 FROM comments c JOIN assignments a ON a.id = c.assignment_id
      WHERE a.post_id = ? AND c.version = (
        SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = c.assignment_id
      ) AND (c.source = 'manual' OR c.status = 'edited') LIMIT 1
    `).get(post.id);
    if (manual) {
      throw new FacebookError("MANUAL_COMMENTS_PRESENT", "Confirma antes de sobrescribir comentarios editados manualmente.", 409);
    }
  }

  const created = createOperation(database, {
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    request: input.kind === "comments.generate"
      ? { postId: post.id, overwriteManual: input.overwriteManual === true }
      : { postId: post.id },
    campaignId: post.campaign_id,
    postId: post.id,
  });
  if (!created.replayed) {
    const active = activePostOperation(database, post.id, input.kind);
    if (active && active.id !== created.operation.id) {
      throw new FacebookError("OPERATION_IN_PROGRESS", "Ya existe una operacion activa para esta publicacion.", 409);
    }
  }
  const job = enqueueJob(database, input.kind, created.operation.request, {
    campaignId: post.campaign_id,
    postId: post.id,
    operationId: created.operation.id,
    maxAttempts: 2,
  });
  return { operation: created.operation, job, replayed: created.replayed };
}

export function requestFacebookPostOperation(
  database: Database.Database,
  input: { postId: string; kind: "post.extract" | "comments.generate"; idempotencyKey: string; overwriteManual?: boolean },
) {
  return database.transaction(() => enqueuePostOperation(database, input)).immediate();
}

export type FacebookExecutionPayload = {
  scheduleKey?: string;
  scheduleHash?: string;
  assignmentId: string;
  campaignId: string;
  postId: string;
  deviceId: string;
  expectedRevision: number;
  expectedAccount: string;
  expectedAccountResourceId: string;
  expectedPostContainerResourceId: string;
  expectedPostUrlResourceId: string;
  expectedCommentComposerResourceId: string | null;
  expectedCommentEditorResourceId: string | null;
  expectedCommentSubmitResourceId: string | null;
  expectedCommentResultContainerResourceId: string | null;
  expectedTargetText: string;
  postUrl: string;
  contextHash: string | null;
  actions: { like: boolean; comment: boolean };
  comment: null | { id: string; version: number; text: string; textHash: string };
  confirmation: { publicEffects: true; controlledAccount: true; controlledContent: true };
};

function currentAssignmentComment(database: Database.Database, assignmentId: string) {
  return database.prepare(`
    SELECT id, version, text, status, stale FROM comments
    WHERE assignment_id = ? AND version = (
      SELECT MAX(version) FROM comments WHERE assignment_id = ?
    )
  `).get(assignmentId, assignmentId) as {
    id: string;
    version: number;
    text: string;
    status: string;
    stale: 0 | 1;
  } | undefined;
}

export function requestFacebookCampaignExecution(
  database: Database.Database,
  campaignId: string,
  value: unknown,
  controlledAccount = appConfig.facebookControlledAccount,
  accountResourceId = appConfig.facebookAccountResourceId,
  postContainerResourceId = appConfig.facebookPostContainerResourceId,
  postUrlResourceId = appConfig.facebookPostUrlResourceId,
  commentComposerResourceId = appConfig.facebookCommentComposerResourceId,
  commentEditorResourceId = appConfig.facebookCommentEditorResourceId,
  commentSubmitResourceId = appConfig.facebookCommentSubmitResourceId,
  commentResultContainerResourceId = appConfig.facebookCommentResultContainerResourceId,
) {
  const input = objectValue(value);
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
  if (!Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) {
    throw new FacebookError("INVALID_CONFIRMATION", "La revision confirmada no es valida.");
  }
  if (input.confirmed !== true || input.controlledAccount !== true || input.controlledContent !== true) {
    throw new FacebookError("EXPLICIT_CONFIRMATION_REQUIRED", "Confirma la cuenta, el contenido y los efectos publicos.", 409);
  }
  const expectedTargetText = nonEmptyString(input.expectedTargetText, "expectedTargetText", 500);
  if (expectedTargetText.length < 5) {
    throw new FacebookError("TARGET_TEXT_INVALID", "La referencia visible debe tener al menos 5 caracteres.");
  }
  const expectedAccountResourceId = nonEmptyString(accountResourceId, "FACEBOOK_ACCOUNT_RESOURCE_ID", 300);
  const expectedPostContainerResourceId = nonEmptyString(postContainerResourceId, "FACEBOOK_POST_CONTAINER_RESOURCE_ID", 300);
  const expectedPostUrlResourceId = nonEmptyString(postUrlResourceId, "FACEBOOK_POST_URL_RESOURCE_ID", 300);
  const expectedPostUrl = nonEmptyString(input.expectedPostUrl, "expectedPostUrl", 2_048);
  const expectedAssignmentId = nonEmptyString(input.expectedAssignmentId, "expectedAssignmentId", 200);
  const expectedPostId = nonEmptyString(input.expectedPostId, "expectedPostId", 200);
  const expectedDeviceId = nonEmptyString(input.expectedDeviceId, "expectedDeviceId", 120);
  const confirmedAccount = nonEmptyString(input.expectedAccount, "expectedAccount", 300);
  const identity = database.prepare("SELECT account_label FROM facebook_device_identities WHERE device_id = ?")
    .get(expectedDeviceId) as { account_label: string } | undefined;
  const expectedAccount = (identity?.account_label ?? controlledAccount).trim();
  if (!expectedAccount || expectedAccount.length > 300 || /[\u0000-\u001f\u007f]/u.test(expectedAccount)) {
    throw new FacebookError("CONTROLLED_ACCOUNT_NOT_CONFIGURED", "Configura la cuenta Facebook esperada del dispositivo antes de ejecutar.", 503);
  }
  if (confirmedAccount !== expectedAccount) {
    throw new FacebookError("CONTROLLED_ACCOUNT_CHANGED", "La cuenta controlada cambio; revisa y confirma de nuevo.", 409);
  }
  const expectedActionsInput = objectValue(input.expectedActions, "expectedActions es obligatorio.");
  if (typeof expectedActionsInput.like !== "boolean" || typeof expectedActionsInput.comment !== "boolean") {
    throw new FacebookError("INVALID_CONFIRMATION", "Las acciones confirmadas no son validas.");
  }
  const expectedActions = { like: expectedActionsInput.like, comment: expectedActionsInput.comment };
  const expectedCommentComposerResourceId = expectedActions.comment
    ? nonEmptyString(commentComposerResourceId, "FACEBOOK_COMMENT_COMPOSER_RESOURCE_ID", 300)
    : null;
  const expectedCommentEditorResourceId = expectedActions.comment
    ? nonEmptyString(commentEditorResourceId, "FACEBOOK_COMMENT_EDITOR_RESOURCE_ID", 300)
    : null;
  const expectedCommentSubmitResourceId = expectedActions.comment
    ? nonEmptyString(commentSubmitResourceId, "FACEBOOK_COMMENT_SUBMIT_RESOURCE_ID", 300)
    : null;
  const expectedCommentResultContainerResourceId = expectedActions.comment
    ? nonEmptyString(commentResultContainerResourceId, "FACEBOOK_COMMENT_RESULT_CONTAINER_RESOURCE_ID", 300)
    : null;
  let expectedComment: null | { id: string; version: number; textHash: string } = null;
  if (input.expectedComment !== null) {
    const value = objectValue(input.expectedComment, "expectedComment no es valido.");
    const id = nonEmptyString(value.id, "expectedComment.id", 200);
    if (!Number.isInteger(value.version) || Number(value.version) < 1) {
      throw new FacebookError("INVALID_CONFIRMATION", "La version confirmada del comentario no es valida.");
    }
    if (typeof value.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.textHash)) {
      throw new FacebookError("INVALID_CONFIRMATION", "El hash confirmado del comentario no es valido.");
    }
    expectedComment = { id, version: Number(value.version), textHash: value.textHash };
  }

  return database.transaction(() => {
    const campaign = database.prepare(`
      SELECT id, status, revision, like_enabled, comment_enabled
      FROM campaigns WHERE id = ? AND platform = 'facebook'
    `).get(campaignId) as {
      id: string;
      status: string;
      revision: number;
      like_enabled: 0 | 1;
      comment_enabled: 0 | 1;
    } | undefined;
    if (!campaign) throw new FacebookError("CAMPAIGN_NOT_FOUND", "La campana no existe.", 404);
    const posts = database.prepare(`
      SELECT id, position, status, source_url, final_url, context_hash
      FROM posts WHERE campaign_id = ? ORDER BY position
    `).all(campaignId) as Array<{
      id: string;
      position: number;
      status: string;
      source_url: string;
      final_url: string | null;
      context_hash: string | null;
    }>;
    const assignments = database.prepare(`
      SELECT id, post_id, device_id, status FROM assignments WHERE campaign_id = ?
    `).all(campaignId) as Array<{ id: string; post_id: string; device_id: string; status: string }>;
    const assignment = assignments.find((item) => item.id === expectedAssignmentId);
    const post = posts.find((item) => item.id === expectedPostId);
    if (!assignment || !post || assignment.post_id !== post.id) {
      throw new FacebookError("CONFIRMED_TARGET_CHANGED", "La asignacion confirmada ya no pertenece a esta campana.", 409);
    }
    const comment = campaign.comment_enabled ? currentAssignmentComment(database, assignment.id) : undefined;
    const normalizedRequest: FacebookExecutionPayload = {
      assignmentId: expectedAssignmentId,
      campaignId,
      postId: expectedPostId,
      deviceId: expectedDeviceId,
      expectedRevision: Number(input.expectedRevision),
      expectedAccount: confirmedAccount,
      expectedAccountResourceId,
      expectedPostContainerResourceId,
      expectedPostUrlResourceId,
      expectedCommentComposerResourceId,
      expectedCommentEditorResourceId,
      expectedCommentSubmitResourceId,
      expectedCommentResultContainerResourceId,
      expectedTargetText,
      postUrl: expectedPostUrl,
      contextHash: post.context_hash,
      actions: expectedActions,
      comment: expectedComment && comment
        ? { ...expectedComment, text: comment.text }
        : null,
      confirmation: { publicEffects: true, controlledAccount: true, controlledContent: true },
    };
    const created = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey,
      request: normalizedRequest,
      campaignId,
      postId: post.id,
      assignmentId: assignment.id,
      deviceId: assignment.device_id,
    });
    if (created.replayed) {
      const replayedJob = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(created.operation.id) as { id: string } | undefined;
      if (!replayedJob) throw new Error("La operacion idempotente no conserva su job.");
      return { operation: created.operation, job: getJob(database, replayedJob.id)!, replayed: true };
    }

    if (campaign.revision !== normalizedRequest.expectedRevision) {
      throw new FacebookError("CAMPAIGN_REVISION_CHANGED", "La campana cambio; revisa el contenido y confirma de nuevo.", 409);
    }
    if (assignment.id !== expectedAssignmentId || assignment.device_id !== expectedDeviceId || post.id !== expectedPostId) {
      throw new FacebookError("CONFIRMED_TARGET_CHANGED", "La asignacion confirmada cambio; revisa y confirma de nuevo.", 409);
    }
    if ((post.final_url ?? post.source_url) !== expectedPostUrl) {
      throw new FacebookError("CONFIRMED_TARGET_CHANGED", "La URL efectiva cambio; revisa y confirma de nuevo.", 409);
    }
    if (Boolean(campaign.like_enabled) !== expectedActions.like || Boolean(campaign.comment_enabled) !== expectedActions.comment) {
      throw new FacebookError("CONFIRMED_ACTIONS_CHANGED", "Las acciones seleccionadas cambiaron; revisa y confirma de nuevo.", 409);
    }
    if (campaign.comment_enabled && (!comment || !expectedComment
      || comment.id !== expectedComment.id
      || comment.version !== expectedComment.version
      || hashContext(comment.text) !== expectedComment.textHash)) {
      throw new FacebookError("CONFIRMED_COMMENT_CHANGED", "El comentario cambio; revisa el texto exacto y confirma de nuevo.", 409);
    }
    if (!campaign.comment_enabled && expectedComment) {
      throw new FacebookError("CONFIRMED_COMMENT_CHANGED", "La confirmacion incluye un comentario no seleccionado.", 409);
    }
    const blocked = database.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM operations
        WHERE assignment_id = ? AND kind = 'assignment.execute'
          AND status IN ('pending', 'running') AND id != ?
      ) AS active,
      EXISTS(
        SELECT 1 FROM assignment_action_results
        WHERE assignment_id = ? AND status IN ('effect_possible', 'outcome_unknown')
      ) AS uncertain
    `).get(assignment.id, created.operation.id, assignment.id) as { active: 0 | 1; uncertain: 0 | 1 };
    if (blocked.uncertain) {
      throw new FacebookError("RECONCILIATION_REQUIRED", "Existe un efecto incierto que debe reconciliarse manualmente.", 409);
    }
    if (blocked.active) throw new FacebookError("OPERATION_IN_PROGRESS", "La asignacion ya tiene una ejecucion activa.", 409);
    if (!["ready", "scheduled", "running", "completed_with_issues"].includes(campaign.status)
      || !["ready", "scheduled", "running", "completed", "partial_failed", "cancelled"].includes(post.status)
      || !["draft", "approved", "failed", "cancelled"].includes(assignment.status)) {
      throw new FacebookError("CAMPAIGN_NOT_EXECUTABLE", "La campana no esta lista para una ejecucion controlada.", 409);
    }
    if (campaign.comment_enabled && (!comment
      || !["ready", "edited"].includes(comment.status)
      || comment.stale
      || comment.text.trim().length < 2
      || comment.text.length > 500)) {
      throw new FacebookError("COMMENT_NOT_READY", "El comentario exacto no esta listo o esta desactualizado.", 409);
    }
    assertFacebookCampaignDevicesEligible(database, [assignment.device_id]);

    const now = Date.now();
    const insertAction = database.prepare(`
      INSERT INTO assignment_action_results (
        id, assignment_id, operation_id, action, status, result,
        comment_id, comment_version, text_hash, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (campaign.like_enabled) {
      const priorLike = database.prepare(`
        SELECT 1 FROM assignment_action_results
        WHERE assignment_id = ? AND action = 'like' AND status = 'confirmed' LIMIT 1
      `).get(assignment.id);
      insertAction.run(
        randomUUID(), assignment.id, created.operation.id, "like",
        priorLike ? "confirmed" : "pending", priorLike ? "preserved" : null,
        null, null, null, now, now, priorLike ? now : null,
      );
    }
    if (campaign.comment_enabled) {
      insertAction.run(
        randomUUID(), assignment.id, created.operation.id, "comment", "pending", null,
        comment!.id, comment!.version, hashContext(comment!.text), now, now, null,
      );
    }
    database.prepare("UPDATE assignments SET status = 'approved', updated_at = ? WHERE id = ?").run(now, assignment.id);
    const job = enqueueJob(database, "assignment.execute", normalizedRequest, {
      campaignId,
      postId: post.id,
      assignmentId: assignment.id,
      operationId: created.operation.id,
      priority: 1_000_000 - post.position,
      maxAttempts: 1,
      effectPhase: "before_effect",
    });
    touchCampaign(database, campaignId, now);
    return { operation: created.operation, job, replayed: false };
  }).immediate();
}

export function requestFacebookCampaignSchedule(
  database: Database.Database,
  campaignId: string,
  value: unknown,
  accountResourceId = appConfig.facebookAccountResourceId,
  postContainerResourceId = appConfig.facebookPostContainerResourceId,
  postUrlResourceId = appConfig.facebookPostUrlResourceId,
  commentComposerResourceId = appConfig.facebookCommentComposerResourceId,
  commentEditorResourceId = appConfig.facebookCommentEditorResourceId,
  commentSubmitResourceId = appConfig.facebookCommentSubmitResourceId,
  commentResultContainerResourceId = appConfig.facebookCommentResultContainerResourceId,
) {
  const input = objectValue(value);
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
  if (!Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) {
    throw new FacebookError("INVALID_CONFIRMATION", "La revision confirmada no es valida.");
  }
  if (!Number.isSafeInteger(input.scheduledAt) || Number(input.scheduledAt) < 0) {
    throw new FacebookError("INVALID_SCHEDULE", "La fecha programada no es valida.");
  }
  if (input.confirmed !== true || input.controlledAccount !== true || input.controlledContent !== true) {
    throw new FacebookError("EXPLICIT_CONFIRMATION_REQUIRED", "Confirma las cuentas, el contenido y los efectos publicos.", 409);
  }
  if (input.allowSharedAccounts === true && input.sharedAccountsConfirmed !== true) {
    throw new FacebookError("SHARED_ACCOUNT_CONFIRMATION_REQUIRED", "Confirma explicitamente el uso de una cuenta compartida.", 409);
  }
  const expectedActionsInput = objectValue(input.expectedActions, "expectedActions es obligatorio.");
  if (typeof expectedActionsInput.like !== "boolean" || typeof expectedActionsInput.comment !== "boolean") {
    throw new FacebookError("INVALID_CONFIRMATION", "Las acciones confirmadas no son validas.");
  }
  const expectedActions = { like: expectedActionsInput.like, comment: expectedActionsInput.comment };
  const expectedAccountResourceId = nonEmptyString(accountResourceId, "FACEBOOK_ACCOUNT_RESOURCE_ID", 300);
  const expectedPostContainerResourceId = nonEmptyString(postContainerResourceId, "FACEBOOK_POST_CONTAINER_RESOURCE_ID", 300);
  const expectedPostUrlResourceId = nonEmptyString(postUrlResourceId, "FACEBOOK_POST_URL_RESOURCE_ID", 300);
  const expectedCommentComposerResourceId = expectedActions.comment
    ? nonEmptyString(commentComposerResourceId, "FACEBOOK_COMMENT_COMPOSER_RESOURCE_ID", 300)
    : null;
  const expectedCommentEditorResourceId = expectedActions.comment
    ? nonEmptyString(commentEditorResourceId, "FACEBOOK_COMMENT_EDITOR_RESOURCE_ID", 300)
    : null;
  const expectedCommentSubmitResourceId = expectedActions.comment
    ? nonEmptyString(commentSubmitResourceId, "FACEBOOK_COMMENT_SUBMIT_RESOURCE_ID", 300)
    : null;
  const expectedCommentResultContainerResourceId = expectedActions.comment
    ? nonEmptyString(commentResultContainerResourceId, "FACEBOOK_COMMENT_RESULT_CONTAINER_RESOURCE_ID", 300)
    : null;
  if (!Array.isArray(input.assignments) || input.assignments.length < 1 || input.assignments.length > 1_000) {
    throw new FacebookError("INVALID_CONFIRMATION", "La confirmacion debe incluir cada asignacion.");
  }
  const confirmations = input.assignments.map((raw, index) => {
    const confirmation = objectValue(raw, `assignments[${index}] no es valida.`);
    const expectedTargetText = nonEmptyString(confirmation.expectedTargetText, `assignments[${index}].expectedTargetText`, 500);
    if (expectedTargetText.length < 5) {
      throw new FacebookError("TARGET_TEXT_INVALID", "Cada referencia visible debe tener al menos 5 caracteres.");
    }
    let expectedComment: null | { id: string; version: number; textHash: string } = null;
    if (confirmation.expectedComment !== null) {
      const comment = objectValue(confirmation.expectedComment, `assignments[${index}].expectedComment no es valido.`);
      if (!Number.isInteger(comment.version) || Number(comment.version) < 1
        || typeof comment.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(comment.textHash)) {
        throw new FacebookError("INVALID_CONFIRMATION", "La version o hash confirmado del comentario no es valido.");
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
      expectedAccount: nonEmptyString(confirmation.expectedAccount, `assignments[${index}].expectedAccount`, 300),
      expectedPostUrl: nonEmptyString(confirmation.expectedPostUrl, `assignments[${index}].expectedPostUrl`, 2_048),
      expectedTargetText,
      expectedComment,
    };
  });
  if (new Set(confirmations.map((confirmation) => confirmation.assignmentId)).size !== confirmations.length) {
    throw new FacebookError("INVALID_CONFIRMATION", "Cada asignacion debe confirmarse exactamente una vez.");
  }
  const scheduleHash = createHash("sha256").update(stableJson({
    actions: expectedActions,
    allowSharedAccounts: input.allowSharedAccounts === true,
    assignments: confirmations,
    expectedRevision: Number(input.expectedRevision),
    scheduledAt: Number(input.scheduledAt),
  })).digest("hex");

  return database.transaction(() => {
    const campaign = database.prepare(`
      SELECT status, revision, like_enabled, comment_enabled
      FROM campaigns WHERE id = ? AND platform = 'facebook'
    `).get(campaignId) as {
      status: string;
      revision: number;
      like_enabled: 0 | 1;
      comment_enabled: 0 | 1;
    } | undefined;
    if (!campaign) throw new FacebookError("CAMPAIGN_NOT_FOUND", "La campana no existe.", 404);
    if (Boolean(campaign.like_enabled) !== expectedActions.like || Boolean(campaign.comment_enabled) !== expectedActions.comment) {
      throw new FacebookError("CONFIRMED_ACTIONS_CHANGED", "Las acciones seleccionadas cambiaron; revisa y confirma de nuevo.", 409);
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
      throw new FacebookError("CONFIRMED_TARGET_CHANGED", "La matriz confirmada no coincide con la campana.", 409);
    }
    const confirmationByAssignment = new Map(confirmations.map((confirmation) => [confirmation.assignmentId, confirmation]));
    const payloads = rows.map((row) => {
      const confirmation = confirmationByAssignment.get(row.id);
      const comment = campaign.comment_enabled ? currentAssignmentComment(database, row.id) : undefined;
      if (!confirmation || confirmation.postId !== row.post_id || confirmation.deviceId !== row.device_id
        || confirmation.expectedPostUrl !== (row.final_url ?? row.source_url)) {
        throw new FacebookError("CONFIRMED_TARGET_CHANGED", "Una asignacion, dispositivo o URL efectiva cambio.", 409);
      }
      if (campaign.comment_enabled && (!comment || !confirmation.expectedComment
        || comment.id !== confirmation.expectedComment.id
        || comment.version !== confirmation.expectedComment.version
        || hashContext(comment.text) !== confirmation.expectedComment.textHash
        || !["ready", "edited"].includes(comment.status) || comment.stale)) {
        throw new FacebookError("CONFIRMED_COMMENT_CHANGED", "Un comentario cambio o no esta listo; revisa y confirma de nuevo.", 409);
      }
      if (!campaign.comment_enabled && confirmation.expectedComment) {
        throw new FacebookError("CONFIRMED_COMMENT_CHANGED", "La confirmacion incluye un comentario no seleccionado.", 409);
      }
      return {
        row,
        payload: {
          scheduleKey: idempotencyKey,
          scheduleHash,
          assignmentId: row.id,
          campaignId,
          postId: row.post_id,
          deviceId: row.device_id,
          expectedRevision: Number(input.expectedRevision),
          expectedAccount: confirmation.expectedAccount,
          expectedAccountResourceId,
          expectedPostContainerResourceId,
          expectedPostUrlResourceId,
          expectedCommentComposerResourceId,
          expectedCommentEditorResourceId,
          expectedCommentSubmitResourceId,
          expectedCommentResultContainerResourceId,
          expectedTargetText: confirmation.expectedTargetText,
          postUrl: confirmation.expectedPostUrl,
          contextHash: row.context_hash,
          actions: expectedActions,
          comment: confirmation.expectedComment && comment
            ? { ...confirmation.expectedComment, text: comment.text }
            : null,
          confirmation: { publicEffects: true as const, controlledAccount: true as const, controlledContent: true as const },
        } satisfies FacebookExecutionPayload,
      };
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
      const job = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(first.operation.id) as { id: string } | undefined;
      if (!job) throw new Error("La programacion idempotente no conserva su job.");
      return { operation: first.operation, job: getJob(database, job.id)!, replayed: true };
    }
    if (campaign.revision !== Number(input.expectedRevision)) {
      throw new FacebookError("CAMPAIGN_REVISION_CHANGED", "La campana cambio; revisa el contenido y confirma de nuevo.", 409);
    }
    if (campaign.status !== "ready" || rows.some((row) => row.post_status !== "ready" || !["draft", "approved"].includes(row.status))) {
      throw new FacebookError("CAMPAIGN_NOT_READY", "La campana completa debe estar lista antes de programarla.", 409);
    }
    const deviceIds = [...new Set(rows.map((row) => row.device_id))];
    assertFacebookCampaignDevicesEligible(database, deviceIds, { allowBusy: true });
    const accountByDevice = new Map<string, string>();
    for (const confirmation of confirmations) {
      const previous = accountByDevice.get(confirmation.deviceId);
      if (previous && normalizeAccountLabel(previous) !== normalizeAccountLabel(confirmation.expectedAccount)) {
        throw new FacebookError("CONFIRMED_ACCOUNT_CHANGED", "Un dispositivo tiene mas de una cuenta esperada.", 409);
      }
      accountByDevice.set(confirmation.deviceId, confirmation.expectedAccount);
    }
    for (const [deviceId, account] of accountByDevice) recordFacebookDeviceIdentity(database, deviceId, account);
    const now = Date.now();
    database.prepare("UPDATE assignments SET status = 'approved', updated_at = ? WHERE campaign_id = ?")
      .run(now, campaignId);
    freezeFacebookCampaignManifest(
      database,
      campaignId,
      Number(input.scheduledAt),
      input.allowSharedAccounts === true,
    );

    const insertAction = database.prepare(`
      INSERT INTO assignment_action_results (
        id, assignment_id, operation_id, action, status, result,
        comment_id, comment_version, text_hash, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, NULL)
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
      if (campaign.like_enabled) insertAction.run(randomUUID(), item.row.id, operation.id, "like", null, null, null, now, now);
      if (campaign.comment_enabled) {
        insertAction.run(
          randomUUID(),
          item.row.id,
          operation.id,
          "comment",
          item.payload.comment!.id,
          item.payload.comment!.version,
          item.payload.comment!.textHash,
          now,
          now,
        );
      }
      const job = enqueueJob(database, "assignment.execute", item.payload, {
        campaignId,
        postId: item.row.post_id,
        assignmentId: item.row.id,
        operationId: operation.id,
        priority: rows.length - item.row.position,
        maxAttempts: 2,
        availableAt: Number(input.scheduledAt),
        effectPhase: "before_effect",
      });
      if (index === 0) firstJob = job;
    }
    return { operation: first.operation, job: firstJob!, replayed: false };
  }).immediate();
}

export function reconcileFacebookAssignment(database: Database.Database, assignmentId: string, value: unknown) {
  const input = objectValue(value);
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
  if (input.action !== "like" && input.action !== "comment") {
    throw new FacebookError("RECONCILIATION_INVALID", "La accion a reconciliar no es valida.");
  }
  if (input.resolution !== "sent" && input.resolution !== "not_sent") {
    throw new FacebookError("RECONCILIATION_INVALID", "La resolucion debe ser sent o not_sent.");
  }
  const operationId = nonEmptyString(input.operationId, "operationId", 200);
  return database.transaction(() => {
    const assignment = database.prepare(`
      SELECT a.id, a.campaign_id, a.post_id, a.device_id, a.status,
        c.like_enabled, c.comment_enabled
      FROM assignments a JOIN campaigns c ON c.id = a.campaign_id
      WHERE a.id = ? AND c.platform = 'facebook'
    `).get(assignmentId) as {
      id: string;
      campaign_id: string;
      post_id: string;
      device_id: string;
      status: string;
      like_enabled: 0 | 1;
      comment_enabled: 0 | 1;
    } | undefined;
    if (!assignment) throw new FacebookError("ASSIGNMENT_NOT_FOUND", "La asignacion no existe.", 404);
    const activeExecution = database.prepare(`
      SELECT 1 FROM jobs
      WHERE assignment_id = ? AND kind = 'assignment.execute' AND status IN ('pending', 'running')
      LIMIT 1
    `).get(assignmentId);
    if (activeExecution) {
      throw new FacebookError("EXECUTION_IN_PROGRESS", "Espera a que el worker termine antes de reconciliar.", 409);
    }
    const request = { assignmentId, operationId, action: input.action, resolution: input.resolution };
    const created = createOperation(database, {
      kind: "operation.reconcile",
      idempotencyKey,
      request,
      campaignId: assignment.campaign_id,
      postId: assignment.post_id,
      assignmentId,
      deviceId: assignment.device_id,
    });
    if (created.replayed) {
      return { operation: created.operation, campaign: getFacebookCampaignSnapshot(database, assignment.campaign_id), replayed: true };
    }
    const uncertain = database.prepare(`
      SELECT id, operation_id FROM assignment_action_results
      WHERE assignment_id = ? AND operation_id = ? AND action = ?
        AND status IN ('effect_possible', 'outcome_unknown')
      LIMIT 1
    `).get(assignmentId, operationId, input.action) as { id: string; operation_id: string } | undefined;
    if (!uncertain || assignment.status !== "outcome_unknown") {
      throw new FacebookError("RECONCILIATION_NOT_REQUIRED", "La asignacion no tiene ese efecto incierto.", 409);
    }
    const session = database.prepare(`
      SELECT cleanup_status, closed_at FROM appium_sessions WHERE operation_id = ?
    `).get(uncertain.operation_id) as { cleanup_status: string; closed_at: number | null } | undefined;
    if (!session || session.closed_at === null || session.cleanup_status !== "home_confirmed") {
      throw new FacebookError(
        "EXECUTION_NOT_QUIESCENT",
        "Cierra la sesion incierta y confirma Home antes de reconciliar o volver a ejecutar.",
        409,
      );
    }
    const now = Date.now();
    database.prepare(`
      UPDATE assignment_action_results
      SET status = ?, result = ?, error = NULL, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      input.resolution === "sent" ? "confirmed" : "reconciled_not_sent",
      input.resolution === "sent" ? (input.action === "like" ? "activated" : "sent") : "not_sent",
      now,
      now,
      uncertain.id,
    );
    const confirmed = database.prepare(`
      SELECT
        EXISTS(SELECT 1 FROM assignment_action_results WHERE assignment_id = ? AND action = 'like' AND status = 'confirmed') AS liked,
        EXISTS(SELECT 1 FROM assignment_action_results WHERE assignment_id = ? AND action = 'comment' AND status = 'confirmed') AS commented
    `).get(assignmentId, assignmentId) as { liked: 0 | 1; commented: 0 | 1 };
    const complete = (!assignment.like_enabled || confirmed.liked) && (!assignment.comment_enabled || confirmed.commented);
    database.prepare(`
      UPDATE assignments SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?
    `).run(complete ? "sent" : "approved", now, complete ? now : null, assignmentId);
    completeOperation(database, created.operation.id, request);
    reduceFacebookCampaignExecution(database, assignment.campaign_id, now);
    return {
      operation: getOperation(database, created.operation.id)!,
      campaign: getFacebookCampaignSnapshot(database, assignment.campaign_id),
      replayed: false,
    };
  }).immediate();
}

export function createFacebookCampaign(
  database: Database.Database,
  operationId: string,
  request: FacebookCampaignRequest,
) {
  const input = validateFacebookCampaignRequest(request);
  assertOperationNotCancelled(database, operationId);
  return database.transaction(() => {
    assertOperationNotCancelled(database, operationId);
    const operation = getOperation(database, operationId);
    if (!operation || operation.kind !== "campaign.create") throw new Error("La operacion de campana no existe.");
    if (operation.campaignId) return getFacebookCampaignSnapshot(database, operation.campaignId);
    assertFacebookCampaignDevicesEligible(database, input.deviceIds);

    const campaignId = randomUUID();
    const now = Date.now();
    database.prepare(`
      INSERT INTO campaigns (
        id, platform, status, like_enabled, comment_enabled, created_at, updated_at
      ) VALUES (?, 'facebook', ?, ?, ?, ?, ?)
    `).run(campaignId, input.actions.comment ? "preparing" : "ready", Number(input.actions.like), Number(input.actions.comment), now, now);
    const profiles = commentProfiles(input);
    for (const [postIndex, value] of input.urls.entries()) {
      const { sourceUrl, normalizedUrl } = normalizeFacebookUrl(value);
      const postId = randomUUID();
      database.prepare(`
        INSERT INTO posts (
          id, campaign_id, position, source_url, normalized_url, status,
          context_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        postId,
        campaignId,
        postIndex + 1,
        sourceUrl,
        normalizedUrl,
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
      if (input.actions.comment) {
        enqueuePostOperation(database, {
          postId,
          kind: "post.extract",
          idempotencyKey: randomUUID(),
        });
      }
    }
    const committed = stableJson({ domainCommitted: true });
    database.prepare("UPDATE operations SET campaign_id = ?, result_json = ?, updated_at = ? WHERE id = ?")
      .run(campaignId, committed, now, operationId);
    database.prepare("UPDATE jobs SET campaign_id = ?, result_json = ?, updated_at = ? WHERE operation_id = ?")
      .run(campaignId, committed, now, operationId);
    return getFacebookCampaignSnapshot(database, campaignId);
  }).immediate();
}

export function getFacebookCampaignSnapshot(database: Database.Database, campaignId: string) {
  const campaign = database.prepare(`
    SELECT id, status, like_enabled, comment_enabled, revision, cancellation_reason, created_at, updated_at
    FROM campaigns WHERE id = ? AND platform = 'facebook'
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
  const manifest = database.prepare(`
    SELECT campaign_revision, scheduled_at, posts_json, devices_json, assignments_json,
      allow_shared_accounts, created_at
    FROM facebook_campaign_manifests WHERE campaign_id = ?
  `).get(campaignId) as {
    campaign_revision: number;
    scheduled_at: number;
    posts_json: string;
    devices_json: string;
    assignments_json: string;
    allow_shared_accounts: 0 | 1;
    created_at: number;
  } | undefined;
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
  const executionRows = database.prepare(`
    SELECT o.id, o.assignment_id, o.status, o.effect_phase, o.session_status,
      o.cleanup_status, o.error, o.created_at, j.attempts
    FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id
    WHERE o.campaign_id = ? AND o.kind = 'assignment.execute'
    ORDER BY o.created_at DESC, o.id DESC
  `).all(campaignId) as Array<{
    id: string;
    assignment_id: string;
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
  const posts = database.prepare(`
    SELECT p.*,
      (SELECT context FROM post_context_versions v
       WHERE v.post_id = p.id AND v.source = 'extracted'
       ORDER BY v.version DESC LIMIT 1) AS extracted_context
    FROM posts p WHERE p.campaign_id = ? ORDER BY p.position
  `).all(campaignId) as Array<Record<string, unknown> & {
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
    extracted_context: string | null;
    extractor_version: string | null;
    extracted_at: number | null;
    error: string | null;
  }>;
  const deviceIds = [...new Map(assignments
    .toSorted((left, right) => left.physical_order - right.physical_order)
    .map((assignment) => [assignment.device_id, assignment.device_id])).values()];
  return {
    id: campaign.id,
    platform: "facebook" as const,
    status: campaign.status,
    revision: campaign.revision,
    cancellationReason: campaign.cancellation_reason,
    actions: { like: Boolean(campaign.like_enabled), comment: Boolean(campaign.comment_enabled) },
    controlledAccount: appConfig.facebookControlledAccount
      && appConfig.facebookAccountResourceId
      && appConfig.facebookPostContainerResourceId
      && appConfig.facebookPostUrlResourceId
      && (!campaign.comment_enabled || (
        appConfig.facebookCommentComposerResourceId
        && appConfig.facebookCommentEditorResourceId
        && appConfig.facebookCommentSubmitResourceId
        && appConfig.facebookCommentResultContainerResourceId
      ))
      ? appConfig.facebookControlledAccount
      : null,
    manifest: manifest ? {
      revision: manifest.campaign_revision,
      scheduledAt: manifest.scheduled_at,
      posts: JSON.parse(manifest.posts_json) as unknown[],
      devices: JSON.parse(manifest.devices_json) as unknown[],
      assignments: JSON.parse(manifest.assignments_json) as unknown[],
      allowSharedAccounts: Boolean(manifest.allow_shared_accounts),
      createdAt: manifest.created_at,
    } : null,
    deviceIds,
    createdAt: campaign.created_at,
    updatedAt: campaign.updated_at,
    posts: posts.map((post) => ({
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
      extractedContext: post.extracted_context ?? "",
      contextSource: post.context_source,
      extractorVersion: post.extractor_version,
      extractedAt: post.extracted_at,
      error: post.error,
      comments: (assignmentsByPost.get(post.id) ?? []).flatMap((assignment) => {
        const comment = commentByAssignment.get(assignment.id);
        return comment ? [{
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
          textHash: hashContext(comment.text),
          error: comment.error,
        }] : [];
      }),
    })),
    assignments: assignments.map((assignment) => {
      const execution = latestExecution.get(assignment.id);
      const like = execution ? actionByExecution.get(`${execution.id}:like`) : undefined;
      const comment = execution ? actionByExecution.get(`${execution.id}:comment`) : undefined;
      return {
        id: assignment.id,
        postId: assignment.post_id,
        deviceId: assignment.device_id,
        status: assignment.status,
        scheduledAt: assignment.scheduled_at,
        actualAt: assignment.actual_at,
        execution: execution ? {
          operationId: execution.id,
          status: execution.status,
          effectPhase: execution.effect_phase,
          sessionStatus: execution.session_status,
          cleanupStatus: execution.cleanup_status,
          attempts: execution.attempts ?? 0,
          error: execution.error,
          uncertainAction: like?.status === "outcome_unknown" || like?.status === "effect_possible"
            ? "like"
            : comment?.status === "outcome_unknown" || comment?.status === "effect_possible"
              ? "comment"
              : null,
          like: like ? { status: like.status, result: like.result, error: like.error } : null,
          comment: comment ? { status: comment.status, result: comment.result, error: comment.error } : null,
          checkpoints: (checkpointsByExecution.get(execution.id) ?? []).map((checkpoint) => ({
            id: checkpoint.id,
            phase: checkpoint.phase,
            sequence: checkpoint.sequence,
            createdAt: checkpoint.created_at,
          })),
          evidence: (evidenceByExecution.get(execution.id) ?? []).map((item) => ({
            checkpointId: item.checkpoint_id,
            kind: item.kind,
            path: item.path,
            createdAt: item.created_at,
          })),
        } : null,
      };
    }),
  };
}

export function getLatestFacebookCampaignSnapshot(database: Database.Database) {
  const row = database.prepare(`
    SELECT id FROM campaigns WHERE platform = 'facebook' ORDER BY created_at DESC, id DESC LIMIT 1
  `).get() as { id: string } | undefined;
  return row ? getFacebookCampaignSnapshot(database, row.id) : null;
}

export function listFacebookCampaignSnapshots(database: Database.Database) {
  const rows = database.prepare(`
    SELECT id FROM campaigns WHERE platform = 'facebook' ORDER BY created_at DESC, id DESC
  `).all() as Array<{ id: string }>;
  return rows.map((row) => getFacebookCampaignSnapshot(database, row.id)!);
}

function nextContextVersion(database: Database.Database, postId: string) {
  const row = database.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM post_context_versions WHERE post_id = ?")
    .get(postId) as { version: number };
  return row.version;
}

function hashContext(context: string) {
  return createHash("sha256").update(context).digest("hex");
}

function assertOperationNotCancelled(database: Database.Database, operationId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const row = database.prepare(`
    SELECT o.status, j.cancellation_requested_at
    FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id WHERE o.id = ?
  `).get(operationId) as { status: string; cancellation_requested_at: number | null } | undefined;
  if (row?.status === "cancelled" || (row?.cancellation_requested_at !== null && row?.cancellation_requested_at !== undefined)) {
    throw new DOMException("Cancelacion solicitada", "AbortError");
  }
}

function operationDomainCommitted(database: Database.Database, operationId: string) {
  const row = database.prepare("SELECT result_json FROM jobs WHERE operation_id = ?")
    .get(operationId) as { result_json: string | null } | undefined;
  if (!row?.result_json) return false;
  try {
    return (JSON.parse(row.result_json) as { domainCommitted?: unknown }).domainCommitted === true;
  } catch {
    return false;
  }
}

function operationCancellationRequested(database: Database.Database, operationId: string) {
  const row = database.prepare(`
    SELECT o.status, j.cancellation_requested_at
    FROM operations o LEFT JOIN jobs j ON j.operation_id = o.id WHERE o.id = ?
  `).get(operationId) as { status: string; cancellation_requested_at: number | null } | undefined;
  return row?.status === "cancelled"
    || (row?.cancellation_requested_at !== null && row?.cancellation_requested_at !== undefined);
}

function assertFacebookPostEditable(database: Database.Database, postId: string) {
  const blocked = database.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM operations WHERE post_id = ? AND kind = 'assignment.execute'
        AND status IN ('pending', 'running')
    ) AS active,
    EXISTS(
      SELECT 1 FROM assignments WHERE post_id = ?
        AND status IN ('running', 'sent', 'outcome_unknown', 'cancellation_requested')
    ) AS finalized,
    EXISTS(
      SELECT 1 FROM facebook_campaign_manifests m
      JOIN posts p ON p.campaign_id = m.campaign_id WHERE p.id = ?
    ) AS frozen
  `).get(postId, postId, postId) as { active: 0 | 1; finalized: 0 | 1; frozen: 0 | 1 };
  if (blocked.active || blocked.finalized || blocked.frozen) {
    throw new FacebookError("EXECUTION_LOCKED", "El contenido no puede cambiar durante o despues de una accion publica.", 409);
  }
}

export function editFacebookPostContext(database: Database.Database, campaignId: string, postId: string, value: unknown) {
  const context = nonEmptyString(value, "context", 5_000);
  if (context.length < 2) throw new FacebookError("CONTEXT_INVALID", "El contexto debe tener al menos 2 caracteres.");
  return database.transaction(() => {
    assertFacebookPostEditable(database, postId);
    const post = database.prepare(`
      SELECT p.context, p.context_hash FROM posts p JOIN campaigns c ON c.id = p.campaign_id
      WHERE p.id = ? AND p.campaign_id = ? AND c.platform = 'facebook'
    `).get(postId, campaignId) as { context: string | null; context_hash: string | null } | undefined;
    if (!post) throw new FacebookError("POST_NOT_FOUND", "La publicacion no existe.", 404);
    const contextHash = hashContext(context);
    if (post.context === context && post.context_hash === contextHash) return getFacebookCampaignSnapshot(database, campaignId)!;
    const now = Date.now();
    const generationJobs = database.prepare(`
      SELECT j.id FROM jobs j JOIN operations o ON o.id = j.operation_id
      WHERE o.post_id = ? AND o.kind = 'comments.generate' AND j.status IN ('pending', 'running')
    `).all(postId) as Array<{ id: string }>;
    for (const job of generationJobs) requestJobCancellation(database, job.id, now);
    const version = nextContextVersion(database, postId);
    database.prepare(`
      INSERT INTO post_context_versions (
        id, post_id, version, context, context_hash, source, created_at
      ) VALUES (?, ?, ?, ?, ?, 'manual', ?)
    `).run(randomUUID(), postId, version, context, contextHash, now);
    database.prepare(`
      UPDATE posts SET context = ?, context_hash = ?, context_source = 'manual',
        context_status = 'edited', context_version = ?, status = 'context_ready',
        error = NULL, updated_at = ? WHERE id = ?
    `).run(context, contextHash, version, now, postId);
    database.prepare(`
      UPDATE comments SET stale = 1,
        status = CASE WHEN status IN ('generating', 'regenerating') THEN 'failed' ELSE status END,
        error = CASE WHEN status IN ('generating', 'regenerating') THEN 'El contexto cambio durante la generacion.' ELSE error END,
        updated_at = ?
      WHERE assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
    `).run(now, postId);
    database.prepare(`
      UPDATE assignments SET status = CASE WHEN status = 'generating' THEN 'pending' ELSE status END,
        updated_at = ? WHERE post_id = ?
    `).run(now, postId);
    database.prepare("UPDATE campaigns SET status = 'preparing' WHERE id = ?").run(campaignId);
    touchCampaign(database, campaignId, now);
    return getFacebookCampaignSnapshot(database, campaignId)!;
  }).immediate();
}

export function restoreFacebookExtractedContext(database: Database.Database, campaignId: string, postId: string) {
  return database.transaction(() => {
    assertFacebookPostEditable(database, postId);
    const post = database.prepare(`
      SELECT context_hash FROM posts WHERE id = ? AND campaign_id = ?
    `).get(postId, campaignId) as { context_hash: string | null } | undefined;
    const extracted = database.prepare(`
      SELECT context, context_hash, final_url, extractor_version
      FROM post_context_versions
      WHERE post_id = ? AND source = 'extracted'
      ORDER BY version DESC LIMIT 1
    `).get(postId) as {
      context: string;
      context_hash: string;
      final_url: string | null;
      extractor_version: string | null;
    } | undefined;
    if (!post) throw new FacebookError("POST_NOT_FOUND", "La publicacion no existe.", 404);
    if (!extracted) throw new FacebookError("EXTRACTED_CONTEXT_MISSING", "No existe un contexto extraido para restaurar.", 409);
    const now = Date.now();
    const generationJobs = database.prepare(`
      SELECT j.id FROM jobs j JOIN operations o ON o.id = j.operation_id
      WHERE o.post_id = ? AND o.kind = 'comments.generate' AND j.status IN ('pending', 'running')
    `).all(postId) as Array<{ id: string }>;
    for (const job of generationJobs) requestJobCancellation(database, job.id, now);
    const version = nextContextVersion(database, postId);
    database.prepare(`
      INSERT INTO post_context_versions (
        id, post_id, version, context, context_hash, source, final_url, extractor_version, created_at
      ) VALUES (?, ?, ?, ?, ?, 'extracted', ?, ?, ?)
    `).run(randomUUID(), postId, version, extracted.context, extracted.context_hash, extracted.final_url, extracted.extractor_version, now);
    database.prepare(`
      UPDATE posts SET context = ?, context_hash = ?, context_source = 'extracted',
        context_status = 'ready', context_version = ?, status = 'context_ready',
        final_url = COALESCE(?, final_url), extractor_version = COALESCE(?, extractor_version),
        error = NULL, updated_at = ? WHERE id = ?
    `).run(
      extracted.context,
      extracted.context_hash,
      version,
      extracted.final_url,
      extracted.extractor_version,
      now,
      postId,
    );
    if (post.context_hash !== extracted.context_hash) {
      database.prepare(`
        UPDATE comments SET stale = 1, updated_at = ?
        WHERE assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
      `).run(now, postId);
    }
    database.prepare("UPDATE campaigns SET status = 'preparing' WHERE id = ?").run(campaignId);
    touchCampaign(database, campaignId, now);
    return getFacebookCampaignSnapshot(database, campaignId)!;
  }).immediate();
}

export function editFacebookComment(
  database: Database.Database,
  commentId: string,
  value: { text: unknown; intention: unknown; tone: unknown },
) {
  if (typeof value.text !== "string") throw new FacebookError("COMMENT_INVALID", "El comentario no es valido.");
  const text = value.text.trim();
  if (text.length > 500 || text.length === 1 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new FacebookError("COMMENT_INVALID", "El comentario debe estar vacio o tener entre 2 y 500 caracteres.");
  }
  const intention = nonEmptyString(value.intention, "intention", 300);
  if (typeof value.tone !== "string" || !FACEBOOK_TONES.includes(value.tone as (typeof FACEBOOK_TONES)[number])) {
    throw new FacebookError("COMMENT_INVALID", "El tono no es valido.");
  }
  return database.transaction(() => {
    const current = database.prepare(`
      SELECT c.*, a.post_id, a.campaign_id
      FROM comments requested
      JOIN comments c ON c.assignment_id = requested.assignment_id
      JOIN assignments a ON a.id = c.assignment_id
      JOIN campaigns campaign ON campaign.id = a.campaign_id
      WHERE requested.id = ? AND campaign.platform = 'facebook'
        AND c.version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = c.assignment_id)
    `).get(commentId) as {
      assignment_id: string;
      version: number;
      intention: string;
      tone: string;
      text: string;
      status: string;
      stale: 0 | 1;
      source: "generated" | "manual";
      post_id: string;
      campaign_id: string;
    } | undefined;
    if (!current) throw new FacebookError("COMMENT_NOT_FOUND", "El comentario no existe.", 404);
    assertFacebookPostEditable(database, current.post_id);
    if (!text && current.text) throw new FacebookError("COMMENT_INVALID", "Un comentario guardado no puede quedar vacio.");
    const textChanged = current.text !== text;
    const profileChanged = current.intention !== intention || current.tone !== value.tone;
    if (!textChanged && !profileChanged) return getFacebookCampaignSnapshot(database, current.campaign_id)!;
    const now = Date.now();
    const generationJobs = database.prepare(`
      SELECT j.id FROM jobs j JOIN operations o ON o.id = j.operation_id
      WHERE o.post_id = ? AND o.kind = 'comments.generate' AND j.status IN ('pending', 'running')
    `).all(current.post_id) as Array<{ id: string }>;
    for (const job of generationJobs) requestJobCancellation(database, job.id, now);
    database.prepare(`
      INSERT INTO comments (
        id, assignment_id, version, intention, tone, text, status, stale,
        source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      current.assignment_id,
      current.version + 1,
      intention,
      value.tone,
      text,
      textChanged ? "edited" : current.status,
      Number(profileChanged),
      textChanged ? "manual" : current.source,
      now,
      now,
    );
    database.prepare("UPDATE assignments SET status = ?, updated_at = ? WHERE id = ?")
      .run(profileChanged ? "pending" : "draft", now, current.assignment_id);
    if (profileChanged) {
      database.prepare("UPDATE posts SET status = 'context_ready', updated_at = ? WHERE id = ?")
        .run(now, current.post_id);
      database.prepare("UPDATE campaigns SET status = 'preparing' WHERE id = ?").run(current.campaign_id);
    }
    touchCampaign(database, current.campaign_id, now);
    return getFacebookCampaignSnapshot(database, current.campaign_id)!;
  }).immediate();
}

function persistExtraction(
  database: Database.Database,
  operationId: string,
  extraction: FacebookExtraction,
) {
  const operation = getOperation(database, operationId);
  if (!operation?.postId || !operation.campaignId) throw new Error("La extraccion no tiene publicacion asociada.");
  const context = nonEmptyString(extraction.context, "context", 5_000);
  if (context.length < 5) throw new FacebookError("FACEBOOK_CONTENT_EMPTY", "Facebook no expuso contexto suficiente.", 422);
  const finalUrl = normalizeFacebookUrl(extraction.finalUrl).sourceUrl;
  const contextHash = hashContext(context);
  const now = Date.now();
  const current = database.prepare("SELECT context_version, context_source, context_hash FROM posts WHERE id = ?")
    .get(operation.postId) as { context_version: number; context_source: string | null; context_hash: string | null };
  const version = nextContextVersion(database, operation.postId);
  database.prepare(`
    INSERT INTO post_context_versions (
      id, post_id, version, context, context_hash, source, final_url, extractor_version, created_at
    ) VALUES (?, ?, ?, ?, ?, 'extracted', ?, ?, ?)
  `).run(randomUUID(), operation.postId, version, context, contextHash, finalUrl, extraction.extractorVersion, now);
  const preserveManual = current.context_source === "manual";
  database.prepare(`
    UPDATE posts SET final_url = ?, extractor_version = ?, extracted_at = ?, error = NULL,
      context = CASE WHEN ? THEN context ELSE ? END,
      context_hash = CASE WHEN ? THEN context_hash ELSE ? END,
      context_source = CASE WHEN ? THEN context_source ELSE 'extracted' END,
      context_version = CASE WHEN ? THEN context_version ELSE ? END,
      context_status = CASE WHEN ? THEN 'edited' ELSE 'ready' END,
      status = 'context_ready', updated_at = ? WHERE id = ?
  `).run(
    finalUrl,
    extraction.extractorVersion,
    now,
    Number(preserveManual),
    context,
    Number(preserveManual),
    contextHash,
    Number(preserveManual),
    Number(preserveManual),
    version,
    Number(preserveManual),
    now,
    operation.postId,
  );
  const activeHash = preserveManual ? current.context_hash : contextHash;
  if (activeHash !== current.context_hash) {
    database.prepare(`
      UPDATE comments SET stale = 1, updated_at = ?
      WHERE assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
    `).run(now, operation.postId);
  }
  database.prepare("UPDATE operations SET result_json = ?, updated_at = ? WHERE id = ?")
    .run(stableJson({ domainCommitted: true }), now, operationId);
  database.prepare("UPDATE jobs SET result_json = ?, updated_at = ? WHERE operation_id = ?")
    .run(stableJson({ domainCommitted: true }), now, operationId);
  touchCampaign(database, operation.campaignId, now);
}

function markExtractionFailure(
  database: Database.Database,
  operationId: string,
  error: unknown,
) {
  const operation = getOperation(database, operationId);
  if (!operation?.postId || !operation.campaignId) return;
  const code = error instanceof FacebookError ? error.code : "";
  const contextStatus = code === "FACEBOOK_SESSION_REQUIRED"
    ? "session_required"
    : code === "FACEBOOK_INTERVENTION_REQUIRED"
      ? "intervention_required"
      : "failed";
  const now = Date.now();
  database.transaction(() => {
    const current = database.prepare("SELECT context_version, context_source, context_status, context FROM posts WHERE id = ?")
      .get(operation.postId) as {
        context_version: number;
        context_source: string | null;
        context_status: string;
        context: string | null;
      };
    const campaign = database.prepare("SELECT status FROM campaigns WHERE id = ?")
      .get(operation.campaignId) as { status: string };
    if (campaign.status === "cancelled") return;
    if (operationCancellationRequested(database, operationId)) {
      const hasContext = Boolean(current.context?.trim()) && ["ready", "cached", "edited"].includes(current.context_status);
      database.prepare("UPDATE posts SET status = ?, context_status = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(hasContext ? "context_ready" : "cancelled", hasContext ? current.context_status : "failed", "Extraccion cancelada por el operador.", now, operation.postId);
      touchCampaign(database, operation.campaignId!, now);
      return;
    }
    const preserveManual = current.context_source === "manual";
    database.prepare(`
      UPDATE posts SET status = ?, context_status = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(
      preserveManual ? "context_ready" : "partial_failed",
      preserveManual ? "edited" : contextStatus,
      error instanceof Error ? error.message : String(error),
      now,
      operation.postId,
    );
    touchCampaign(database, operation.campaignId!, now);
  })();
}

function hasCurrentComments(database: Database.Database, postId: string) {
  const row = database.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN c.status IN ('ready', 'edited') AND c.stale = 0 THEN 1 ELSE 0 END) AS ready
    FROM comments c
    JOIN assignments a ON a.id = c.assignment_id
    WHERE a.post_id = ? AND c.version = (
      SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = c.assignment_id
    )
  `).get(postId) as { total: number; ready: number | null };
  return row.total > 0 && row.ready === row.total;
}

function queueAutomaticGeneration(database: Database.Database, postId: string) {
  const manual = database.prepare(`
    SELECT 1 FROM comments c JOIN assignments a ON a.id = c.assignment_id
    WHERE a.post_id = ? AND c.version = (
      SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = c.assignment_id
    ) AND (c.source = 'manual' OR c.status = 'edited') LIMIT 1
  `).get(postId);
  if (manual || hasCurrentComments(database, postId) || activePostOperation(database, postId, "comments.generate")) return;
  enqueuePostOperation(database, {
    postId,
    kind: "comments.generate",
    idempotencyKey: randomUUID(),
  });
}

export async function extractFacebookPost(
  database: Database.Database,
  operationId: string,
  extractor: FacebookExtractor,
  signal?: AbortSignal,
) {
  const operation = getOperation(database, operationId);
  if (!operation?.postId || !operation.campaignId || operation.kind !== "post.extract") {
    throw new Error("La operacion de extraccion no es valida.");
  }
  if ((operation.result as { domainCommitted?: unknown } | null)?.domainCommitted === true
    || operationDomainCommitted(database, operationId)) {
    return getFacebookCampaignSnapshot(database, operation.campaignId)!;
  }
  const post = database.prepare("SELECT source_url FROM posts WHERE id = ?")
    .get(operation.postId) as { source_url: string } | undefined;
  if (!post) throw new FacebookError("POST_NOT_FOUND", "La publicacion no existe.", 404);
  database.transaction(() => {
    database.prepare(`
      UPDATE posts SET status = 'extracting', context_status = 'extracting', error = NULL, updated_at = ? WHERE id = ?
    `).run(Date.now(), operation.postId);
    touchCampaign(database, operation.campaignId!);
  })();
  try {
    const extraction = await extractor.extract(post.source_url, signal);
    database.transaction(() => {
      assertOperationNotCancelled(database, operationId, signal);
      persistExtraction(database, operationId, extraction);
      queueAutomaticGeneration(database, operation.postId!);
    }).immediate();
    return getFacebookCampaignSnapshot(database, operation.campaignId)!;
  } catch (error) {
    markExtractionFailure(database, operationId, error);
    throw error;
  }
}

export function parseGeneratedFacebookComments(
  content: string,
  assignmentIds: string[],
  minWords: number,
  maxWords: number,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
  } catch {
    throw new FacebookError("INVALID_MODEL_RESPONSE", "DeepSeek devolvio JSON invalido.", 502);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FacebookError("INVALID_MODEL_RESPONSE", "DeepSeek devolvio una respuesta invalida.", 502);
  }
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !Array.isArray(root.comments) || root.comments.length !== assignmentIds.length) {
    throw new FacebookError("INVALID_MODEL_RESPONSE", "DeepSeek no devolvio la cantidad exacta de comentarios.", 502);
  }
  const expected = new Set(assignmentIds);
  const seen = new Set<string>();
  const comments = root.comments.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new FacebookError("INVALID_MODEL_RESPONSE", "DeepSeek devolvio un comentario invalido.", 502);
    }
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || typeof row.assignmentId !== "string" || typeof row.text !== "string") {
      throw new FacebookError("INVALID_MODEL_RESPONSE", "Cada comentario debe identificar assignmentId y text.", 502);
    }
    const text = row.text.trim();
    const words = text.split(/\s+/u).filter(Boolean).length;
    if (!expected.has(row.assignmentId) || seen.has(row.assignmentId) || text.length < 2 || text.length > 500 || words < minWords || words > maxWords) {
      throw new FacebookError("INVALID_MODEL_RESPONSE", "DeepSeek devolvio comentarios fuera del contrato esperado.", 502);
    }
    seen.add(row.assignmentId);
    return { assignmentId: row.assignmentId, text };
  });
  if (seen.size !== expected.size) throw new FacebookError("INVALID_MODEL_RESPONSE", "Faltan asignaciones en la respuesta de DeepSeek.", 502);
  return comments;
}

async function callDeepSeek(
  assignments: Array<{ id: string; intention: string; tone: string }>,
  context: string,
  fetcher: DeepSeekFetch,
  signal?: AbortSignal,
  apiKey = appConfig.deepSeekApiKey,
) {
  if (!apiKey) throw new FacebookError("DEEPSEEK_NOT_CONFIGURED", "Falta API_DEEPSEEK en el servidor.", 503);
  const timeout = AbortSignal.timeout(appConfig.deepSeekTimeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetcher("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: appConfig.deepSeekModel,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `${appConfig.commentGenerationPrompt}\nDevuelve solo JSON con la forma {"comments":[{"assignmentId":"...","text":"..."}]}. Genera exactamente un comentario por assignmentId, entre ${appConfig.commentMinWords} y ${appConfig.commentMaxWords} palabras y 2..500 caracteres.`,
        },
        { role: "user", content: JSON.stringify({ context, assignments }) },
      ],
    }),
    signal: requestSignal,
  });
  if (!response.ok) {
    throw new FacebookError(
      response.status === 401 ? "DEEPSEEK_AUTH_FAILED" : "DEEPSEEK_ERROR",
      response.status === 401 ? "DeepSeek rechazo API_DEEPSEEK." : `DeepSeek respondio HTTP ${response.status}.`,
      response.status === 401 ? 503 : 502,
      { providerStatus: response.status },
    );
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new FacebookError("EMPTY_MODEL_RESPONSE", "DeepSeek no devolvio comentarios.", 502);
  }
  return parseGeneratedFacebookComments(
    content,
    assignments.map((assignment) => assignment.id),
    appConfig.commentMinWords,
    appConfig.commentMaxWords,
  );
}

function currentCommentRows(database: Database.Database, postId: string) {
  return database.prepare(`
    SELECT a.id, c.version, c.intention, c.tone, c.source, c.status, c.stale
    FROM assignments a JOIN comments c ON c.assignment_id = a.id
    WHERE a.post_id = ? AND c.version = (
      SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = a.id
    )
    ORDER BY a.created_at, a.id
  `).all(postId) as Array<{
    id: string;
    version: number;
    intention: string;
    tone: string;
    source: "generated" | "manual";
    status: string;
    stale: 0 | 1;
  }>;
}

function markGenerationFailure(database: Database.Database, operationId: string, error: unknown, contextHash: string) {
  const operation = getOperation(database, operationId);
  if (!operation?.postId || !operation.campaignId) return;
  const current = database.prepare("SELECT context_hash, status FROM posts WHERE id = ?")
    .get(operation.postId) as { context_hash: string | null; status: string } | undefined;
  const campaign = database.prepare("SELECT status FROM campaigns WHERE id = ?")
    .get(operation.campaignId) as { status: string };
  if (campaign.status === "cancelled" || !current) return;
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  database.transaction(() => {
    if (operationCancellationRequested(database, operationId)) {
      database.prepare("UPDATE posts SET status = 'context_ready', error = ?, updated_at = ? WHERE id = ?")
        .run("Generacion cancelada por el operador.", now, operation.postId);
      database.prepare("UPDATE assignments SET status = 'pending', updated_at = ? WHERE post_id = ? AND status = 'generating'")
        .run(now, operation.postId);
      database.prepare(`
        UPDATE comments SET status = 'failed', stale = 1,
          error = 'Generacion cancelada por el operador.', updated_at = ?
        WHERE assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
          AND version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = comments.assignment_id)
          AND status IN ('generating', 'regenerating')
      `).run(now, operation.postId);
      touchCampaign(database, operation.campaignId!, now);
      return;
    }
    if (current.context_hash !== contextHash || current.status !== "generating") return;
    database.prepare("UPDATE posts SET status = 'partial_failed', error = ?, updated_at = ? WHERE id = ?")
      .run(message, now, operation.postId);
    database.prepare("UPDATE assignments SET status = 'failed', updated_at = ? WHERE post_id = ? AND status = 'generating'")
      .run(now, operation.postId);
    database.prepare(`
      UPDATE comments SET status = 'failed', error = ?, updated_at = ?
      WHERE assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
        AND version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = comments.assignment_id)
        AND status IN ('generating', 'regenerating')
    `).run(message, now, operation.postId);
    touchCampaign(database, operation.campaignId!, now);
  })();
}

export async function generateFacebookComments(
  database: Database.Database,
  operationId: string,
  fetcher: DeepSeekFetch = fetch,
  signal?: AbortSignal,
  apiKey = appConfig.deepSeekApiKey,
) {
  const operation = getOperation(database, operationId);
  if (!operation?.postId || !operation.campaignId || operation.kind !== "comments.generate") {
    throw new Error("La operacion de generacion no es valida.");
  }
  if ((operation.result as { domainCommitted?: unknown } | null)?.domainCommitted === true
    || operationDomainCommitted(database, operationId)) {
    return getFacebookCampaignSnapshot(database, operation.campaignId)!;
  }
  const request = objectValue(operation.request);
  const overwriteManual = request.overwriteManual === true;
  const post = database.prepare(`
    SELECT context, context_hash, context_status FROM posts WHERE id = ?
  `).get(operation.postId) as { context: string | null; context_hash: string | null; context_status: string } | undefined;
  if (!post?.context?.trim() || !post.context_hash || !["ready", "cached", "edited"].includes(post.context_status)) {
    throw new FacebookError("CONTEXT_INVALID", "La generacion requiere un contexto valido.", 409);
  }
  const assignments = currentCommentRows(database, operation.postId);
  if (!assignments.length) throw new FacebookError("ASSIGNMENTS_MISSING", "La publicacion no tiene asignaciones de comentario.", 409);
  if (!overwriteManual && assignments.some((assignment) => assignment.source === "manual" || assignment.status === "edited")) {
    throw new FacebookError("MANUAL_COMMENTS_PRESENT", "Confirma antes de sobrescribir comentarios editados manualmente.", 409);
  }
  const now = Date.now();
  database.transaction(() => {
    database.prepare("UPDATE posts SET status = 'generating', error = NULL, updated_at = ? WHERE id = ?")
      .run(now, operation.postId);
    database.prepare("UPDATE assignments SET status = 'generating', updated_at = ? WHERE post_id = ?")
      .run(now, operation.postId);
    database.prepare(`
      UPDATE comments SET status = ?, error = NULL, updated_at = ?
      WHERE assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
        AND version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = comments.assignment_id)
    `).run(assignments.some((assignment) => assignment.status === "ready" || assignment.status === "edited") ? "regenerating" : "generating", now, operation.postId);
    touchCampaign(database, operation.campaignId!);
  })();

  try {
    const generated = await callDeepSeek(assignments, post.context, fetcher, signal, apiKey);
    assertOperationNotCancelled(database, operationId, signal);
    const byAssignment = new Map(generated.map((comment) => [comment.assignmentId, comment.text]));
    database.transaction(() => {
      assertOperationNotCancelled(database, operationId, signal);
      const currentPost = database.prepare("SELECT context_hash FROM posts WHERE id = ?").get(operation.postId) as { context_hash: string | null };
      if (currentPost.context_hash !== post.context_hash) {
        throw new FacebookError("CONTEXT_CHANGED", "El contexto cambio durante la generacion; la respuesta fue descartada.", 409);
      }
      const savedAt = Date.now();
      for (const assignment of assignments) {
        const text = byAssignment.get(assignment.id);
        if (!text) throw new FacebookError("INVALID_MODEL_RESPONSE", "Falta un comentario generado.", 502);
        database.prepare(`
          INSERT INTO comments (
            id, assignment_id, version, intention, tone, text, status, stale,
            source, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 0, 'generated', NULL, ?, ?)
        `).run(randomUUID(), assignment.id, assignment.version + 1, assignment.intention, assignment.tone, text, savedAt, savedAt);
      }
      database.prepare("UPDATE assignments SET status = 'draft', updated_at = ? WHERE post_id = ?")
        .run(savedAt, operation.postId);
      database.prepare("UPDATE posts SET status = 'ready', error = NULL, updated_at = ? WHERE id = ?")
        .run(savedAt, operation.postId);
      database.prepare(`
        UPDATE campaigns SET status = CASE
          WHEN NOT EXISTS (SELECT 1 FROM posts WHERE campaign_id = ? AND status != 'ready') THEN 'ready'
          ELSE 'preparing' END
        WHERE id = ?
      `).run(operation.campaignId, operation.campaignId);
      database.prepare("UPDATE operations SET result_json = ?, updated_at = ? WHERE id = ?")
        .run(stableJson({ domainCommitted: true }), savedAt, operationId);
      database.prepare("UPDATE jobs SET result_json = ?, updated_at = ? WHERE operation_id = ?")
        .run(stableJson({ domainCommitted: true }), savedAt, operationId);
      touchCampaign(database, operation.campaignId!, savedAt);
    }).immediate();
    return getFacebookCampaignSnapshot(database, operation.campaignId)!;
  } catch (error) {
    markGenerationFailure(database, operationId, error, post.context_hash);
    throw error;
  }
}
