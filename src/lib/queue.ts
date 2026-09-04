import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import { EFFECT_PHASES } from "./domain.ts";
import type { EffectPhase } from "./domain.ts";
import { IdempotencyConflictError, stableJson } from "./operations.ts";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";

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
  campaignId: string | null;
  postId: string | null;
  assignmentId: string | null;
  operationId: string | null;
  cancellationRequestedAt: number | null;
  effectPhase: EffectPhase;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

function optionalId(value: string | undefined, name: string) {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} no puede estar vacio.`);
  return normalized;
}

type JobRow = {
  id: string;
  kind: string;
  payload_json: string;
  request_hash: string | null;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: number;
  lock_owner: string | null;
  locked_at: number | null;
  result_json: string | null;
  error: string | null;
  campaign_id: string | null;
  post_id: string | null;
  assignment_id: string | null;
  operation_id: string | null;
  cancellation_requested_at: number | null;
  effect_phase: EffectPhase;
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
    campaignId: row.campaign_id,
    postId: row.post_id,
    assignmentId: row.assignment_id,
    operationId: row.operation_id,
    cancellationRequestedAt: row.cancellation_requested_at,
    effectPhase: row.effect_phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function assertRuntimeOwner(database: Database.Database, workerId: string, now: number) {
  const owner = workerId.trim();
  if (!owner) throw new TypeError("workerId es obligatorio.");
  const row = database.prepare(`
    SELECT 1 FROM runtime_ownership
    WHERE singleton = 1 AND owner = ? AND expires_at > ?
  `).get(owner, now);
  if (!row) throw new Error("El worker no mantiene el lease del runtime.");
  return owner;
}

function syncOperationForJob(database: Database.Database, job: Job, now: number) {
  if (!job.operationId) return;
  database.prepare(`
    UPDATE operations
    SET status = ?, effect_phase = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `).run(
    job.status,
    job.effectPhase,
    job.status === "succeeded" ? stableJson(job.result) : null,
    job.error,
    now,
    ["pending", "running"].includes(job.status) ? null : now,
    job.operationId,
  );
}

export function enqueueJob<T>(
  database: Database.Database,
  kind: string,
  payload: T,
  options: {
    priority?: number;
    maxAttempts?: number;
    availableAt?: number;
    campaignId?: string;
    postId?: string;
    assignmentId?: string;
    operationId?: string;
    effectPhase?: EffectPhase;
  } = {},
) {
  const normalizedKind = kind.trim();
  const maxAttempts = options.maxAttempts ?? 3;
  const now = Date.now();
  const payloadJson = stableJson(payload);
  const effectPhase = options.effectPhase ?? "none";
  if (!normalizedKind) throw new TypeError("El tipo de job es obligatorio.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new RangeError("maxAttempts debe ser un entero entre 1 y 100.");
  }
  if (!EFFECT_PHASES.includes(effectPhase)) throw new TypeError("La fase de efecto no es valida.");
  if (!["none", "before_effect"].includes(effectPhase)) {
    throw new TypeError("Un job nuevo no puede comenzar despues de una posible frontera de efecto.");
  }

  const campaignId = optionalId(options.campaignId, "campaignId");
  const postId = optionalId(options.postId, "postId");
  const assignmentId = optionalId(options.assignmentId, "assignmentId");
  const operationId = optionalId(options.operationId, "operationId");
  const requestHash = createHash("sha256").update(stableJson({
    assignmentId,
    availableAt: options.availableAt ?? null,
    campaignId,
    effectPhase,
    kind: normalizedKind,
    maxAttempts,
    operationId,
    payload: JSON.parse(payloadJson),
    postId,
    priority: options.priority ?? 0,
  })).digest("hex");
  return database.transaction(() => {
    if (operationId) {
      const previous = database.prepare("SELECT * FROM jobs WHERE operation_id = ?").get(operationId) as JobRow | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) throw new IdempotencyConflictError();
        return mapJob<T>(previous);
      }

      const operation = database.prepare("SELECT status FROM operations WHERE id = ?").get(operationId) as { status: string } | undefined;
      if (!operation) throw new Error("La operacion no existe.");
      if (operation.status !== "pending") throw new Error("La operacion ya termino o esta en ejecucion.");
    }

    const id = randomUUID();
    database.prepare(
      `INSERT INTO jobs (
        id, kind, payload_json, request_hash, status, priority, attempts, max_attempts,
        available_at, campaign_id, post_id, assignment_id, operation_id,
        effect_phase, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      normalizedKind,
      payloadJson,
      requestHash,
      options.priority ?? 0,
      maxAttempts,
      options.availableAt ?? now,
      campaignId,
      postId,
      assignmentId,
      operationId,
      effectPhase,
      now,
      now,
    );
    return getJob<T>(database, id)!;
  }).immediate();
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
  return database.transaction(() => {
    const owner = assertRuntimeOwner(database, workerId, now);
    const row = database.prepare(
      `UPDATE jobs
       SET status = 'running', attempts = attempts + 1, lock_owner = ?,
           locked_at = ?, updated_at = ?, error = NULL
       WHERE id = (
          SELECT candidate.id FROM jobs AS candidate
           WHERE candidate.status = 'pending'
             AND candidate.cancellation_requested_at IS NULL
             AND candidate.effect_phase IN ('none', 'before_effect')
             AND candidate.available_at <= ?
             AND (
               candidate.operation_id IS NULL OR EXISTS (
                 SELECT 1 FROM operations
                 WHERE operations.id = candidate.operation_id AND operations.status = 'pending'
               )
             )
          ORDER BY candidate.priority DESC, candidate.available_at, candidate.created_at
         LIMIT 1
       ) AND status = 'pending'
       RETURNING *`,
    ).get(owner, now, now, now) as JobRow | undefined;
    if (!row) return null;
    const job = mapJob<T>(row);
    syncOperationForJob(database, job, now);
    return job;
  }).immediate();
}

export function completeJob(
  database: Database.Database,
  id: string,
  workerId: string,
  result: unknown = null,
) {
  const resultJson = stableJson(result);
  return database.transaction(() => {
    const owner = assertRuntimeOwner(database, workerId, Date.now());
    const current = getJob(database, id);
    if (!current) throw new Error("El job no existe.");
    if (current.status === "succeeded") {
      if (stableJson(current.result) !== resultJson) throw new Error("El job ya termino con otro resultado.");
      return current;
    }
    if (current.status !== "running" || current.lockOwner !== owner) {
      throw new Error("El job no pertenece a este worker o ya termino.");
    }
    if (current.effectPhase === "effect_possible") {
      throw new Error("El posible efecto publico debe confirmarse o terminar como outcome_unknown.");
    }

    const now = Date.now();
    if (current.cancellationRequestedAt !== null && current.effectPhase !== "effect_confirmed") {
      database.prepare(`
        UPDATE jobs
        SET status = 'cancelled', result_json = ?, lock_owner = NULL,
            locked_at = NULL, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND lock_owner = ?
      `).run(resultJson, now, now, id, owner);
      const job = getJob(database, id)!;
      syncOperationForJob(database, job, now);
      return job;
    }
    database.prepare(
      `UPDATE jobs
       SET status = 'succeeded', result_json = ?, lock_owner = NULL,
            locked_at = NULL, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND lock_owner = ?`,
    ).run(resultJson, now, now, id, owner);
    const job = getJob(database, id)!;
    syncOperationForJob(database, job, now);
    return job;
  }).immediate();
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
    const owner = assertRuntimeOwner(database, workerId, now);
    const current = database
      .prepare(
        `SELECT attempts, max_attempts, cancellation_requested_at, effect_phase FROM jobs
         WHERE id = ? AND status = 'running' AND lock_owner = ?`,
      )
      .get(id, owner) as {
        attempts: number;
        max_attempts: number;
        cancellation_requested_at: number | null;
        effect_phase: EffectPhase;
      } | undefined;
    if (!current) {
      const finished = getJob(database, id);
      if (finished && finished.status !== "running" && finished.error === message) return finished;
      throw new Error("El job no pertenece a este worker o ya termino.");
    }

    const retry = current.effect_phase === "none" || current.effect_phase === "before_effect"
      ? current.cancellation_requested_at === null && current.attempts < current.max_attempts
      : false;
    const status: JobStatus = current.effect_phase === "effect_possible"
      ? "outcome_unknown"
      : current.cancellation_requested_at !== null && current.effect_phase !== "effect_confirmed"
        ? "cancelled"
        : retry
          ? "pending"
          : "failed";
    database
      .prepare(
        `UPDATE jobs
         SET status = ?, available_at = ?, lock_owner = NULL, locked_at = NULL,
             error = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        now + Math.max(0, retryDelayMs),
        message,
        now,
        retry ? null : now,
        id,
      );
    const job = getJob(database, id)!;
    syncOperationForJob(database, job, now);
    return job;
  }).immediate();
}

export function recoverStaleJobs(
  database: Database.Database,
  workerId: string,
  now = Date.now(),
) {
  return database.transaction(() => {
    const owner = assertRuntimeOwner(database, workerId, now);
    const rows = database.prepare(
      `UPDATE jobs
       SET status = CASE
              WHEN effect_phase = 'effect_possible' THEN 'outcome_unknown'
              WHEN effect_phase = 'effect_confirmed' THEN 'failed'
              WHEN cancellation_requested_at IS NOT NULL THEN 'cancelled'
              WHEN attempts < max_attempts THEN 'pending'
              ELSE 'failed'
            END,
            available_at = CASE
              WHEN effect_phase IN ('none', 'before_effect')
                AND cancellation_requested_at IS NULL
                AND attempts < max_attempts THEN ?
              ELSE available_at
            END,
            lock_owner = NULL, locked_at = NULL,
            error = CASE
              WHEN effect_phase = 'effect_possible' THEN 'Worker interrumpido despues de un posible efecto publico'
              ELSE 'Worker interrumpido'
            END,
            updated_at = ?,
            completed_at = CASE
              WHEN effect_phase IN ('none', 'before_effect')
                AND cancellation_requested_at IS NULL
                AND attempts < max_attempts THEN NULL
              ELSE ?
            END
        WHERE status = 'running' AND lock_owner != ?
        RETURNING *`,
    ).all(now, now, now, owner) as JobRow[];
    for (const row of rows) syncOperationForJob(database, mapJob(row), now);
    return rows.length;
  }).immediate();
}

export function markJobEffectPhase(
  database: Database.Database,
  id: string,
  workerId: string,
  effectPhase: EffectPhase,
) {
  return database.transaction(() => {
    const owner = assertRuntimeOwner(database, workerId, Date.now());
    const current = database
      .prepare("SELECT * FROM jobs WHERE id = ? AND status = 'running' AND lock_owner = ?")
      .get(id, owner) as JobRow | undefined;
    if (!current) throw new Error("El job no pertenece a este worker o ya termino.");

    const currentIndex = EFFECT_PHASES.indexOf(current.effect_phase);
    const nextIndex = EFFECT_PHASES.indexOf(effectPhase);
    if (nextIndex < currentIndex) throw new Error("La fase de efecto no puede retroceder.");
    if (nextIndex === currentIndex) return mapJob(current);

    const now = Date.now();
    const updated = database.prepare(`
      UPDATE jobs SET effect_phase = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lock_owner = ? AND effect_phase = ?
    `).run(effectPhase, now, id, owner, current.effect_phase);
    if (updated.changes !== 1) throw new Error("El job cambio de propietario durante la operacion.");
    const job = getJob(database, id)!;
    syncOperationForJob(database, job, now);
    return job;
  }).immediate();
}

export function requestJobCancellation(database: Database.Database, id: string, now = Date.now()) {
  return database.transaction(() => {
    const job = getJob(database, id);
    if (!job) throw new Error("El job no existe.");
    if (["succeeded", "failed", "cancelled", "outcome_unknown"].includes(job.status)) return job;

    if (job.status === "pending") {
      database.prepare(`
        UPDATE jobs
        SET status = 'cancelled', cancellation_requested_at = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, now, now, id);
    } else if (job.cancellationRequestedAt === null) {
      database.prepare("UPDATE jobs SET cancellation_requested_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id);
    }
    const updated = getJob(database, id)!;
    syncOperationForJob(database, updated, now);
    return updated;
  }).immediate();
}

export function getQueueStats(database: Database.Database) {
  const stats: Record<JobStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    outcome_unknown: 0,
  };
  const rows = database
    .prepare("SELECT status, COUNT(*) AS total FROM jobs GROUP BY status")
    .all() as Array<{ status: JobStatus; total: number }>;
  for (const row of rows) stats[row.status] = row.total;
  return stats;
}
