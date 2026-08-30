import "server-only";

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { appConfig } from "@/lib/config";
import { DATABASE_VERSION, migrateVersion7To8 } from "@/lib/db-migration";
import { AppError } from "@/lib/errors";

export type DeviceProfileRow = {
  hardware_id: string;
  device_id: string;
  alias: string;
  physical_order: number;
  system_port: number;
  created_at: string;
  updated_at: string;
};

export type DraftRow = {
  id: string;
  kind: "social_comment";
  platform: "tiktok" | "facebook";
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
  request_fingerprint: string;
  device_id: string;
  status: "starting" | "running" | "succeeded" | "failed" | "cancelled";
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type DevicePreparationRow = {
  device_id: string;
  status: "running" | "ready" | "not_ready";
  problem: string | null;
  setup_revision: number;
  updated_at: string;
};

export type FacebookBatchRow = {
  id: string;
  status: "active" | "completed" | "cancelled";
  device_ids_json: string;
  plan_version: "legacy" | "rotation_v1";
  current_round: number;
  execution_status: "idle" | "running";
  next_execution_at: string | null;
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

export type FacebookRotationSlotRow = {
  batch_id: string;
  post_id: string;
  device_id: string;
  round_index: number;
  sequence_index: number;
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
    CREATE TABLE IF NOT EXISTS message_drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
       platform TEXT NOT NULL,
       context TEXT NOT NULL,
       intent TEXT NOT NULL,
       tone TEXT NOT NULL,
       text TEXT NOT NULL,
       status TEXT NOT NULL,
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
      request_fingerprint TEXT NOT NULL DEFAULT '',
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS device_preparation (
      device_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      problem TEXT,
      setup_revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facebook_batches (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      device_ids_json TEXT NOT NULL DEFAULT '[]',
      plan_version TEXT NOT NULL DEFAULT 'legacy',
      current_round INTEGER NOT NULL DEFAULT 0,
      execution_status TEXT NOT NULL DEFAULT 'idle',
      next_execution_at TEXT,
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

    CREATE TABLE IF NOT EXISTS facebook_rotation_slots (
      batch_id TEXT NOT NULL REFERENCES facebook_batches(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES facebook_posts(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      round_index INTEGER NOT NULL CHECK (round_index >= 0),
      sequence_index INTEGER NOT NULL CHECK (sequence_index >= 0),
      PRIMARY KEY (post_id, device_id),
      UNIQUE (batch_id, round_index, device_id),
      UNIQUE (post_id, round_index, sequence_index)
    );

    CREATE INDEX IF NOT EXISTS facebook_posts_batch_position
      ON facebook_posts(batch_id, position);
    CREATE INDEX IF NOT EXISTS facebook_assignments_post
      ON facebook_assignments(post_id);
    CREATE INDEX IF NOT EXISTS facebook_rotation_slots_round
      ON facebook_rotation_slots(batch_id, round_index, post_id, sequence_index);
  `);
  const migrate = database.transaction(() => {
    let version = database.pragma("user_version", { simple: true }) as number;
    if (version > DATABASE_VERSION) {
      throw new Error(`La base de datos usa una versión futura (${version}).`);
    }
    if (version < 1) {
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
      `);
      const draftColumns = database.pragma("table_info(message_drafts)") as Array<{
        name: string;
      }>;
      database.exec(`
        UPDATE facebook_assignments
        SET draft_id = NULL
        WHERE draft_id IN (
          SELECT id FROM message_drafts
          WHERE kind = 'direct_message' OR platform = 'whatsapp'
        );
        DELETE FROM message_drafts
        WHERE kind = 'direct_message' OR platform = 'whatsapp';
        DELETE FROM device_locks
        WHERE operation_id IN (
          SELECT id FROM operations WHERE kind = 'whatsapp-consented'
        );
        DELETE FROM operations WHERE kind = 'whatsapp-consented';
        DELETE FROM automation_registry WHERE slug = 'whatsapp-consented';
      `);
      for (const column of ["consent_confirmed", "recipient"]) {
        if (draftColumns.some((item) => item.name === column)) {
          database.exec(`ALTER TABLE message_drafts DROP COLUMN ${column}`);
        }
      }
      database.pragma("user_version = 1");
      version = 1;
    }
    if (version < 2) {
      database.exec(`
        INSERT OR IGNORE INTO device_preparation (device_id, status, problem, updated_at)
        SELECT operation.device_id,
          CASE
            WHEN operation.status = 'succeeded' THEN 'ready'
            WHEN operation.status IN ('starting', 'running') THEN 'running'
            ELSE 'not_ready'
          END,
          CASE
            WHEN operation.status = 'succeeded' THEN NULL
            WHEN operation.status IN ('starting', 'running') THEN 'Preparación en curso.'
            ELSE COALESCE(operation.error, 'La preparación terminó con error.')
          END,
          operation.updated_at
        FROM operations AS operation
        WHERE operation.kind = 'setup'
          AND NOT EXISTS (
            SELECT 1 FROM operations AS newer
            WHERE newer.kind = 'setup'
              AND newer.device_id = operation.device_id
              AND (
                newer.created_at > operation.created_at OR
                (newer.created_at = operation.created_at AND newer.id > operation.id)
              )
          );
      `);
      database.pragma("user_version = 2");
      version = 2;
    }
    if (version < 3) {
      const batchColumns = database.pragma("table_info(facebook_batches)") as Array<{
        name: string;
      }>;
      if (!batchColumns.some((column) => column.name === "device_ids_json")) {
        database.exec(
          "ALTER TABLE facebook_batches ADD COLUMN device_ids_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      database.pragma("user_version = 3");
      version = 3;
    }
    if (version < 4) {
      const batchColumns = database.pragma("table_info(facebook_batches)") as Array<{
        name: string;
      }>;
      if (!batchColumns.some((column) => column.name === "plan_version")) {
        database.exec(
          "ALTER TABLE facebook_batches ADD COLUMN plan_version TEXT NOT NULL DEFAULT 'legacy'",
        );
      }
      if (!batchColumns.some((column) => column.name === "current_round")) {
        database.exec(
          "ALTER TABLE facebook_batches ADD COLUMN current_round INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!batchColumns.some((column) => column.name === "execution_status")) {
        database.exec(
          "ALTER TABLE facebook_batches ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'idle'",
        );
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS facebook_rotation_slots (
          batch_id TEXT NOT NULL REFERENCES facebook_batches(id) ON DELETE CASCADE,
          post_id TEXT NOT NULL REFERENCES facebook_posts(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL,
          round_index INTEGER NOT NULL CHECK (round_index >= 0),
          sequence_index INTEGER NOT NULL CHECK (sequence_index >= 0),
          PRIMARY KEY (post_id, device_id),
          UNIQUE (batch_id, round_index, device_id),
          UNIQUE (post_id, round_index, sequence_index)
        );
        CREATE INDEX IF NOT EXISTS facebook_rotation_slots_round
          ON facebook_rotation_slots(batch_id, round_index, post_id, sequence_index);
      `);
      database.pragma("user_version = 4");
      version = 4;
    }
    if (version < 5) {
      const batchColumns = database.pragma("table_info(facebook_batches)") as Array<{
        name: string;
      }>;
      if (!batchColumns.some((column) => column.name === "next_execution_at")) {
        database.exec(
          "ALTER TABLE facebook_batches ADD COLUMN next_execution_at TEXT",
        );
      }
      database.pragma("user_version = 5");
      version = 5;
    }
    if (version < 6) {
      database.exec(`
        UPDATE message_drafts
        SET status = 'outcome_unknown',
            error = 'Resultado previo a la verificación estricta del objetivo; confirma manualmente.',
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (
          SELECT assignment.draft_id
          FROM facebook_assignments AS assignment
          JOIN facebook_posts AS post ON post.id = assignment.post_id
          JOIN facebook_batches AS batch ON batch.id = post.batch_id
          WHERE assignment.status = 'sent'
            AND assignment.draft_id IS NOT NULL
            AND batch.status = 'active'
        );
        UPDATE facebook_assignments
        SET status = 'outcome_unknown',
            error = 'Resultado previo a la verificación estricta del objetivo; confirma manualmente.',
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'sent'
          AND post_id IN (
            SELECT post.id
            FROM facebook_posts AS post
            JOIN facebook_batches AS batch ON batch.id = post.batch_id
            WHERE batch.status = 'active'
          );
        UPDATE facebook_posts
        SET status = 'outcome_unknown',
            error = 'Hay resultados anteriores que deben verificarse antes de continuar.',
            updated_at = CURRENT_TIMESTAMP
        WHERE batch_id IN (
            SELECT id FROM facebook_batches
            WHERE status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM facebook_assignments AS assignment
            WHERE assignment.post_id = facebook_posts.id
              AND assignment.status = 'outcome_unknown'
          );
        UPDATE facebook_batches
        SET next_execution_at = NULL
        WHERE status = 'active' AND plan_version = 'rotation_v1';
      `);
      database.pragma("user_version = 6");
      version = 6;
    }
    if (version < 7) {
      database.exec(`
        UPDATE facebook_batches
        SET current_round = (
              SELECT MIN(slot.round_index)
              FROM facebook_rotation_slots AS slot
              JOIN facebook_assignments AS assignment
                ON assignment.post_id = slot.post_id
               AND assignment.device_id = slot.device_id
              WHERE slot.batch_id = facebook_batches.id
                AND assignment.status = 'outcome_unknown'
            ),
            next_execution_at = NULL
        WHERE status = 'active'
          AND plan_version = 'rotation_v1'
          AND EXISTS (
            SELECT 1
            FROM facebook_rotation_slots AS slot
            JOIN facebook_assignments AS assignment
              ON assignment.post_id = slot.post_id
             AND assignment.device_id = slot.device_id
            WHERE slot.batch_id = facebook_batches.id
              AND assignment.status = 'outcome_unknown'
          );
      `);
      database.pragma("user_version = 7");
      version = 7;
    }
    if (version < 8) {
      migrateVersion7To8(database);
    }
  });
  migrate.immediate();
  const operationColumns = database.pragma("table_info(operations)") as Array<{
    name: string;
  }>;
  if (!operationColumns.some((column) => column.name === "request_fingerprint")) {
    database.exec(
      "ALTER TABLE operations ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''",
    );
  }
  database
    .prepare(
      `UPDATE operations
       SET status = 'failed', error = 'La ejecución fue interrumpida al reiniciar el panel.', updated_at = ?
       WHERE status IN ('starting', 'running')`,
    )
    .run(new Date().toISOString());
  database
    .prepare(
      `UPDATE device_preparation
       SET status = 'not_ready',
           problem = 'La preparación fue interrumpida al reiniciar el panel.',
           updated_at = ?
       WHERE status = 'running'`,
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
       WHERE status IN ('generating', 'running')
          OR (
            status = 'pending' AND post_id IN (
              SELECT id FROM facebook_posts
              WHERE status = 'partial_failed'
                AND error = 'La etapa fue interrumpida al reiniciar el panel.'
            )
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
               AND facebook_assignments.status = 'approved'
           ) THEN 'approved'
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
               AND facebook_assignments.status = 'approved'
           ) THEN 'La ejecución se interrumpió antes de iniciar todas las asignaciones; puede reanudarse.'
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
  database
    .prepare(
      `UPDATE facebook_posts SET status = 'drafts_ready', error = NULL, updated_at = ?
       WHERE status = 'partial_failed'
         AND error = 'La etapa fue interrumpida al reiniciar el panel.'
         AND EXISTS (
           SELECT 1 FROM facebook_assignments
           WHERE facebook_assignments.post_id = facebook_posts.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM facebook_assignments
           WHERE facebook_assignments.post_id = facebook_posts.id
             AND (
               facebook_assignments.draft_id IS NULL OR
               facebook_assignments.status NOT IN ('draft', 'approved')
             )
         )`,
    )
    .run(recoveryTimestamp);
  database
    .prepare(
      `UPDATE facebook_batches SET execution_status = 'idle', updated_at = ?
       WHERE execution_status = 'running'`,
    )
    .run(recoveryTimestamp);
  database
    .prepare(
      `UPDATE facebook_batches SET status = 'completed', execution_status = 'idle', updated_at = ?
       WHERE status = 'active' AND plan_version = 'rotation_v1'
         AND current_round >= (
           SELECT COUNT(*) FROM facebook_posts WHERE batch_id = facebook_batches.id
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

export function listDeviceProfiles() {
  return db
    .prepare("SELECT * FROM device_profiles ORDER BY physical_order")
    .all() as DeviceProfileRow[];
}

export function getDeviceProfile(deviceId: string) {
  return db
    .prepare("SELECT * FROM device_profiles WHERE device_id = ?")
    .get(deviceId) as DeviceProfileRow | undefined;
}

export function getDeviceProfileByHardwareId(hardwareId: string) {
  return db
    .prepare("SELECT * FROM device_profiles WHERE hardware_id = ?")
    .get(hardwareId) as DeviceProfileRow | undefined;
}

export function upsertDeviceProfiles(
  profiles: Array<
    Pick<
      DeviceProfileRow,
      "hardware_id" | "device_id" | "alias" | "physical_order" | "system_port"
    >
  >,
) {
  const save = db.transaction(() => {
    const timestamp = now();
    const statement = db.prepare(`
      INSERT INTO device_profiles
        (hardware_id, device_id, alias, physical_order, system_port, created_at, updated_at)
      VALUES
        (@hardware_id, @device_id, @alias, @physical_order, @system_port, @created_at, @updated_at)
      ON CONFLICT(hardware_id) DO UPDATE SET
        device_id = excluded.device_id,
        alias = excluded.alias,
        physical_order = excluded.physical_order,
        system_port = excluded.system_port,
        updated_at = excluded.updated_at
    `);
    for (const profile of profiles) {
      const existing = db
        .prepare("SELECT * FROM device_profiles WHERE hardware_id = ?")
        .get(profile.hardware_id) as DeviceProfileRow | undefined;
      if (
        existing &&
        (existing.device_id !== profile.device_id ||
          existing.system_port !== profile.system_port) &&
        db
          .prepare("SELECT 1 FROM device_locks WHERE device_id IN (?, ?) LIMIT 1")
          .get(existing.device_id, profile.device_id)
      ) {
        throw new AppError(
          "No se puede cambiar el transporte o systemPort de un dispositivo en uso.",
          409,
          "DEVICE_BUSY",
        );
      }
      if (
        existing &&
        existing.device_id !== profile.device_id &&
        db
          .prepare(
            `SELECT 1
             FROM facebook_batches AS batch, json_each(batch.device_ids_json) AS device
             WHERE batch.status = 'active' AND device.value = ?
             LIMIT 1`,
          )
          .get(existing.device_id)
      ) {
        throw new AppError(
          "No se puede cambiar el transporte de un dispositivo asignado a una cola activa.",
          409,
          "BATCH_BUSY",
        );
      }
      statement.run({ ...profile, created_at: timestamp, updated_at: timestamp });
      if (
        existing &&
        (existing.device_id !== profile.device_id ||
          existing.system_port !== profile.system_port)
      ) {
        db.prepare(
          `UPDATE device_preparation
           SET status = 'not_ready',
               problem = 'El transporte o systemPort del perfil cambió; repite la preparación Appium.',
               setup_revision = 0,
               updated_at = ?
           WHERE device_id IN (?, ?)`,
        ).run(timestamp, existing.device_id, profile.device_id);
      }
    }
  });
  try {
    save.immediate();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "Los perfiles contienen identificadores, órdenes o puertos duplicados.",
      409,
      "DEVICE_PROFILE_CONFLICT",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return listDeviceProfiles();
}

export function listDevicePreparation() {
  return db
    .prepare("SELECT * FROM device_preparation ORDER BY device_id")
    .all() as DevicePreparationRow[];
}

export function getDevicePreparation(deviceId: string) {
  return db
    .prepare("SELECT * FROM device_preparation WHERE device_id = ?")
    .get(deviceId) as DevicePreparationRow | undefined;
}

export function setDevicePreparation(
  deviceId: string,
  status: DevicePreparationRow["status"],
  problem: string | null,
  setupRevision = 0,
) {
  const row: DevicePreparationRow = {
    device_id: deviceId,
    status,
    problem,
    setup_revision: setupRevision,
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO device_preparation (device_id, status, problem, setup_revision, updated_at)
     VALUES (@device_id, @status, @problem, @setup_revision, @updated_at)
     ON CONFLICT(device_id) DO UPDATE SET
        status = excluded.status,
        problem = excluded.problem,
        setup_revision = excluded.setup_revision,
        updated_at = excluded.updated_at`,
  ).run(row);
  return row;
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
    approved_at: null,
    sent_at: null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  } satisfies DraftRow;
  db.prepare(
    `INSERT INTO message_drafts
      (id, kind, platform, context, intent, tone, text, status,
       approved_at, sent_at, error, created_at, updated_at)
     VALUES
      (@id, @kind, @platform, @context, @intent, @tone, @text, @status,
       @approved_at, @sent_at, @error, @created_at, @updated_at)`,
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

export function approveDraft(id: string, text: string) {
  const timestamp = now();
  const result = db
    .prepare(
      `UPDATE message_drafts SET
         text = ?, status = 'approved', approved_at = ?, updated_at = ?, error = NULL
       WHERE id = ? AND status IN ('draft', 'approved')`,
    )
    .run(text, timestamp, timestamp, id);
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
  requestFingerprint: string,
  deviceId: string,
) {
  const timestamp = now();
  const operation: OperationRow = {
    id: randomUUID(),
    kind,
    idempotency_key: idempotencyKey,
    request_fingerprint: requestFingerprint,
    device_id: deviceId,
    status: "starting",
    result_json: null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO operations
       (id, kind, idempotency_key, request_fingerprint, device_id, status, result_json, error, created_at, updated_at)
       VALUES (@id, @kind, @idempotency_key, @request_fingerprint, @device_id, @status, @result_json, @error, @created_at, @updated_at)`,
    )
    .run(operation);
  if (result.changes === 1) return { operation, created: true };
  const existing = db
    .prepare("SELECT * FROM operations WHERE idempotency_key = ?")
    .get(idempotencyKey) as OperationRow;
  return { operation: existing, created: false };
}

export function getOperationByIdempotencyKey(idempotencyKey: string) {
  return db
    .prepare("SELECT * FROM operations WHERE idempotency_key = ?")
    .get(idempotencyKey) as OperationRow | undefined;
}

export function completeOperation(id: string, result: unknown) {
  const updated = db
    .prepare(
      `UPDATE operations
       SET status = 'succeeded', result_json = ?, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(JSON.stringify(result), now(), id);
  return {
    completed: updated.changes === 1,
    operation: getOperation(id)!,
  };
}

export function updateOperation(
  id: string,
  values: Partial<Pick<OperationRow, "status" | "result_json" | "error">>,
) {
  const current = db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as
    | OperationRow
    | undefined;
  if (!current) throw new AppError("Operación no encontrada.", 404, "NOT_FOUND");
  const updated = { ...current, ...values, updated_at: now() };
  db.prepare(
    `UPDATE operations SET status = @status,
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

export function createFacebookBatch(
  urls: string[],
  deviceIds: string[],
  rotationSlots: Array<{
    postPosition: number;
    deviceId: string;
    roundIndex: number;
    sequenceIndex: number;
  }>,
) {
  const timestamp = now();
  const batch: FacebookBatchRow = {
    id: randomUUID(),
    status: "active",
    device_ids_json: JSON.stringify(deviceIds),
    plan_version: "rotation_v1",
    current_round: 0,
    execution_status: "idle",
    next_execution_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const create = db.transaction(() => {
    const busy = db
      .prepare(
        `SELECT 1 FROM facebook_batches
         LEFT JOIN facebook_posts ON facebook_batches.id = facebook_posts.batch_id
         WHERE facebook_batches.status = 'active'
           AND (
             facebook_batches.execution_status = 'running' OR
             facebook_posts.status IN ('extracting', 'generating', 'approving', 'running', 'outcome_unknown') OR
             EXISTS (
               SELECT 1
               FROM facebook_posts AS delivery_post
               JOIN facebook_assignments AS delivery
                 ON delivery.post_id = delivery_post.id
               WHERE delivery_post.batch_id = facebook_batches.id
                 AND (
                   delivery.status IN ('sent', 'running', 'outcome_unknown') OR
                   (delivery.status = 'failed' AND delivery.draft_id IS NOT NULL)
                 )
             )
           )
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
      `INSERT INTO facebook_batches
       (id, status, device_ids_json, plan_version, current_round, execution_status, next_execution_at, created_at, updated_at)
       VALUES (@id, @status, @device_ids_json, @plan_version, @current_round, @execution_status, @next_execution_at, @created_at, @updated_at)`,
    ).run(batch);
    const insertPost = db.prepare(
      `INSERT INTO facebook_posts
       (id, batch_id, position, url, extracted_context, context, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 'queued', NULL, ?, ?)`,
    );
    const postIds = urls.map(() => randomUUID());
    urls.forEach((url, position) => {
      insertPost.run(postIds[position], batch.id, position, url, timestamp, timestamp);
    });
    const insertSlot = db.prepare(
      `INSERT INTO facebook_rotation_slots
       (batch_id, post_id, device_id, round_index, sequence_index)
       VALUES (?, ?, ?, ?, ?)`,
    );
    rotationSlots.forEach((slot) => {
      const postId = postIds[slot.postPosition];
      if (!postId) {
        throw new AppError("El plan de rotación contiene una publicación inválida.", 500, "INVALID_ROTATION_PLAN");
      }
      insertSlot.run(
        batch.id,
        postId,
        slot.deviceId,
        slot.roundIndex,
        slot.sequenceIndex,
      );
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
    `UPDATE facebook_batches SET status = ?,
       execution_status = CASE WHEN ? = 'active' THEN execution_status ELSE 'idle' END,
       updated_at = ? WHERE id = ?`,
  ).run(status, status, now(), id);
  return getFacebookBatch(id);
}

export function listFacebookPosts(batchId: string) {
  return db
    .prepare("SELECT * FROM facebook_posts WHERE batch_id = ? ORDER BY position")
    .all(batchId) as FacebookPostRow[];
}

export function hasFacebookBatchPublicActions(batchId: string) {
  return Boolean(
    db.prepare(
      `SELECT 1
       FROM facebook_posts
       JOIN facebook_assignments ON facebook_assignments.post_id = facebook_posts.id
       WHERE facebook_posts.batch_id = ?
         AND (
           facebook_assignments.status IN ('sent', 'running', 'outcome_unknown') OR
           (facebook_assignments.status = 'failed' AND facebook_assignments.draft_id IS NOT NULL)
         )
       LIMIT 1`,
    ).get(batchId),
  );
}

export function listFacebookRotationSlots(batchId: string, roundIndex?: number) {
  if (roundIndex === undefined) {
    return db
      .prepare(
        `SELECT * FROM facebook_rotation_slots WHERE batch_id = ?
         ORDER BY round_index, post_id, sequence_index`,
      )
      .all(batchId) as FacebookRotationSlotRow[];
  }
  return db
    .prepare(
      `SELECT * FROM facebook_rotation_slots WHERE batch_id = ? AND round_index = ?
       ORDER BY post_id, sequence_index`,
    )
    .all(batchId, roundIndex) as FacebookRotationSlotRow[];
}

export function claimFacebookBatchExecution(id: string) {
  const result = db
    .prepare(
      `UPDATE facebook_batches SET execution_status = 'running', updated_at = ?
       WHERE id = ? AND status = 'active' AND plan_version = 'rotation_v1'
         AND execution_status = 'idle'`,
    )
    .run(now(), id);
  if (result.changes !== 1) {
    throw new AppError(
      "La cola ya está ejecutándose o dejó de estar activa.",
      409,
      "BATCH_EXECUTION_BUSY",
    );
  }
  return getFacebookBatch(id)!;
}

export function releaseFacebookBatchExecution(id: string) {
  db.prepare(
    "UPDATE facebook_batches SET execution_status = 'idle', updated_at = ? WHERE id = ?",
  ).run(now(), id);
}

export function setFacebookBatchNextExecutionAt(id: string, value: string | null) {
  db.prepare(
    "UPDATE facebook_batches SET next_execution_at = ?, updated_at = ? WHERE id = ?",
  ).run(value, now(), id);
  return getFacebookBatch(id)!;
}

export function advanceFacebookBatchRound(
  id: string,
  expectedRound: number,
  finalRound: boolean,
) {
  const result = db
    .prepare(
      `UPDATE facebook_batches SET current_round = current_round + 1,
         status = CASE WHEN ? THEN 'completed' ELSE status END,
         execution_status = CASE WHEN ? THEN 'idle' ELSE execution_status END,
         next_execution_at = CASE WHEN ? THEN NULL ELSE next_execution_at END,
         updated_at = ?
       WHERE id = ? AND status = 'active' AND plan_version = 'rotation_v1'
         AND execution_status = 'running' AND current_round = ?`,
    )
    .run(
      finalRound ? 1 : 0,
      finalRound ? 1 : 0,
      finalRound ? 1 : 0,
      now(),
      id,
      expectedRound,
    );
  if (result.changes !== 1) {
    throw new AppError(
      "La ronda cambió durante la ejecución.",
      409,
      "BATCH_ROUND_CHANGED",
    );
  }
  return getFacebookBatch(id)!;
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
    .prepare(
      `SELECT facebook_assignments.*
       FROM facebook_assignments
       JOIN facebook_posts ON facebook_posts.id = facebook_assignments.post_id
       JOIN facebook_batches ON facebook_batches.id = facebook_posts.batch_id
       WHERE facebook_assignments.draft_id = ?
       ORDER BY CASE facebook_batches.status WHEN 'active' THEN 0 ELSE 1 END,
                facebook_assignments.created_at DESC
       LIMIT 1`,
    )
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
