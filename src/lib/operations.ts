import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import { OPERATION_KINDS } from "./domain.ts";
import type {
  CleanupStatus,
  EffectPhase,
  OperationKind,
  OperationStatus,
  SessionStatus,
} from "./domain.ts";

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("La clave idempotente ya fue usada con una solicitud diferente.");
    this.name = "IdempotencyConflictError";
  }
}

export type Operation = {
  id: string;
  kind: OperationKind;
  idempotencyKey: string;
  request: unknown;
  status: OperationStatus;
  campaignId: string | null;
  postId: string | null;
  assignmentId: string | null;
  deviceId: string | null;
  effectPhase: EffectPhase;
  sessionStatus: SessionStatus;
  cleanupStatus: CleanupStatus;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

type OperationRow = {
  id: string;
  kind: OperationKind;
  idempotency_key: string;
  request_json: string;
  status: OperationStatus;
  campaign_id: string | null;
  post_id: string | null;
  assignment_id: string | null;
  device_id: string | null;
  effect_phase: EffectPhase;
  session_status: SessionStatus;
  cleanup_status: CleanupStatus;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type OperationInput = {
  kind: OperationKind;
  idempotencyKey: string;
  request: unknown;
  campaignId?: string | null;
  postId?: string | null;
  assignmentId?: string | null;
  deviceId?: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function stableJson(value: unknown) {
  const json = JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === "number" && !Number.isFinite(nested)) {
      throw new TypeError("El payload solo admite numeros finitos.");
    }
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
    }
    return nested;
  });
  if (json === undefined) throw new TypeError("El payload debe ser serializable como JSON.");
  return json;
}

function optionalId(value: string | null | undefined, name: string) {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} no puede estar vacio.`);
  return normalized;
}

function mapOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    request: JSON.parse(row.request_json),
    status: row.status,
    campaignId: row.campaign_id,
    postId: row.post_id,
    assignmentId: row.assignment_id,
    deviceId: row.device_id,
    effectPhase: row.effect_phase,
    sessionStatus: row.session_status,
    cleanupStatus: row.cleanup_status,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function getOperation(database: Database.Database, id: string) {
  const row = database.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | undefined;
  return row ? mapOperation(row) : null;
}

export function createOperation(database: Database.Database, input: OperationInput) {
  if (!OPERATION_KINDS.includes(input.kind)) throw new TypeError("El tipo de operacion no es valido.");
  const idempotencyKey = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(idempotencyKey)) throw new TypeError("La clave idempotente debe ser un UUID.");

  const requestJson = stableJson(input.request);
  const context = {
    assignmentId: optionalId(input.assignmentId, "assignmentId"),
    campaignId: optionalId(input.campaignId, "campaignId"),
    deviceId: optionalId(input.deviceId, "deviceId"),
    postId: optionalId(input.postId, "postId"),
  };
  const requestHash = createHash("sha256")
    .update(stableJson({ context, kind: input.kind, request: JSON.parse(requestJson) }))
    .digest("hex");

  return database.transaction(() => {
    const previous = database
      .prepare("SELECT *, request_hash FROM operations WHERE idempotency_key = ?")
      .get(idempotencyKey) as (OperationRow & { request_hash: string }) | undefined;
    if (previous) {
      if (previous.request_hash !== requestHash) throw new IdempotencyConflictError();
      return { operation: mapOperation(previous), replayed: true };
    }

    const id = randomUUID();
    const now = Date.now();
    database.prepare(`
      INSERT INTO operations (
        id, kind, idempotency_key, request_hash, request_json, status,
        campaign_id, post_id, assignment_id, device_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.kind,
      idempotencyKey,
      requestHash,
      requestJson,
      context.campaignId,
      context.postId,
      context.assignmentId,
      context.deviceId,
      now,
      now,
    );
    return { operation: getOperation(database, id)!, replayed: false };
  }).immediate();
}

export function startOperation(database: Database.Database, id: string) {
  const now = Date.now();
  const updated = database.prepare(`
    UPDATE operations SET status = 'running', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, id);
  const operation = getOperation(database, id);
  if (!operation) throw new Error("La operacion no existe.");
  if (updated.changes === 0 && operation.status !== "running") {
    throw new Error("La operacion ya termino.");
  }
  return operation;
}

export function completeOperation(database: Database.Database, id: string, result: unknown = null) {
  const resultJson = stableJson(result);
  return database.transaction(() => {
    const operation = getOperation(database, id);
    if (!operation) throw new Error("La operacion no existe.");
    if (operation.status === "succeeded") {
      if (stableJson(operation.result) !== resultJson) throw new IdempotencyConflictError();
      return operation;
    }
    if (!["pending", "running"].includes(operation.status)) throw new Error("La operacion ya termino.");
    if (operation.effectPhase === "effect_possible") {
      throw new Error("El posible efecto publico debe confirmarse o terminar como outcome_unknown.");
    }

    const now = Date.now();
    database.prepare(`
      UPDATE operations
      SET status = 'succeeded', result_json = ?, error = NULL, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(resultJson, now, now, id);
    return getOperation(database, id)!;
  }).immediate();
}

export function markOperationOutcomeUnknown(database: Database.Database, id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return database.transaction(() => {
    const operation = getOperation(database, id);
    if (!operation) throw new Error("La operacion no existe.");
    if (operation.status === "outcome_unknown") return operation;
    if (!["pending", "running"].includes(operation.status)) throw new Error("La operacion ya termino.");

    const now = Date.now();
    database.prepare(`
      UPDATE operations
      SET status = 'outcome_unknown', effect_phase = 'effect_possible', error = ?,
          updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(message, now, now, id);
    return getOperation(database, id)!;
  }).immediate();
}
