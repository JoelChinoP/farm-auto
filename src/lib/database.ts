import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
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

export const DATABASE_VERSION = 16;

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

function migrateToVersion4(database: Database.Database) {
  database.exec(`
    ALTER TABLE campaigns
      ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

    ALTER TABLE posts ADD COLUMN final_url TEXT;
    ALTER TABLE posts ADD COLUMN error TEXT;
    ALTER TABLE posts
      ADD COLUMN context_version INTEGER NOT NULL DEFAULT 0 CHECK (context_version >= 0);
    ALTER TABLE comments ADD COLUMN error TEXT;

    CREATE TABLE post_context_versions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version >= 1),
      context TEXT NOT NULL CHECK (length(trim(context)) >= 2),
      context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
      source TEXT NOT NULL CHECK (source IN ('extracted', 'cache', 'manual')),
      final_url TEXT,
      extractor_version TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (post_id, version)
    );

    CREATE TABLE browser_profile_locks (
      profile_path TEXT PRIMARY KEY,
      owner TEXT NOT NULL CHECK (length(trim(owner)) > 0),
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at)
    );

    CREATE INDEX post_context_versions_post_idx
      ON post_context_versions (post_id, version DESC);
  `);

  const existingContexts = database.prepare(`
    SELECT id, context, context_hash, context_source, extractor_version, extracted_at, updated_at
    FROM posts WHERE length(trim(COALESCE(context, ''))) >= 2
  `).all() as Array<{
    id: string;
    context: string;
    context_hash: string | null;
    context_source: "extracted" | "cache" | "manual" | null;
    extractor_version: string | null;
    extracted_at: number | null;
    updated_at: number;
  }>;
  const insertVersion = database.prepare(`
    INSERT INTO post_context_versions (
      id, post_id, version, context, context_hash, source, extractor_version, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
  `);
  for (const post of existingContexts) {
    const contextHash = post.context_hash?.length === 64
      ? post.context_hash
      : createHash("sha256").update(post.context).digest("hex");
    insertVersion.run(
      randomUUID(),
      post.id,
      post.context,
      contextHash,
      post.context_source ?? "manual",
      post.extractor_version,
      post.extracted_at ?? post.updated_at,
    );
    database.prepare("UPDATE posts SET context_hash = ?, context_version = 1 WHERE id = ?")
      .run(contextHash, post.id);
  }
}

function migrateToVersion5(database: Database.Database) {
  database.exec(`
    CREATE TABLE assignment_action_results (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
      checkpoint_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('like', 'comment')),
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'effect_possible', 'confirmed', 'failed',
        'outcome_unknown', 'cancelled', 'reconciled_not_sent'
      )),
      result TEXT CHECK (result IS NULL OR result IN (
        'already_active', 'activated', 'sent', 'preserved', 'not_sent'
      )),
      comment_id TEXT REFERENCES comments(id) ON DELETE RESTRICT,
      comment_version INTEGER CHECK (comment_version IS NULL OR comment_version >= 1),
      text_hash TEXT CHECK (text_hash IS NULL OR length(text_hash) = 64),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (operation_id, assignment_id)
        REFERENCES operations(id, assignment_id) ON DELETE RESTRICT,
      FOREIGN KEY (checkpoint_id, operation_id)
        REFERENCES checkpoints(id, operation_id) ON DELETE RESTRICT,
      UNIQUE (operation_id, action)
    );

    CREATE INDEX assignment_action_results_assignment_idx
      ON assignment_action_results (assignment_id, action, created_at DESC);
    CREATE INDEX assignment_action_results_status_idx
      ON assignment_action_results (status, updated_at);
  `);
}

function migrateToVersion6(database: Database.Database) {
  database.exec(`
    CREATE TABLE facebook_device_identities (
      device_id TEXT PRIMARY KEY REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      account_label TEXT NOT NULL CHECK (length(trim(account_label)) > 0),
      account_fingerprint TEXT NOT NULL CHECK (length(account_fingerprint) = 64),
      verified_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX facebook_device_identities_fingerprint_idx
      ON facebook_device_identities (account_fingerprint, device_id);

    CREATE TABLE device_retirements (
      device_id TEXT PRIMARY KEY REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      requested_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE facebook_campaign_manifests (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      campaign_revision INTEGER NOT NULL CHECK (campaign_revision >= 1),
      scheduled_at INTEGER NOT NULL,
      posts_json TEXT NOT NULL CHECK (json_valid(posts_json)),
      devices_json TEXT NOT NULL CHECK (json_valid(devices_json)),
      assignments_json TEXT NOT NULL CHECK (json_valid(assignments_json)),
      allow_shared_accounts INTEGER NOT NULL DEFAULT 0 CHECK (allow_shared_accounts IN (0, 1)),
      created_at INTEGER NOT NULL
    );

    CREATE TRIGGER facebook_campaign_manifests_immutable_update
    BEFORE UPDATE ON facebook_campaign_manifests
    BEGIN
      SELECT RAISE(ABORT, 'El manifiesto de ejecucion Facebook es inmutable.');
    END;

    CREATE TRIGGER facebook_campaign_manifests_immutable_delete
    BEFORE DELETE ON facebook_campaign_manifests
    BEGIN
      SELECT RAISE(ABORT, 'El manifiesto de ejecucion Facebook es inmutable.');
    END;
  `);
}

function migrateToVersion13(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS device_recovery_requests (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      requested_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT
    );
  `);
}

function migrateToVersion14(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tiktok_live_calibrations (
      device_id TEXT PRIMARY KEY REFERENCES device_profiles(device_id) ON DELETE RESTRICT,
      x INTEGER NOT NULL CHECK (x BETWEEN 0 AND 5000),
      y INTEGER NOT NULL CHECK (y BETWEEN 0 AND 5000),
      calibrated_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function migrateToVersion15(database: Database.Database) {
  database.exec(`
    ALTER TABLE campaigns
      ADD COLUMN share_enabled INTEGER NOT NULL DEFAULT 0 CHECK (share_enabled IN (0, 1));

    DROP INDEX assignment_action_results_assignment_idx;
    DROP INDEX assignment_action_results_status_idx;
    ALTER TABLE assignment_action_results RENAME TO assignment_action_results_v14;

    CREATE TABLE assignment_action_results (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
      checkpoint_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('like', 'comment', 'share')),
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'effect_possible', 'confirmed', 'failed',
        'outcome_unknown', 'cancelled', 'reconciled_not_sent'
      )),
      result TEXT CHECK (result IS NULL OR result IN (
        'already_active', 'activated', 'sent', 'preserved', 'not_sent'
      )),
      comment_id TEXT REFERENCES comments(id) ON DELETE RESTRICT,
      comment_version INTEGER CHECK (comment_version IS NULL OR comment_version >= 1),
      text_hash TEXT CHECK (text_hash IS NULL OR length(text_hash) = 64),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (operation_id, assignment_id)
        REFERENCES operations(id, assignment_id) ON DELETE RESTRICT,
      FOREIGN KEY (checkpoint_id, operation_id)
        REFERENCES checkpoints(id, operation_id) ON DELETE RESTRICT,
      UNIQUE (operation_id, action)
    );

    INSERT INTO assignment_action_results
    SELECT * FROM assignment_action_results_v14;
    DROP TABLE assignment_action_results_v14;

    CREATE INDEX assignment_action_results_assignment_idx
      ON assignment_action_results (assignment_id, action, created_at DESC);
    CREATE INDEX assignment_action_results_status_idx
      ON assignment_action_results (status, updated_at);
  `);
}

function migrateToVersion16(database: Database.Database) {
  const columns = database.prepare("PRAGMA table_info(posts)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "content_kind")) {
    database.exec("ALTER TABLE posts ADD COLUMN content_kind TEXT CHECK (content_kind IS NULL OR content_kind IN ('post', 'reel'))");
  }
  database.exec(`
    UPDATE posts
    SET content_kind = CASE
      WHEN final_url LIKE '%/reel/%' OR final_url LIKE '%/reels/%' THEN 'reel'
      ELSE 'post'
    END
    WHERE final_url IS NOT NULL AND content_kind IS NULL;
  `);
}

function hasTable(database: Database.Database, name: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function legacyTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function migrateLegacyToVersion12(database: Database.Database) {
  database.exec(`
    ALTER TABLE device_profiles RENAME TO legacy_device_profiles;
    ALTER TABLE device_locks RENAME TO legacy_device_locks;
    ALTER TABLE operations RENAME TO legacy_operations;
  `);
  migrateToVersion1(database);
  migrateToVersion2(database);
  migrateToVersion3(database);
  migrateToVersion4(database);
  migrateToVersion5(database);
  migrateToVersion6(database);

  const insertProfile = database.prepare(`
    INSERT INTO device_profiles (
      hardware_id, device_id, alias, physical_order, system_port, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const legacyProfiles = database.prepare("SELECT * FROM legacy_device_profiles ORDER BY physical_order").all() as Array<{
    hardware_id: string;
    device_id: string;
    alias: string;
    physical_order: number;
    system_port: number;
    created_at: unknown;
    updated_at: unknown;
  }>;
  for (const profile of legacyProfiles) {
    insertProfile.run(
      profile.hardware_id,
      profile.device_id,
      profile.alias,
      profile.physical_order,
      profile.system_port,
      legacyTimestamp(profile.created_at),
      legacyTimestamp(profile.updated_at),
    );
  }

  const legacyDrafts = database.prepare("SELECT * FROM message_drafts").all() as Array<{
    id: string;
    text: string;
    status: string;
    created_at: unknown;
    updated_at: unknown;
  }>;
  const draftById = new Map(legacyDrafts.map((draft) => [draft.id, draft]));
  const legacyAssignments = database.prepare("SELECT * FROM facebook_assignments").all() as Array<{
    id: string;
    post_id: string;
    device_id: string;
    intent: string;
    tone: string;
    draft_id: string | null;
    status: string;
    error: string | null;
    created_at: unknown;
    updated_at: unknown;
  }>;
  const assignmentsByPost = Map.groupBy(legacyAssignments, (assignment) => assignment.post_id);
  const legacySlots = database.prepare("SELECT * FROM facebook_rotation_slots").all() as Array<{
    post_id: string;
    device_id: string;
    scheduled_at: unknown;
    opened_at: unknown;
  }>;
  const slotByAssignment = new Map(legacySlots.map((slot) => [`${slot.post_id}:${slot.device_id}`, slot]));
  const legacyPosts = database.prepare("SELECT * FROM facebook_posts ORDER BY batch_id, position").all() as Array<{
    id: string;
    batch_id: string;
    position: number;
    url: string;
    extracted_context: string | null;
    context: string | null;
    status: string;
    error: string | null;
    created_at: unknown;
    updated_at: unknown;
  }>;
  const postsByCampaign = Map.groupBy(legacyPosts, (post) => post.batch_id);
  const insertCampaign = database.prepare(`
    INSERT INTO campaigns (
      id, platform, status, like_enabled, comment_enabled, cancellation_reason,
      created_at, updated_at, completed_at
    ) VALUES (?, 'facebook', ?, 1, ?, ?, ?, ?, ?)
  `);
  const insertPost = database.prepare(`
    INSERT INTO posts (
      id, campaign_id, position, source_url, normalized_url, status, context_status,
      context, context_hash, context_source, context_version, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertContext = database.prepare(`
    INSERT INTO post_context_versions (
      id, post_id, version, context, context_hash, source, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?)
  `);
  const insertAssignment = database.prepare(`
    INSERT INTO assignments (
      id, campaign_id, post_id, device_id, status, scheduled_at, actual_at,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertComment = database.prepare(`
    INSERT INTO comments (
      id, assignment_id, version, intention, tone, text, status, stale, source,
      error, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, 0, 'generated', ?, ?, ?)
  `);
  const legacyCampaigns = database.prepare("SELECT * FROM facebook_batches ORDER BY created_at").all() as Array<{
    id: string;
    status: string;
    created_at: unknown;
    updated_at: unknown;
  }>;
  for (const campaign of legacyCampaigns) {
    const campaignPosts = postsByCampaign.get(campaign.id) ?? [];
    const hasComments = campaignPosts.some((post) => (assignmentsByPost.get(post.id) ?? []).some((assignment) => assignment.draft_id));
    const status = campaign.status === "completed" ? "completed" : campaign.status === "cancelled" ? "cancelled" : "completed_with_issues";
    const updatedAt = legacyTimestamp(campaign.updated_at);
    insertCampaign.run(
      campaign.id,
      status,
      Number(hasComments),
      campaign.status === "active" ? "Campana legacy importada; requiere crear un plan nuevo." : null,
      legacyTimestamp(campaign.created_at),
      updatedAt,
      updatedAt,
    );
    for (const [postIndex, post] of campaignPosts.entries()) {
      const context = post.context?.trim() || post.extracted_context?.trim() || null;
      const contextHash = context ? createHash("sha256").update(context).digest("hex") : null;
      const source = context ? post.context?.trim() ? "manual" : "extracted" : null;
      const postStatus = ["queued", "extracting", "generating", "running", "completed", "partial_failed", "outcome_unknown", "cancelled"].includes(post.status)
        ? post.status
        : context ? "ready" : "queued";
      const createdAt = legacyTimestamp(post.created_at);
      const updatedPostAt = legacyTimestamp(post.updated_at);
      insertPost.run(
        post.id,
        campaign.id,
        postIndex + 1,
        post.url,
        post.url,
        postStatus,
        context ? "ready" : "queued",
        context,
        contextHash,
        source,
        context ? 1 : 0,
        post.error,
        createdAt,
        updatedPostAt,
      );
      if (context && contextHash && source) insertContext.run(randomUUID(), post.id, context, contextHash, source, updatedPostAt);
      for (const assignment of assignmentsByPost.get(post.id) ?? []) {
        const slot = slotByAssignment.get(`${post.id}:${assignment.device_id}`);
        const assignmentStatus = ["pending", "generating", "draft", "approved", "running", "sent", "failed", "outcome_unknown", "cancelled"].includes(assignment.status)
          ? assignment.status
          : "failed";
        const assignmentUpdatedAt = legacyTimestamp(assignment.updated_at);
        insertAssignment.run(
          assignment.id,
          campaign.id,
          post.id,
          assignment.device_id,
          assignmentStatus,
          slot?.scheduled_at ? legacyTimestamp(slot.scheduled_at) : null,
          slot?.opened_at ? legacyTimestamp(slot.opened_at) : null,
          legacyTimestamp(assignment.created_at),
          assignmentUpdatedAt,
          ["sent", "failed", "outcome_unknown", "cancelled"].includes(assignmentStatus) ? assignmentUpdatedAt : null,
        );
        const draft = assignment.draft_id ? draftById.get(assignment.draft_id) : null;
        if (draft) {
          const commentStatus = draft.status === "failed" || draft.status === "outcome_unknown" ? draft.status : "ready";
          insertComment.run(
            randomUUID(),
            assignment.id,
            assignment.intent,
            assignment.tone,
            draft.text,
            commentStatus,
            assignment.error,
            legacyTimestamp(draft.created_at),
            legacyTimestamp(draft.updated_at),
          );
        }
      }
    }
  }
}

export function openDatabase(filename: string) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });

  const database = new Database(filename);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");

    const observedVersion = database.pragma("user_version", { simple: true }) as number;
    const legacyDatabase = hasTable(database, "facebook_batches") && !hasTable(database, "campaigns");
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
      if (legacyDatabase) migrateLegacyToVersion12(database);
      else {
        if (currentVersion < 1) migrateToVersion1(database);
        if (currentVersion < 2) migrateToVersion2(database);
        if (currentVersion < 3) migrateToVersion3(database);
        if (currentVersion < 4) migrateToVersion4(database);
        if (currentVersion < 5) migrateToVersion5(database);
        if (currentVersion < 6) migrateToVersion6(database);
      }
      if (currentVersion < 13) migrateToVersion13(database);
      if (currentVersion < 14) migrateToVersion14(database);
      if (currentVersion < 15) migrateToVersion15(database);
      if (currentVersion < 16) migrateToVersion16(database);
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
  if (globalDatabase.farmAppiumDatabase?.pragma("user_version", { simple: true }) !== DATABASE_VERSION) {
    globalDatabase.farmAppiumDatabase?.close();
    globalDatabase.farmAppiumDatabase = openDatabase(appConfig.databasePath);
  }
  return globalDatabase.farmAppiumDatabase;
}
