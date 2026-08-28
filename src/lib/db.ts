import "server-only";

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";

type RegistryRow = {
  slug: string;
  device_id: string;
  app_id: string;
  task_id: string;
  package_hash: string;
  updated_at: string;
};

export type DraftRow = {
  id: string;
  kind: "social_comment" | "direct_message";
  platform: "tiktok" | "facebook" | "whatsapp";
  context: string;
  intent: string;
  tone: string;
  text: string;
  status:
    | "draft"
    | "approved"
    | "running"
    | "sent"
    | "failed"
    | "outcome_unknown";
  consent_confirmed: number;
  recipient: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
  error: string | null;
};

export type OperationRow = {
  id: string;
  kind: string;
  idempotency_key: string;
  device_id: string;
  status: "starting" | "running" | "succeeded" | "failed";
  run_id: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type FacebookBatchRow = {
  id: string;
  status: "active" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
};

export type FacebookPostRow = {
  id: string;
  batch_id: string;
  position: number;
  url: string;
  extracted_context: string | null;
  context: string | null;
  status:
    | "queued"
    | "extracting"
    | "context_ready"
    | "generating"
    | "drafts_ready"
    | "approving"
    | "approved"
    | "running"
    | "completed"
    | "partial_failed"
    | "outcome_unknown"
    | "skipped";
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type FacebookAssignmentRow = {
  id: string;
  post_id: string;
  device_id: string;
  intent: string;
  tone: string;
  draft_id: string | null;
  status:
    | "pending"
    | "generating"
    | "draft"
    | "approved"
    | "running"
    | "sent"
    | "failed"
    | "outcome_unknown";
  error: string | null;
  created_at: string;
  updated_at: string;
};

const globalDatabase = globalThis as typeof globalThis & {
  controlPanelDatabase?: Database.Database;
};

function createDatabase() {
  mkdirSync(dirname(appConfig.databasePath), { recursive: true });
  const database = new Database(appConfig.databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS automation_registry (
      slug TEXT NOT NULL,
      device_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      package_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (slug, device_id)
    );

    CREATE TABLE IF NOT EXISTS message_drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      context TEXT NOT NULL,
      intent TEXT NOT NULL,
      tone TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      consent_confirmed INTEGER NOT NULL DEFAULT 0,
      recipient TEXT,
      approved_at TEXT,
      sent_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_locks (
      device_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facebook_batches (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facebook_posts (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES facebook_batches(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      url TEXT NOT NULL,
      extracted_context TEXT,
      context TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (batch_id, position),
      UNIQUE (batch_id, url)
    );

    CREATE TABLE IF NOT EXISTS facebook_assignments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES facebook_posts(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      tone TEXT NOT NULL,
      draft_id TEXT REFERENCES message_drafts(id),
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (post_id, device_id)
    );

    CREATE INDEX IF NOT EXISTS facebook_posts_batch_position
      ON facebook_posts(batch_id, position);
    CREATE INDEX IF NOT EXISTS facebook_assignments_post
      ON facebook_assignments(post_id);
  `);
  database
    .prepare(
      `UPDATE operations
       SET status = 'failed', error = 'La ejecución fue interrumpida al reiniciar el panel.', updated_at = ?
       WHERE status IN ('starting', 'running')`,
    )
    .run(new Date().toISOString());
  const recoveryTimestamp = new Date().toISOString();
  database
    .prepare(
      `UPDATE message_drafts SET status = 'outcome_unknown',
         error = 'El resultado debe verificarse manualmente después del reinicio.',
         updated_at = ?
       WHERE status = 'running'`,
    )
    .run(recoveryTimestamp);
  database
    .prepare(
      `UPDATE facebook_posts SET
         status = CASE WHEN status = 'running' THEN 'outcome_unknown' ELSE 'partial_failed' END,
         error = CASE
           WHEN status = 'running' THEN 'La ejecución fue interrumpida y su resultado debe verificarse manualmente.'
           ELSE 'La etapa fue interrumpida al reiniciar el panel.'
         END,
         updated_at = ?
       WHERE status IN ('extracting', 'generating', 'approving', 'running')`,
    )
    .run(recoveryTimestamp);
  database
    .prepare(
      `UPDATE facebook_assignments SET
         status = CASE WHEN status = 'running' THEN 'outcome_unknown' ELSE 'failed' END,
         error = CASE
           WHEN status = 'running' THEN 'El resultado público debe verificarse manualmente.'
           ELSE 'La generación fue interrumpida al reiniciar el panel.'
         END,
         updated_at = ?
       WHERE status IN ('generating', 'running')`,
    )
    .run(recoveryTimestamp);
  database
    .prepare(
      `UPDATE facebook_assignments SET status = 'failed',
         error = 'La ejecución se interrumpió antes de iniciar esta asignación.',
         updated_at = ?
       WHERE status = 'approved' AND post_id IN (
         SELECT id FROM facebook_posts WHERE status = 'outcome_unknown'
       )`,
    )
    .run(recoveryTimestamp);
  database
    .prepare(
      `UPDATE facebook_posts SET
         status = CASE
           WHEN EXISTS (
             SELECT 1 FROM facebook_assignments
             WHERE facebook_assignments.post_id = facebook_posts.id
               AND facebook_assignments.status = 'outcome_unknown'
           ) THEN 'outcome_unknown'
           WHEN EXISTS (
             SELECT 1 FROM facebook_assignments
             WHERE facebook_assignments.post_id = facebook_posts.id
               AND facebook_assignments.status = 'failed'
           ) THEN 'partial_failed'
           WHEN EXISTS (
             SELECT 1 FROM facebook_assignments
             WHERE facebook_assignments.post_id = facebook_posts.id
           ) AND NOT EXISTS (
             SELECT 1 FROM facebook_assignments
             WHERE facebook_assignments.post_id = facebook_posts.id
               AND facebook_assignments.status <> 'sent'
           ) THEN 'completed'
           ELSE 'partial_failed'
         END,
         error = CASE
           WHEN EXISTS (
             SELECT 1 FROM facebook_assignments
             WHERE facebook_assignments.post_id = facebook_posts.id
               AND facebook_assignments.status = 'outcome_unknown'
           ) THEN 'Hay resultados públicos pendientes de verificación manual.'
           WHEN EXISTS (
             SELECT 1 FROM facebook_assignments
             WHERE facebook_assignments.post_id = facebook_posts.id
               AND facebook_assignments.status = 'failed'
           ) THEN 'La ejecución interrumpida dejó asignaciones no enviadas.'
           ELSE NULL
         END,
         updated_at = ?
       WHERE status = 'outcome_unknown'`,
    )
    .run(recoveryTimestamp);
  database
    .prepare(
      `UPDATE facebook_batches SET status = 'completed', updated_at = ?
       WHERE status = 'active' AND NOT EXISTS (
         SELECT 1 FROM facebook_posts
         WHERE facebook_posts.batch_id = facebook_batches.id
           AND facebook_posts.status NOT IN ('completed', 'skipped')
       )`,
    )
    .run(recoveryTimestamp);
  return database;
}

export const db =
  globalDatabase.controlPanelDatabase ??
  (globalDatabase.controlPanelDatabase = createDatabase());

function now() {
  return new Date().toISOString();
}

export function getRegistry(slug: string, deviceId: string) {
  return db
    .prepare(
      "SELECT * FROM automation_registry WHERE slug = ? AND device_id = ?",
    )
    .get(slug, deviceId) as RegistryRow | undefined;
}

export function listRegistry() {
  return db
    .prepare("SELECT * FROM automation_registry ORDER BY slug, device_id")
    .all() as RegistryRow[];
}

export function upsertRegistry(input: Omit<RegistryRow, "updated_at">) {
  db.prepare(
    `INSERT INTO automation_registry
       (slug, device_id, app_id, task_id, package_hash, updated_at)
     VALUES (@slug, @device_id, @app_id, @task_id, @package_hash, @updated_at)
     ON CONFLICT(slug, device_id) DO UPDATE SET
       app_id = excluded.app_id,
       task_id = excluded.task_id,
       package_hash = excluded.package_hash,
       updated_at = excluded.updated_at`,
  ).run({ ...input, updated_at: now() });
}

export function createDraft(input: {
  kind: DraftRow["kind"];
  platform: DraftRow["platform"];
  context: string;
  intent: string;
  tone: string;
  text: string;
}) {
  const timestamp = now();
  const draft = {
    id: randomUUID(),
    ...input,
    status: "draft",
    consent_confirmed: 0,
    recipient: null,
    approved_at: null,
    sent_at: null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  } satisfies DraftRow;
  db.prepare(
    `INSERT INTO message_drafts
      (id, kind, platform, context, intent, tone, text, status,
       consent_confirmed, recipient, approved_at, sent_at, error, created_at, updated_at)
     VALUES
      (@id, @kind, @platform, @context, @intent, @tone, @text, @status,
       @consent_confirmed, @recipient, @approved_at, @sent_at, @error, @created_at, @updated_at)`,
  ).run(draft);
  return draft;
}

export function getDraft(id: string) {
  return db.prepare("SELECT * FROM message_drafts WHERE id = ?").get(id) as
    | DraftRow
    | undefined;
}

export function reserveDraftForSend(id: string) {
  const result = db
    .prepare(
      `UPDATE message_drafts SET status = 'running', error = NULL, updated_at = ?
       WHERE id = ? AND status = 'approved'`,
    )
    .run(now(), id);
  if (result.changes !== 1) {
    throw new AppError(
      "El borrador ya no está disponible para ejecución.",
      409,
      "DRAFT_NOT_SENDABLE",
    );
  }
  return getDraft(id)!;
}

export function listDrafts(limit = 20) {
  return db
    .prepare("SELECT * FROM message_drafts ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DraftRow[];
}

export function approveDraft(
  id: string,
  input: { text: string; consentConfirmed: boolean; recipient: string | null },
) {
  const timestamp = now();
  const result = db
    .prepare(
      `UPDATE message_drafts SET
         text = ?, status = 'approved', consent_confirmed = ?, recipient = ?,
         approved_at = ?, updated_at = ?, error = NULL
       WHERE id = ? AND status IN ('draft', 'approved')`,
    )
    .run(
      input.text,
      input.consentConfirmed ? 1 : 0,
      input.recipient,
      timestamp,
      timestamp,
      id,
    );
  if (result.changes !== 1) {
    throw new AppError(
      "El borrador no existe o ya fue enviado.",
      409,
      "DRAFT_NOT_EDITABLE",
    );
  }
  return getDraft(id)!;
}

export function setDraftOutcome(
  id: string,
  status: "approved" | "sent" | "failed" | "outcome_unknown",
  error: string | null = null,
) {
  const timestamp = now();
  db.prepare(
    `UPDATE message_drafts SET status = ?, error = ?, sent_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, error, status === "sent" ? timestamp : null, timestamp, id);
  return getDraft(id)!;
}

export function createOperation(
  kind: string,
  idempotencyKey: string,
  deviceId: string,
) {
  const timestamp = now();
  const operation: OperationRow = {
    id: randomUUID(),
    kind,
    idempotency_key: idempotencyKey,
    device_id: deviceId,
    status: "starting",
    run_id: null,
    result_json: null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO operations
       (id, kind, idempotency_key, device_id, status, run_id, result_json, error, created_at, updated_at)
       VALUES (@id, @kind, @idempotency_key, @device_id, @status, @run_id, @result_json, @error, @created_at, @updated_at)`,
    )
    .run(operation);
  if (result.changes === 1) return { operation, created: true };
  const existing = db
    .prepare("SELECT * FROM operations WHERE idempotency_key = ?")
    .get(idempotencyKey) as OperationRow;
  return { operation: existing, created: false };
}

export function updateOperation(
  id: string,
  values: Partial<Pick<OperationRow, "status" | "run_id" | "result_json" | "error">>,
) {
  const current = db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as
    | OperationRow
    | undefined;
  if (!current) throw new AppError("Operación no encontrada.", 404, "NOT_FOUND");
  const updated = { ...current, ...values, updated_at: now() };
  db.prepare(
    `UPDATE operations SET status = @status, run_id = @run_id,
       result_json = @result_json, error = @error, updated_at = @updated_at
     WHERE id = @id`,
  ).run(updated);
  return updated;
}

export function listOperations(limit = 20) {
  return db
    .prepare("SELECT * FROM operations ORDER BY created_at DESC LIMIT ?")
    .all(limit) as OperationRow[];
}

export function acquireDeviceLock(deviceId: string, operationId: string) {
  try {
    db.prepare(
      "INSERT INTO device_locks (device_id, operation_id, acquired_at) VALUES (?, ?, ?)",
    ).run(deviceId, operationId, now());
  } catch {
    throw new AppError(
      "El dispositivo ya está ejecutando otra acción.",
      409,
      "DEVICE_BUSY",
    );
  }
}

export function getDeviceLock(deviceId: string) {
  return db
    .prepare("SELECT * FROM device_locks WHERE device_id = ?")
    .get(deviceId) as
    | { device_id: string; operation_id: string; acquired_at: string }
    | undefined;
}

export function releaseDeviceLock(deviceId: string, operationId: string) {
  db.prepare(
    "DELETE FROM device_locks WHERE device_id = ? AND operation_id = ?",
  ).run(deviceId, operationId);
}

export function createFacebookBatch(urls: string[]) {
  const timestamp = now();
  const batch: FacebookBatchRow = {
    id: randomUUID(),
    status: "active",
    created_at: timestamp,
    updated_at: timestamp,
  };
  const create = db.transaction(() => {
    const busy = db
      .prepare(
        `SELECT 1 FROM facebook_posts
         JOIN facebook_batches ON facebook_batches.id = facebook_posts.batch_id
         WHERE facebook_batches.status = 'active'
           AND facebook_posts.status IN ('extracting', 'generating', 'approving', 'running', 'outcome_unknown')
         LIMIT 1`,
      )
      .get();
    if (busy) {
      throw new AppError(
        "La cola actual tiene una etapa activa o un resultado pendiente de verificar.",
        409,
        "BATCH_BUSY",
      );
    }
    db.prepare(
      "UPDATE facebook_batches SET status = 'cancelled', updated_at = ? WHERE status = 'active'",
    ).run(timestamp);
    db.prepare(
      `INSERT INTO facebook_batches (id, status, created_at, updated_at)
       VALUES (@id, @status, @created_at, @updated_at)`,
    ).run(batch);
    const insertPost = db.prepare(
      `INSERT INTO facebook_posts
       (id, batch_id, position, url, extracted_context, context, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 'queued', NULL, ?, ?)`,
    );
    urls.forEach((url, position) => {
      insertPost.run(randomUUID(), batch.id, position, url, timestamp, timestamp);
    });
  });
  create();
  return batch;
}

export function getFacebookBatch(id: string) {
  return db.prepare("SELECT * FROM facebook_batches WHERE id = ?").get(id) as
    | FacebookBatchRow
    | undefined;
}

export function getVisibleFacebookBatch() {
  return db
    .prepare(
      `SELECT * FROM facebook_batches
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
    )
    .get() as FacebookBatchRow | undefined;
}

export function updateFacebookBatch(
  id: string,
  status: FacebookBatchRow["status"],
) {
  db.prepare(
    "UPDATE facebook_batches SET status = ?, updated_at = ? WHERE id = ?",
  ).run(status, now(), id);
  return getFacebookBatch(id);
}

export function listFacebookPosts(batchId: string) {
  return db
    .prepare("SELECT * FROM facebook_posts WHERE batch_id = ? ORDER BY position")
    .all(batchId) as FacebookPostRow[];
}

export function getFacebookPost(id: string) {
  return db.prepare("SELECT * FROM facebook_posts WHERE id = ?").get(id) as
    | FacebookPostRow
    | undefined;
}

export function updateFacebookPost(
  id: string,
  values: Partial<
    Pick<
      FacebookPostRow,
      "extracted_context" | "context" | "status" | "error"
    >
  >,
) {
  const current = getFacebookPost(id);
  if (!current) throw new AppError("Publicación no encontrada.", 404, "NOT_FOUND");
  const updated = { ...current, ...values, updated_at: now() };
  db.prepare(
    `UPDATE facebook_posts SET extracted_context = @extracted_context,
       context = @context, status = @status, error = @error, updated_at = @updated_at
     WHERE id = @id`,
  ).run(updated);
  return updated;
}

export function getOperation(id: string) {
  return db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as
    | OperationRow
    | undefined;
}

export function transitionFacebookPost(
  id: string,
  fromStatuses: FacebookPostRow["status"][],
  status: FacebookPostRow["status"],
) {
  if (!fromStatuses.length) {
    throw new AppError("Transición de publicación inválida.", 500, "INVALID_STATE");
  }
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const result = db
    .prepare(
      `UPDATE facebook_posts SET status = ?, error = NULL, updated_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(status, now(), id, ...fromStatuses);
  if (result.changes !== 1) {
    throw new AppError(
      "La publicación cambió de etapa. Actualiza el panel antes de continuar.",
      409,
      "POST_STATE_CHANGED",
    );
  }
  return getFacebookPost(id)!;
}

export function listFacebookAssignments(postId: string) {
  return db
    .prepare(
      "SELECT * FROM facebook_assignments WHERE post_id = ? ORDER BY created_at, id",
    )
    .all(postId) as FacebookAssignmentRow[];
}

export function getFacebookAssignment(id: string) {
  return db.prepare("SELECT * FROM facebook_assignments WHERE id = ?").get(id) as
    | FacebookAssignmentRow
    | undefined;
}

export function getFacebookAssignmentByDraftId(draftId: string) {
  return db
    .prepare("SELECT * FROM facebook_assignments WHERE draft_id = ?")
    .get(draftId) as FacebookAssignmentRow | undefined;
}

export function replaceFacebookAssignments(
  postId: string,
  assignments: Array<{ deviceId: string; intent: string; tone: string }>,
) {
  const timestamp = now();
  const rows: FacebookAssignmentRow[] = assignments.map((assignment) => ({
    id: randomUUID(),
    post_id: postId,
    device_id: assignment.deviceId,
    intent: assignment.intent,
    tone: assignment.tone,
    draft_id: null,
    status: "pending",
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  }));
  const replace = db.transaction(() => {
    db.prepare(
      `UPDATE message_drafts SET status = 'failed',
         error = 'Este borrador fue reemplazado por una nueva distribución.', updated_at = ?
       WHERE id IN (
         SELECT draft_id FROM facebook_assignments
         WHERE post_id = ? AND draft_id IS NOT NULL
       ) AND status IN ('draft', 'approved')`,
    ).run(timestamp, postId);
    db.prepare("DELETE FROM facebook_assignments WHERE post_id = ?").run(postId);
    const insert = db.prepare(
      `INSERT INTO facebook_assignments
       (id, post_id, device_id, intent, tone, draft_id, status, error, created_at, updated_at)
       VALUES (@id, @post_id, @device_id, @intent, @tone, @draft_id, @status, @error, @created_at, @updated_at)`,
    );
    rows.forEach((row) => insert.run(row));
  });
  replace();
  return rows;
}

export function updateFacebookAssignment(
  id: string,
  values: Partial<
    Pick<FacebookAssignmentRow, "draft_id" | "status" | "error">
  >,
) {
  const current = getFacebookAssignment(id);
  if (!current) throw new AppError("Asignación no encontrada.", 404, "NOT_FOUND");
  const updated = { ...current, ...values, updated_at: now() };
  db.prepare(
    `UPDATE facebook_assignments SET draft_id = @draft_id, status = @status,
       error = @error, updated_at = @updated_at WHERE id = @id`,
  ).run(updated);
  return updated;
}
