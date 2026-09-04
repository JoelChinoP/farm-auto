import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { appConfig } from "./config.ts";
import {
  ASSIGNMENT_STATUSES,
  CAMPAIGN_STATUSES,
  CLEANUP_STATUSES,
  COMMENT_STATUSES,
  CONTEXT_STATUSES,
  EFFECT_PHASES,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  PLATFORMS,
  POST_STATUSES,
  PREPARATION_STATUSES,
  SESSION_STATUSES,
} from "./domain.ts";

export const DATABASE_VERSION = 3;

function sqlValues(values: readonly string[]) {
  return values.map((value) => `'${value}'`).join(", ");
}

function createMigrationBackup(database: Database.Database, filename: string, version: number) {
  if (filename === ":memory:") return null;
  const backupFilename = `${filename}.v${version}-${Date.now()}-${randomUUID()}.backup`;
  database.prepare("VACUUM INTO ?").run(backupFilename);
  return backupFilename;
}

function migrateToVersion1(database: Database.Database) {
  database.exec(`
    CREATE TABLE device_profiles (
      hardware_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      alias TEXT NOT NULL CHECK (length(trim(alias)) > 0),
      physical_order INTEGER NOT NULL UNIQUE CHECK (physical_order >= 0),
      system_port INTEGER NOT NULL UNIQUE CHECK (system_port BETWEEN 8200 AND 8299),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
      available_at INTEGER NOT NULL,
      lock_owner TEXT,
      locked_at INTEGER,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK (
        (status = 'running' AND lock_owner IS NOT NULL AND locked_at IS NOT NULL) OR
        (status != 'running' AND lock_owner IS NULL AND locked_at IS NULL)
      )
    );

    CREATE INDEX jobs_pending_idx
      ON jobs (status, available_at, priority DESC, created_at);
  `);
}

function migrateToVersion2(database: Database.Database) {
  database.exec(`
    CREATE TABLE campaigns (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL CHECK (platform IN (${sqlValues(PLATFORMS)})),
      status TEXT NOT NULL CHECK (status IN (${sqlValues(CAMPAIGN_STATUSES)})),
      like_enabled INTEGER NOT NULL CHECK (like_enabled IN (0, 1)),
      comment_enabled INTEGER NOT NULL CHECK (comment_enabled IN (0, 1)),
      cancellation_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (position >= 1),
      source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
      normalized_url TEXT NOT NULL CHECK (length(trim(normalized_url)) > 0),
      status TEXT NOT NULL CHECK (status IN (${sqlValues(POST_STATUSES)})),
      context_status TEXT NOT NULL CHECK (context_status IN (${sqlValues(CONTEXT_STATUSES)})),
      context TEXT,
      context_hash TEXT,
      context_source TEXT CHECK (context_source IS NULL OR context_source IN ('extracted', 'cache', 'manual')),
      extractor_version TEXT,
      extracted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (campaign_id, position),
      UNIQUE (campaign_id, normalized_url),
      UNIQUE (id, campaign_id)
    );

    CREATE TABLE assignments (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      post_id TEXT NOT NULL,
      device_id TEXT NOT NULL REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN (${sqlValues(ASSIGNMENT_STATUSES)})),
      scheduled_at INTEGER,
      actual_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (post_id, campaign_id) REFERENCES posts(id, campaign_id) ON DELETE RESTRICT,
      UNIQUE (post_id, device_id),
      UNIQUE (id, campaign_id),
      UNIQUE (id, post_id),
      UNIQUE (id, device_id)
    );

    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version >= 1),
      intention TEXT NOT NULL,
      tone TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (${sqlValues(COMMENT_STATUSES)})),
      stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
      source TEXT NOT NULL CHECK (source IN ('generated', 'manual')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (assignment_id, version)
    );

    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE RESTRICT,
      scheduled_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'cancelled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN (${sqlValues(OPERATION_KINDS)})),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      status TEXT NOT NULL CHECK (status IN (${sqlValues(OPERATION_STATUSES)})),
      campaign_id TEXT REFERENCES campaigns(id) ON DELETE RESTRICT,
      post_id TEXT REFERENCES posts(id) ON DELETE RESTRICT,
      assignment_id TEXT REFERENCES assignments(id) ON DELETE RESTRICT,
      device_id TEXT REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      effect_phase TEXT NOT NULL DEFAULT 'none' CHECK (effect_phase IN (${sqlValues(EFFECT_PHASES)})),
      session_status TEXT NOT NULL DEFAULT 'not_started' CHECK (session_status IN (${sqlValues(SESSION_STATUSES)})),
      cleanup_status TEXT NOT NULL DEFAULT 'not_required' CHECK (cleanup_status IN (${sqlValues(CLEANUP_STATUSES)})),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK (status != 'succeeded' OR effect_phase != 'effect_possible'),
      FOREIGN KEY (post_id, campaign_id) REFERENCES posts(id, campaign_id) ON DELETE RESTRICT,
      FOREIGN KEY (assignment_id, campaign_id) REFERENCES assignments(id, campaign_id) ON DELETE RESTRICT,
      FOREIGN KEY (assignment_id, post_id) REFERENCES assignments(id, post_id) ON DELETE RESTRICT,
      FOREIGN KEY (assignment_id, device_id) REFERENCES assignments(id, device_id) ON DELETE RESTRICT,
      UNIQUE (id, campaign_id),
      UNIQUE (id, post_id),
      UNIQUE (id, assignment_id),
      UNIQUE (id, device_id)
    );

    CREATE TABLE device_preparations (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN (${sqlValues(PREPARATION_STATUSES)})),
      step TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE device_locks (
      device_id TEXT PRIMARY KEY REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
      owner TEXT NOT NULL CHECK (length(trim(owner)) > 0),
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at)
    );

    CREATE TABLE checkpoints (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
      assignment_id TEXT REFERENCES assignments(id) ON DELETE RESTRICT,
      phase TEXT NOT NULL CHECK (length(trim(phase)) > 0),
      sequence INTEGER NOT NULL DEFAULT 1 CHECK (sequence >= 1),
      data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (operation_id, assignment_id) REFERENCES operations(id, assignment_id) ON DELETE RESTRICT,
      UNIQUE (operation_id, phase, sequence),
      UNIQUE (id, operation_id)
    );

    CREATE TABLE evidence (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
      checkpoint_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('metadata', 'screenshot', 'page_source')),
      path TEXT NOT NULL CHECK (length(trim(path)) > 0),
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (checkpoint_id, operation_id) REFERENCES checkpoints(id, operation_id) ON DELETE RESTRICT,
      UNIQUE (operation_id, path)
    );

    ALTER TABLE jobs RENAME TO jobs_v1;
    DROP INDEX IF EXISTS jobs_pending_idx;

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
      available_at INTEGER NOT NULL,
      lock_owner TEXT,
      locked_at INTEGER,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error TEXT,
      campaign_id TEXT REFERENCES campaigns(id) ON DELETE RESTRICT,
      post_id TEXT REFERENCES posts(id) ON DELETE RESTRICT,
      assignment_id TEXT REFERENCES assignments(id) ON DELETE RESTRICT,
      operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
      cancellation_requested_at INTEGER,
      effect_phase TEXT NOT NULL DEFAULT 'none' CHECK (effect_phase IN (${sqlValues(EFFECT_PHASES)})),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK (
        (status = 'running' AND lock_owner IS NOT NULL AND locked_at IS NOT NULL) OR
        (status != 'running' AND lock_owner IS NULL AND locked_at IS NULL)
      ),
      CHECK (status != 'pending' OR effect_phase IN ('none', 'before_effect')),
      CHECK (status != 'outcome_unknown' OR effect_phase = 'effect_possible'),
      CHECK (status != 'succeeded' OR effect_phase != 'effect_possible'),
      FOREIGN KEY (post_id, campaign_id) REFERENCES posts(id, campaign_id) ON DELETE RESTRICT,
      FOREIGN KEY (assignment_id, campaign_id) REFERENCES assignments(id, campaign_id) ON DELETE RESTRICT,
      FOREIGN KEY (assignment_id, post_id) REFERENCES assignments(id, post_id) ON DELETE RESTRICT,
      FOREIGN KEY (operation_id, campaign_id) REFERENCES operations(id, campaign_id) ON DELETE RESTRICT,
      FOREIGN KEY (operation_id, post_id) REFERENCES operations(id, post_id) ON DELETE RESTRICT,
      FOREIGN KEY (operation_id, assignment_id) REFERENCES operations(id, assignment_id) ON DELETE RESTRICT
    );

    INSERT INTO jobs (
      id, kind, payload_json, status, priority, attempts, max_attempts,
      available_at, lock_owner, locked_at, result_json, error, created_at,
      updated_at, completed_at
    )
    SELECT id, kind, payload_json, status, priority, attempts, max_attempts,
      available_at, lock_owner, locked_at, result_json, error, created_at,
      updated_at, completed_at
    FROM jobs_v1;

    DROP TABLE jobs_v1;

    CREATE INDEX jobs_pending_idx
      ON jobs (status, cancellation_requested_at, available_at, priority DESC, created_at);
    CREATE UNIQUE INDEX jobs_operation_idx ON jobs (operation_id);
    CREATE INDEX operations_status_idx ON operations (status, created_at);
    CREATE INDEX assignments_campaign_idx ON assignments (campaign_id, status);
    CREATE INDEX checkpoints_operation_idx ON checkpoints (operation_id, created_at);
    CREATE INDEX evidence_operation_idx ON evidence (operation_id, created_at);
  `);
}

function migrateToVersion3(database: Database.Database) {
  database.exec(`
    ALTER TABLE device_preparations
      ADD COLUMN setup_revision INTEGER NOT NULL DEFAULT 1 CHECK (setup_revision >= 1);

    UPDATE device_preparations
    SET status = 'not_ready', step = 'Requiere preparacion de Fase 2',
        error = NULL, completed_at = NULL;

    CREATE TABLE runtime_ownership (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner TEXT NOT NULL CHECK (length(trim(owner)) > 0),
      pid INTEGER NOT NULL CHECK (pid > 0),
      heartbeat_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > heartbeat_at)
    );

    CREATE TABLE device_observations (
      device_id TEXT PRIMARY KEY REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      connection TEXT NOT NULL CHECK (connection IN ('connected', 'offline', 'unauthorized')),
      model TEXT,
      ro_serialno TEXT,
      android_id TEXT,
      hardware_id TEXT,
      packages_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(packages_json)),
      foreground_package TEXT,
      foreground_activity TEXT,
      launcher_package TEXT,
      observed_at INTEGER NOT NULL,
      error TEXT
    );

    CREATE TABLE appium_sessions (
      id TEXT PRIMARY KEY,
      appium_session_id TEXT UNIQUE,
      operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
      device_id TEXT NOT NULL REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      system_port INTEGER NOT NULL CHECK (system_port BETWEEN 8200 AND 8299),
      owner TEXT NOT NULL CHECK (length(trim(owner)) > 0),
      status TEXT NOT NULL CHECK (status IN (${sqlValues(SESSION_STATUSES)})),
      cleanup_status TEXT NOT NULL CHECK (cleanup_status IN (${sqlValues(CLEANUP_STATUSES)})),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );

    CREATE UNIQUE INDEX appium_sessions_active_device_idx
      ON appium_sessions (device_id)
      WHERE status IN ('starting', 'active', 'closing', 'outcome_unknown');
    CREATE UNIQUE INDEX appium_sessions_active_port_idx
      ON appium_sessions (system_port)
      WHERE status IN ('starting', 'active', 'closing', 'outcome_unknown');
    CREATE INDEX device_preparations_device_idx
      ON device_preparations (device_id, updated_at DESC);
  `);
}

export function openDatabase(filename: string) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });

  const database = new Database(filename);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");

    const observedVersion = database.pragma("user_version", { simple: true }) as number;
    if (observedVersion > DATABASE_VERSION) {
      throw new Error(`La base usa la version ${observedVersion}; esta app soporta ${DATABASE_VERSION}.`);
    }
    if (observedVersion === DATABASE_VERSION) return database;

    if (observedVersion > 0) createMigrationBackup(database, filename, observedVersion);
    database.transaction(() => {
      const currentVersion = database.pragma("user_version", { simple: true }) as number;
      if (currentVersion > DATABASE_VERSION) {
        throw new Error(`La base usa la version ${currentVersion}; esta app soporta ${DATABASE_VERSION}.`);
      }
      if (currentVersion < 1) migrateToVersion1(database);
      if (currentVersion < 2) migrateToVersion2(database);
      if (currentVersion < 3) migrateToVersion3(database);
      if (currentVersion < DATABASE_VERSION) database.pragma(`user_version = ${DATABASE_VERSION}`);
    }).immediate();

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

const globalDatabase = globalThis as typeof globalThis & {
  farmAppiumDatabase?: ReturnType<typeof openDatabase>;
};

export function getDatabase() {
  globalDatabase.farmAppiumDatabase ??= openDatabase(appConfig.databasePath);
  return globalDatabase.farmAppiumDatabase;
}
