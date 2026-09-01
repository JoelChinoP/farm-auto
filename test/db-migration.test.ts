import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  migrateVersion7To8,
  migrateVersion8To9,
  migrateVersion9To10,
} from "../src/lib/db-migration.ts";

test("migrates a version 7 copy without losing history or locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "farm-auto-v7-"));
  const database = new Database(join(directory, "control-panel.sqlite"));
  database.exec(`
    CREATE TABLE automation_registry (slug TEXT, device_id TEXT);
    CREATE TABLE device_preparation (
      device_id TEXT PRIMARY KEY, status TEXT NOT NULL, problem TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE operations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, result_json TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE device_locks (device_id TEXT PRIMARY KEY, operation_id TEXT, acquired_at TEXT);
    CREATE TABLE message_drafts (id TEXT PRIMARY KEY, text TEXT);
    CREATE TABLE facebook_batches (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE facebook_posts (id TEXT PRIMARY KEY, batch_id TEXT);
    CREATE TABLE facebook_assignments (id TEXT PRIMARY KEY, post_id TEXT);
    CREATE TABLE facebook_rotation_slots (post_id TEXT, device_id TEXT);
    INSERT INTO automation_registry VALUES ('device-home', 'serial-1');
    INSERT INTO device_preparation VALUES ('serial-1', 'ready', NULL, '2026-01-01');
    INSERT INTO operations VALUES (
      'operation-1', 'device-home', 'key-1', 'serial-1', 'succeeded', 'run-1',
      '{"ok":true}', NULL, '2026-01-01', '2026-01-01'
    );
    INSERT INTO device_locks VALUES ('serial-1', 'operation-1', '2026-01-01');
    INSERT INTO message_drafts VALUES ('draft-1', 'hola');
    INSERT INTO facebook_batches VALUES ('batch-1', 'active');
    INSERT INTO facebook_posts VALUES ('post-1', 'batch-1');
    INSERT INTO facebook_assignments VALUES ('assignment-1', 'post-1');
    INSERT INTO facebook_rotation_slots VALUES ('post-1', 'serial-1');
    PRAGMA user_version = 7;
  `);

  database.transaction(() => migrateVersion7To8(database)).immediate();

  assert.equal(database.pragma("user_version", { simple: true }) as number, 8);
  assert.equal(
    database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'automation_registry'").get(),
    undefined,
  );
  const operationColumns = (
    database.pragma("table_info(operations)") as Array<{ name: string }>
  ).map((column) => column.name);
  assert.equal(operationColumns.includes("run_id"), false);
  assert.equal(operationColumns.includes("request_fingerprint"), true);
  assert.deepEqual(database.prepare("SELECT id, result_json FROM operations").get(), {
    id: "operation-1",
    result_json: '{"ok":true}',
  });
  assert.deepEqual(
    database.prepare("SELECT status, setup_revision FROM device_preparation").get(),
    { status: "not_ready", setup_revision: 0 },
  );
  database
    .prepare(
      `INSERT INTO device_profiles
       (hardware_id, device_id, alias, physical_order, system_port, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("serial:android", "serial-1", "Equipo 1", 0, 8200, "2026-01-01", "2026-01-01");
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO device_profiles
         (hardware_id, device_id, alias, physical_order, system_port, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("other", "serial-2", "Equipo 2", 1, 8200, "2026-01-01", "2026-01-01"),
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM device_locks").get() as {
      count: number;
    }).count,
    1,
  );
  for (const table of [
    "message_drafts",
    "facebook_batches",
    "facebook_posts",
    "facebook_assignments",
    "facebook_rotation_slots",
  ]) {
    assert.equal(
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
        .count,
      1,
    );
  }
  database.close();
  await rm(directory, { recursive: true, force: true });
});

test("refuses to discard the run id of an active version 7 operation", () => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE device_preparation (
      device_id TEXT PRIMARY KEY, status TEXT NOT NULL, problem TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE operations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, result_json TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO operations VALUES (
      'operation-active', 'device-home', 'key-active', 'serial-1', 'running',
      'run-active', NULL, NULL, '2026-01-01', '2026-01-01'
    );
    PRAGMA user_version = 7;
  `);

  assert.throws(
    () => database.transaction(() => migrateVersion7To8(database)).immediate(),
    /Detén la operación activa operation-active/,
  );
  assert.equal(database.pragma("user_version", { simple: true }), 7);
  assert.equal(
    (database.pragma("table_info(operations)") as Array<{ name: string }>).some(
      (column) => column.name === "run_id",
    ),
    true,
  );
  database.close();
});

test("makes version 8 generated comments ready without manual approval", () => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE message_drafts (
      id TEXT PRIMARY KEY, status TEXT, approved_at TEXT, error TEXT, updated_at TEXT
    );
    CREATE TABLE facebook_posts (
      id TEXT PRIMARY KEY, status TEXT, error TEXT, updated_at TEXT
    );
    CREATE TABLE facebook_assignments (
      id TEXT PRIMARY KEY, post_id TEXT, draft_id TEXT, status TEXT, error TEXT, updated_at TEXT
    );
    INSERT INTO message_drafts VALUES (
      'draft-1', 'draft', NULL, NULL, '2026-01-01'
    );
    INSERT INTO facebook_posts VALUES (
      'post-1', 'drafts_ready', NULL, '2026-01-01'
    );
    INSERT INTO facebook_assignments VALUES (
      'assignment-1', 'post-1', 'draft-1', 'draft', NULL, '2026-01-01'
    );
    PRAGMA user_version = 8;
  `);

  database.transaction(() => migrateVersion8To9(database)).immediate();

  assert.equal(database.pragma("user_version", { simple: true }), 9);
  assert.equal(
    (database.prepare("SELECT status FROM message_drafts").get() as { status: string }).status,
    "approved",
  );
  assert.equal(
    (database.prepare("SELECT status FROM facebook_assignments").get() as { status: string }).status,
    "approved",
  );
  assert.equal(
    (database.prepare("SELECT status FROM facebook_posts").get() as { status: string }).status,
    "approved",
  );
  database.close();
});

test("clears operational history while preserving device profiles", () => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE device_profiles (hardware_id TEXT PRIMARY KEY, device_id TEXT);
    CREATE TABLE device_preparation (device_id TEXT PRIMARY KEY);
    CREATE TABLE operations (id TEXT PRIMARY KEY);
    CREATE TABLE device_locks (device_id TEXT PRIMARY KEY);
    CREATE TABLE message_drafts (id TEXT PRIMARY KEY);
    CREATE TABLE facebook_batches (id TEXT PRIMARY KEY);
    CREATE TABLE facebook_posts (id TEXT PRIMARY KEY);
    CREATE TABLE facebook_assignments (id TEXT PRIMARY KEY);
    CREATE TABLE facebook_rotation_slots (post_id TEXT, device_id TEXT);
    INSERT INTO device_profiles VALUES ('hardware-1', 'device-1');
    INSERT INTO device_preparation VALUES ('device-1');
    INSERT INTO operations VALUES ('operation-1');
    INSERT INTO device_locks VALUES ('device-1');
    INSERT INTO message_drafts VALUES ('draft-1');
    INSERT INTO facebook_batches VALUES ('batch-1');
    INSERT INTO facebook_posts VALUES ('post-1');
    INSERT INTO facebook_assignments VALUES ('assignment-1');
    INSERT INTO facebook_rotation_slots VALUES ('post-1', 'device-1');
    PRAGMA user_version = 9;
  `);

  database.transaction(() => migrateVersion9To10(database)).immediate();

  assert.equal(database.pragma("user_version", { simple: true }), 10);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM device_profiles").get() as {
      count: number;
    }).count,
    1,
  );
  for (const table of [
    "device_preparation",
    "operations",
    "device_locks",
    "message_drafts",
    "facebook_batches",
    "facebook_posts",
    "facebook_assignments",
    "facebook_rotation_slots",
  ]) {
    assert.equal(
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }).count,
      0,
    );
  }
  database.close();
});
