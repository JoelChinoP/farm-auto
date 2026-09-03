import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export type Job<T = unknown> = {
  id: string;
  kind: string;
  payload: T;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  lockOwner: string | null;
  lockedAt: number | null;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

type JobRow = {
  id: string;
  kind: string;
  payload_json: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: number;
  lock_owner: string | null;
  locked_at: number | null;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

function mapJob<T>(row: JobRow): Job<T> {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as T,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockOwner: row.lock_owner,
    lockedAt: row.locked_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function enqueueJob<T>(
  database: Database.Database,
  kind: string,
  payload: T,
  options: { priority?: number; maxAttempts?: number; availableAt?: number } = {},
) {
  const normalizedKind = kind.trim();
  const maxAttempts = options.maxAttempts ?? 3;
  const now = Date.now();
  const payloadJson = JSON.stringify(payload);
  if (!normalizedKind) throw new TypeError("El tipo de job es obligatorio.");
  if (payloadJson === undefined) throw new TypeError("El payload debe ser serializable como JSON.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new RangeError("maxAttempts debe ser un entero entre 1 y 100.");
  }

  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO jobs (
        id, kind, payload_json, status, priority, attempts, max_attempts,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      normalizedKind,
      payloadJson,
      options.priority ?? 0,
      maxAttempts,
      options.availableAt ?? now,
      now,
      now,
    );

  return getJob<T>(database, id)!;
}

export function getJob<T = unknown>(database: Database.Database, id: string) {
  const row = database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? mapJob<T>(row) : null;
}

export function claimNextJob<T = unknown>(
  database: Database.Database,
  workerId: string,
  now = Date.now(),
) {
  if (!workerId.trim()) throw new TypeError("workerId es obligatorio.");

  const row = database
    .prepare(
      `UPDATE jobs
       SET status = 'running', attempts = attempts + 1, lock_owner = ?,
           locked_at = ?, updated_at = ?, error = NULL
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY priority DESC, available_at, created_at
         LIMIT 1
       ) AND status = 'pending'
       RETURNING *`,
    )
    .get(workerId.trim(), now, now, now) as JobRow | undefined;

  return row ? mapJob<T>(row) : null;
}

export function completeJob(
  database: Database.Database,
  id: string,
  workerId: string,
  result: unknown = null,
) {
  const now = Date.now();
  const resultJson = JSON.stringify(result);
  if (resultJson === undefined) throw new TypeError("El resultado debe ser serializable como JSON.");

  const updated = database
    .prepare(
      `UPDATE jobs
       SET status = 'succeeded', result_json = ?, lock_owner = NULL,
           locked_at = NULL, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'running' AND lock_owner = ?`,
    )
    .run(resultJson, now, now, id, workerId.trim());
  if (updated.changes !== 1) throw new Error("El job no pertenece a este worker o ya termino.");
  return getJob(database, id)!;
}

export function failJob(
  database: Database.Database,
  id: string,
  workerId: string,
  error: unknown,
  retryDelayMs = 0,
) {
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();

  return database.transaction(() => {
    const current = database
      .prepare(
        `SELECT attempts, max_attempts FROM jobs
         WHERE id = ? AND status = 'running' AND lock_owner = ?`,
      )
      .get(id, workerId.trim()) as { attempts: number; max_attempts: number } | undefined;
    if (!current) throw new Error("El job no pertenece a este worker o ya termino.");

    const retry = current.attempts < current.max_attempts;
    database
      .prepare(
        `UPDATE jobs
         SET status = ?, available_at = ?, lock_owner = NULL, locked_at = NULL,
             error = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        retry ? "pending" : "failed",
        now + Math.max(0, retryDelayMs),
        message,
        now,
        retry ? null : now,
        id,
      );
    return getJob(database, id)!;
  })();
}

export function recoverStaleJobs(
  database: Database.Database,
  staleBefore: number,
  now = Date.now(),
) {
  return database
    .prepare(
      `UPDATE jobs
       SET status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
           available_at = CASE WHEN attempts < max_attempts THEN ? ELSE available_at END,
           lock_owner = NULL, locked_at = NULL,
           error = 'Worker interrumpido', updated_at = ?,
           completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE ? END
       WHERE status = 'running' AND locked_at <= ?`,
    )
    .run(now, now, now, staleBefore).changes;
}

export function getQueueStats(database: Database.Database) {
  const stats: Record<JobStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
  };
  const rows = database
    .prepare("SELECT status, COUNT(*) AS total FROM jobs GROUP BY status")
    .all() as Array<{ status: JobStatus; total: number }>;
  for (const row of rows) stats[row.status] = row.total;
  return stats;
}
