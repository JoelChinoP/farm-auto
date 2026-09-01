import type Database from "better-sqlite3";

export const DATABASE_VERSION = 11;

export function migrateVersion7To8(database: Database.Database) {
  const activeOperation = database
    .prepare(
      "SELECT id FROM operations WHERE status IN ('starting', 'running') LIMIT 1",
    )
    .get() as { id: string } | undefined;
  if (activeOperation) {
    throw new Error(
      `Detén la operación activa ${activeOperation.id} antes de migrar la base de datos.`,
    );
  }
  const columns = database.pragma("table_info(device_preparation)") as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "setup_revision")) {
    database.exec(
      "ALTER TABLE device_preparation ADD COLUMN setup_revision INTEGER NOT NULL DEFAULT 0",
    );
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS device_profiles (
      hardware_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      alias TEXT NOT NULL CHECK (length(trim(alias)) > 0),
      physical_order INTEGER NOT NULL UNIQUE CHECK (physical_order >= 0),
      system_port INTEGER NOT NULL UNIQUE
        CHECK (system_port BETWEEN 8200 AND 8299),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    UPDATE device_preparation
    SET status = 'not_ready',
        problem = 'La preparación anterior no es válida para Appium.',
        setup_revision = 0,
        updated_at = CURRENT_TIMESTAMP;

    DROP TABLE IF EXISTS automation_registry;

    CREATE TABLE operations_appium (
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
    INSERT INTO operations_appium
      (id, kind, idempotency_key, request_fingerprint, device_id, status, result_json, error, created_at, updated_at)
    SELECT id, kind, idempotency_key, '', device_id, status, result_json, error, created_at, updated_at
    FROM operations;
    DROP TABLE operations;
    ALTER TABLE operations_appium RENAME TO operations;

    PRAGMA user_version = 8;
  `);
}

export function migrateVersion8To9(database: Database.Database) {
  database.exec(`
    UPDATE message_drafts
    SET status = 'approved',
        approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'draft';

    UPDATE facebook_assignments
    SET status = 'approved', error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE status = 'draft' AND draft_id IS NOT NULL;

    UPDATE facebook_posts
    SET status = 'approved', error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('drafts_ready', 'approving')
      AND EXISTS (
        SELECT 1 FROM facebook_assignments
        WHERE facebook_assignments.post_id = facebook_posts.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM facebook_assignments
        WHERE facebook_assignments.post_id = facebook_posts.id
          AND (facebook_assignments.draft_id IS NULL OR facebook_assignments.status <> 'approved')
      );

    PRAGMA user_version = 9;
  `);
}

export function migrateVersion9To10(database: Database.Database) {
  database.exec(`
    DELETE FROM device_locks;
    DELETE FROM facebook_rotation_slots;
    DELETE FROM facebook_assignments;
    DELETE FROM facebook_posts;
    DELETE FROM facebook_batches;
    DELETE FROM message_drafts;
    DELETE FROM operations;
    DELETE FROM device_preparation;

    PRAGMA user_version = 10;
  `);
}

export function migrateVersion10To11(database: Database.Database) {
  const columns = database.pragma("table_info(facebook_rotation_slots)") as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "scheduled_at")) {
    database.exec("ALTER TABLE facebook_rotation_slots ADD COLUMN scheduled_at TEXT");
  }
  if (!columns.some((column) => column.name === "opened_at")) {
    database.exec("ALTER TABLE facebook_rotation_slots ADD COLUMN opened_at TEXT");
  }
  if (!columns.some((column) => column.name === "open_error")) {
    database.exec("ALTER TABLE facebook_rotation_slots ADD COLUMN open_error TEXT");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS facebook_rotation_slots_scheduled
      ON facebook_rotation_slots(batch_id, round_index, scheduled_at);
    PRAGMA user_version = 11;
  `);
}
