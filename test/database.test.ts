import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { DATABASE_VERSION, openDatabase } from "../src/lib/database.ts";
import {
  completeOperation,
  createOperation,
  IdempotencyConflictError,
  markOperationOutcomeUnknown,
} from "../src/lib/operations.ts";

async function withDirectory(run: (directory: string, filename: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "farm-appium-db-"));
  const filename = join(directory, "test.sqlite");
  try {
    run(directory, filename);
  } finally {
    try {
      const cleanup = new Database(filename);
      cleanup.pragma("journal_mode = DELETE");
      cleanup.close();
    } catch {
      // Preserve the test failure if its connection could not be closed.
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function createVersion1Database(filename: string) {
  const database = new Database(filename);
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
    CREATE INDEX jobs_pending_idx ON jobs (status, available_at, priority DESC, created_at);
    PRAGMA user_version = 1;
  `);
  database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("hardware-1", "serial-1", "Equipo 1", 1, 8200, 1, 1);
  database.prepare(`
    INSERT INTO jobs (
      id, kind, payload_json, status, priority, attempts, max_attempts,
      available_at, created_at, updated_at
    ) VALUES ('legacy-job', 'device.prepare', '{}', 'pending', 0, 0, 3, 0, 1, 1)
  `).run();
  database.close();
}

function createLegacyVersion11Database(filename: string) {
  const database = new Database(filename);
  database.exec(`
    CREATE TABLE device_profiles (
      hardware_id TEXT PRIMARY KEY, device_id TEXT UNIQUE, alias TEXT,
      physical_order INTEGER UNIQUE, system_port INTEGER UNIQUE,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE device_locks (device_id TEXT PRIMARY KEY, operation_id TEXT, acquired_at TEXT);
    CREATE TABLE operations (
      id TEXT PRIMARY KEY, kind TEXT, idempotency_key TEXT UNIQUE,
      request_fingerprint TEXT, device_id TEXT, status TEXT, result_json TEXT,
      error TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE message_drafts (
      id TEXT PRIMARY KEY, kind TEXT, platform TEXT, context TEXT, intent TEXT,
      tone TEXT, text TEXT, status TEXT, approved_at TEXT, sent_at TEXT,
      error TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE facebook_batches (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE facebook_posts (
      id TEXT PRIMARY KEY, batch_id TEXT, position INTEGER, url TEXT,
      extracted_context TEXT, context TEXT, status TEXT, error TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE facebook_assignments (
      id TEXT PRIMARY KEY, post_id TEXT, device_id TEXT, intent TEXT, tone TEXT,
      draft_id TEXT, status TEXT, error TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE facebook_rotation_slots (
      batch_id TEXT, post_id TEXT, device_id TEXT, round_index INTEGER,
      sequence_index INTEGER, scheduled_at TEXT, opened_at TEXT, open_error TEXT
    );
    PRAGMA user_version = 11;
  `);
  const createdAt = "2026-09-02T10:00:00.000Z";
  database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("a".repeat(64), "legacy-serial", "Equipo legacy", 1, 8200, createdAt, createdAt);
  database.prepare("INSERT INTO facebook_batches VALUES (?, ?, ?, ?)")
    .run("legacy-campaign", "active", createdAt, createdAt);
  database.prepare("INSERT INTO facebook_posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-post", "legacy-campaign", 0, "https://www.facebook.com/legacy/posts/1", "Contexto legacy", "Contexto editado", "context_ready", null, createdAt, createdAt);
  database.prepare("INSERT INTO message_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-draft", "facebook", "facebook", "Contexto editado", "Afinidad", "Cercano", "Comentario legacy", "sent", createdAt, createdAt, null, createdAt, createdAt);
  database.prepare("INSERT INTO facebook_assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-assignment", "legacy-post", "legacy-serial", "Afinidad", "Cercano", "legacy-draft", "sent", null, createdAt, createdAt);
  database.prepare("INSERT INTO facebook_rotation_slots VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-campaign", "legacy-post", "legacy-serial", 0, 0, createdAt, createdAt, null);
  database.close();
}

test("creates the complete schema from an empty database and persists every phase 1 entity", async () => {
  await withDirectory((_directory, filename) => {
    let database = openDatabase(filename);
    assert.equal(database.pragma("user_version", { simple: true }), DATABASE_VERSION);
    const expectedTables = [
      "appium_sessions",
      "assignment_action_results",
      "assignments",
      "browser_profile_locks",
      "campaigns",
      "checkpoints",
      "comments",
      "device_locks",
      "device_observations",
      "device_preparations",
      "device_profiles",
      "device_retirements",
      "evidence",
      "facebook_campaign_manifests",
      "facebook_device_identities",
      "jobs",
      "operations",
      "post_context_versions",
      "posts",
      "runtime_ownership",
      "schedules",
    ];
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all().map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, expectedTables);

    const now = 1;
    database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("hardware-1", "serial-1", "Equipo 1", 1, 8200, now, now);
    database.prepare("INSERT INTO campaigns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("campaign-1", "facebook", "draft", 1, 1, null, now, now, null, 1);
    database.prepare(`
      INSERT INTO posts (
        id, campaign_id, position, source_url, normalized_url, status,
        context_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("post-1", "campaign-1", 1, "https://www.facebook.com/post/1", "https://www.facebook.com/post/1", "queued", "queued", now, now);
    database.prepare(`
      INSERT INTO post_context_versions (
        id, post_id, version, context, context_hash, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("context-1", "post-1", 1, "Contexto", "a".repeat(64), "manual", now);
    database.prepare(`
      INSERT INTO assignments (id, campaign_id, post_id, device_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("assignment-1", "campaign-1", "post-1", "serial-1", "pending", now, now);
    database.prepare(`
      INSERT INTO comments (id, assignment_id, version, intention, tone, text, status, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("comment-1", "assignment-1", 1, "Afinidad", "Cercano", "Texto", "ready", "manual", now, now);
    database.prepare("INSERT INTO schedules VALUES (?, ?, ?, ?, ?, ?)")
      .run("schedule-1", "assignment-1", now, "pending", now, now);
    database.prepare("INSERT INTO facebook_device_identities VALUES (?, ?, ?, ?, ?)")
      .run("serial-1", "Cuenta controlada", "b".repeat(64), now, now);
    database.prepare("INSERT INTO device_retirements VALUES (?, ?, ?, ?)")
      .run("serial-1", "pending", now, null);
    database.prepare(`
      INSERT INTO facebook_campaign_manifests (
        campaign_id, campaign_revision, scheduled_at, posts_json, devices_json,
        assignments_json, allow_shared_accounts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("campaign-1", 1, now, "[]", "[]", "[]", 0, now);

    const operation = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: "serial-1" },
      deviceId: "serial-1",
    }).operation;
    database.prepare(`
      INSERT INTO device_preparations (
        id, device_id, operation_id, status, step, error, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("preparation-1", "serial-1", operation.id, "preparing", "perfil", null, now, now, null);
    database.prepare("INSERT INTO device_locks VALUES (?, ?, ?, ?, ?)")
      .run("serial-1", operation.id, "worker-1", now, now + 1);
    database.prepare("INSERT INTO runtime_ownership VALUES (?, ?, ?, ?, ?)")
      .run(1, "worker-1", 1, now, now + 1);
    database.prepare("INSERT INTO browser_profile_locks VALUES (?, ?, ?, ?)")
      .run("profile-1", "worker-1", now, now + 1);
    database.prepare(`
      INSERT INTO device_observations (
        device_id, connection, packages_json, observed_at
      ) VALUES (?, ?, ?, ?)
    `).run("serial-1", "connected", "[]", now);
    database.prepare(`
      INSERT INTO appium_sessions (
        id, appium_session_id, operation_id, device_id, system_port, owner,
        status, cleanup_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("session-1", "appium-1", operation.id, "serial-1", 8200, "worker-1", "active", "pending", now, now);
    assert.throws(() => database.prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("bad-checkpoint", operation.id, "assignment-1", "before_like", 1, "{}", now), /FOREIGN KEY/);
    const execution = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: randomUUID(),
      request: { assignmentId: "assignment-1" },
      campaignId: "campaign-1",
      postId: "post-1",
      assignmentId: "assignment-1",
      deviceId: "serial-1",
    }).operation;
    database.prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("checkpoint-1", execution.id, "assignment-1", "before_like", 1, "{}", now);
    database.prepare(`
      INSERT INTO assignment_action_results (
        id, assignment_id, operation_id, checkpoint_id, action, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'like', 'pending', ?, ?)
    `).run("action-1", "assignment-1", execution.id, "checkpoint-1", now, now);
    database.prepare("INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("evidence-1", execution.id, "checkpoint-1", "metadata", "artifacts/metadata.json", "{}", now);
    database.close();

    database = openDatabase(filename);
    for (const table of expectedTables.filter((name) => name !== "jobs")) {
      const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
      assert.equal(row.total, table === "operations" ? 2 : 1, table);
    }
    database.close();
  });
});

test("backs up and migrates a version 1 database without losing rows", async () => {
  await withDirectory((directory, filename) => {
    createVersion1Database(filename);
    const database = openDatabase(filename);

    assert.equal(database.pragma("user_version", { simple: true }), DATABASE_VERSION);
    assert.equal((database.prepare("SELECT alias FROM device_profiles WHERE device_id = ?").get("serial-1") as { alias: string }).alias, "Equipo 1");
    assert.equal((database.prepare("SELECT status FROM jobs WHERE id = ?").get("legacy-job") as { status: string }).status, "pending");
    database.close();

    const backups = readdirSync(directory).filter((name) => name.endsWith(".backup"));
    assert.equal(backups.length, 1);
    const backup = new Database(join(directory, backups[0]));
    assert.equal(backup.pragma("user_version", { simple: true }), 1);
    assert.equal((backup.prepare("SELECT COUNT(*) AS total FROM jobs").get() as { total: number }).total, 1);
    backup.close();
  });
});

test("backs up and migrates an existing version 2 database", async () => {
  await withDirectory((directory, filename) => {
    let database = openDatabase(filename);
    database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("hardware-1", "serial-1", "Equipo 1", 1, 8200, 1, 1);
    const operation = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: "serial-1" },
      deviceId: "serial-1",
    }).operation;
    database.prepare(`
      INSERT INTO device_preparations (
        id, device_id, operation_id, status, step, created_at, updated_at, completed_at, setup_revision
      ) VALUES ('legacy-ready', 'serial-1', ?, 'ready', 'legacy', 1, 1, 1, 1)
    `).run(operation.id);
    database.prepare(`
      INSERT INTO campaigns (
        id, platform, status, like_enabled, comment_enabled, created_at, updated_at
      ) VALUES ('legacy-campaign', 'facebook', 'draft', 1, 1, 1, 1)
    `).run();
    database.prepare(`
      INSERT INTO posts (
        id, campaign_id, position, source_url, normalized_url, status,
        context_status, context, context_source, created_at, updated_at
      ) VALUES (
        'legacy-post', 'legacy-campaign', 1, 'https://facebook.com/post/1',
        'https://www.facebook.com/post/1', 'context_ready', 'edited',
        'Contexto conservado', 'manual', 1, 1
      )
    `).run();
    database.close();

    const version2 = new Database(filename);
    version2.exec(`
      DROP TABLE facebook_campaign_manifests;
      DROP TABLE facebook_device_identities;
      DROP TABLE device_retirements;
      DROP TABLE assignment_action_results;
      DROP INDEX post_context_versions_post_idx;
      DROP TABLE post_context_versions;
      DROP TABLE browser_profile_locks;
      ALTER TABLE comments DROP COLUMN error;
      ALTER TABLE posts DROP COLUMN context_version;
      ALTER TABLE posts DROP COLUMN error;
      ALTER TABLE posts DROP COLUMN final_url;
      ALTER TABLE campaigns DROP COLUMN revision;
      DROP TABLE appium_sessions;
      DROP TABLE device_observations;
      DROP TABLE runtime_ownership;
      DROP INDEX device_preparations_device_idx;
      ALTER TABLE device_preparations DROP COLUMN setup_revision;
      PRAGMA user_version = 2;
    `);
    version2.close();

    database = openDatabase(filename);
    assert.equal(database.pragma("user_version", { simple: true }), DATABASE_VERSION);
    assert.equal((database.prepare("SELECT alias FROM device_profiles").get() as { alias: string }).alias, "Equipo 1");
    assert.ok((database.prepare("PRAGMA table_info(device_preparations)").all() as Array<{ name: string }>)
      .some((column) => column.name === "setup_revision"));
    assert.equal((database.prepare("SELECT status FROM device_preparations").get() as { status: string }).status, "not_ready");
    const migratedContext = database.prepare(`
      SELECT p.context_version, v.context, v.source
      FROM posts p JOIN post_context_versions v ON v.post_id = p.id
      WHERE p.id = 'legacy-post'
    `).get() as { context_version: number; context: string; source: string };
    assert.deepEqual(migratedContext, { context_version: 1, context: "Contexto conservado", source: "manual" });
    database.close();

    const backups = readdirSync(directory).filter((name) => name.endsWith(".backup"));
    assert.equal(backups.length, 1);
    const backup = new Database(join(directory, backups[0]));
    assert.equal(backup.pragma("user_version", { simple: true }), 2);
    backup.close();
  });
});

test("backs up and imports the persisted legacy version 11 database", async () => {
  await withDirectory((directory, filename) => {
    createLegacyVersion11Database(filename);
    const database = openDatabase(filename);
    assert.equal(database.pragma("user_version", { simple: true }), DATABASE_VERSION);
    assert.equal((database.prepare("SELECT alias FROM device_profiles").get() as { alias: string }).alias, "Equipo legacy");
    assert.deepEqual(
      database.prepare("SELECT status, comment_enabled FROM campaigns WHERE id = 'legacy-campaign'").get(),
      { status: "completed_with_issues", comment_enabled: 1 },
    );
    assert.deepEqual(
      database.prepare("SELECT status, scheduled_at, actual_at FROM assignments WHERE id = 'legacy-assignment'").get(),
      { status: "sent", scheduled_at: Date.parse("2026-09-02T10:00:00.000Z"), actual_at: Date.parse("2026-09-02T10:00:00.000Z") },
    );
    assert.deepEqual(
      database.prepare("SELECT text, status FROM comments").get(),
      { text: "Comentario legacy", status: "ready" },
    );
    assert.equal((database.prepare("SELECT position FROM posts").get() as { position: number }).position, 1);
    assert.ok(database.prepare("SELECT 1 FROM legacy_operations").get() === undefined);
    database.close();

    const backups = readdirSync(directory).filter((name) => name.endsWith(".backup"));
    assert.equal(backups.length, 1);
    const backup = new Database(join(directory, backups[0]));
    assert.equal(backup.pragma("user_version", { simple: true }), 11);
    backup.close();
  });
});

test("reserves active Appium serials and system ports uniquely", async () => {
  await withDirectory((_directory, filename) => {
    const database = openDatabase(filename);
    database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("hardware-1", "serial-1", "Equipo 1", 1, 8200, 1, 1);
    database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("hardware-2", "serial-2", "Equipo 2", 2, 8201, 1, 1);
    const first = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: "serial-1" },
      deviceId: "serial-1",
    }).operation;
    const second = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: "serial-2" },
      deviceId: "serial-2",
    }).operation;
    database.prepare(`
      INSERT INTO appium_sessions (
        id, operation_id, device_id, system_port, owner, status, cleanup_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 'pending', 1, 1)
    `).run("session-1", first.id, "serial-1", 8200, "worker-1");
    assert.throws(() => database.prepare(`
      INSERT INTO appium_sessions (
        id, operation_id, device_id, system_port, owner, status, cleanup_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'starting', 'pending', 1, 1)
    `).run("session-2", second.id, "serial-2", 8200, "worker-2"), /UNIQUE/);
    database.close();
  });
});

test("replays the persisted operation and rejects changed payloads", async () => {
  await withDirectory((_directory, filename) => {
    const database = openDatabase(filename);
    const idempotencyKey = randomUUID();
    const created = createOperation(database, {
      kind: "campaign.create",
      idempotencyKey: idempotencyKey.toUpperCase(),
      request: { actions: { comment: true, like: true }, urls: ["https://www.facebook.com/post/1"] },
    });
    const completed = completeOperation(database, created.operation.id, { campaignId: "campaign-1" });
    assert.equal(completed.status, "succeeded");

    const replayed = createOperation(database, {
      kind: "campaign.create",
      idempotencyKey,
      request: { urls: ["https://www.facebook.com/post/1"], actions: { like: true, comment: true } },
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.operation.id, created.operation.id);
    assert.deepEqual(replayed.operation.result, { campaignId: "campaign-1" });
    assert.throws(() => createOperation(database, {
      kind: "campaign.create",
      idempotencyKey,
      request: { urls: ["https://www.facebook.com/post/2"] },
    }), IdempotencyConflictError);
    assert.throws(() => createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: "missing" },
      deviceId: "missing",
    }), /FOREIGN KEY/);

    const uncertain = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: randomUUID(),
      request: { assignmentId: "assignment-1" },
    }).operation;
    assert.equal(markOperationOutcomeUnknown(database, uncertain.id, "confirmacion perdida").status, "outcome_unknown");
    assert.throws(() => completeOperation(database, uncertain.id, {}), /ya termino/);
    database.close();
  });
});
