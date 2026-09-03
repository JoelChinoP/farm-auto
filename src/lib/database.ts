import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { appConfig } from "./config.ts";

export const DATABASE_VERSION = 1;

export function openDatabase(filename: string) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });

  const database = new Database(filename);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  if (currentVersion > DATABASE_VERSION) {
    database.close();
    throw new Error(`La base usa la version ${currentVersion}; esta app soporta ${DATABASE_VERSION}.`);
  }

  if (currentVersion < 1) {
    database.transaction(() => {
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
      database.pragma(`user_version = ${DATABASE_VERSION}`);
    })();
  }

  return database;
}

const globalDatabase = globalThis as typeof globalThis & {
  farmAppiumDatabase?: ReturnType<typeof openDatabase>;
};

export function getDatabase() {
  globalDatabase.farmAppiumDatabase ??= openDatabase(appConfig.databasePath);
  return globalDatabase.farmAppiumDatabase;
}
