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
  status: "draft" | "approved" | "sent" | "failed";
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
  `);
  database
    .prepare(
      `UPDATE operations
       SET status = 'failed', error = 'La ejecución fue interrumpida al reiniciar el panel.', updated_at = ?
       WHERE status IN ('starting', 'running')`,
    )
    .run(new Date().toISOString());
  database.prepare("DELETE FROM device_locks").run();
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
  status: "sent" | "failed",
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
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  db.prepare("DELETE FROM device_locks WHERE acquired_at < ?").run(staleBefore);
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

export function releaseDeviceLock(deviceId: string, operationId: string) {
  db.prepare(
    "DELETE FROM device_locks WHERE device_id = ? AND operation_id = ?",
  ).run(deviceId, operationId);
}
