import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AdbClient, HardwareIdentityMismatchError, SAFE_ADB_URL } from "./adb.ts";
import type { AdbDeviceInspection } from "./adb.ts";
import { AppiumClient, AppiumClientError } from "./appium-client.ts";
import { appConfig } from "./config.ts";
import { stableJson } from "./operations.ts";

export type DeviceProfile = {
  hardwareId: string;
  deviceId: string;
  alias: string;
  physicalOrder: number;
  systemPort: number;
  createdAt: number;
  updatedAt: number;
};

type SessionRow = {
  id: string;
  appium_session_id: string | null;
  operation_id: string;
  device_id: string;
  system_port: number;
  owner: string;
  status: "not_started" | "starting" | "active" | "closing" | "closed" | "failed" | "outcome_unknown";
  cleanup_status: "not_required" | "pending" | "session_closed" | "home_confirmed" | "failed" | "outcome_unknown";
  error: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
};

type PrepareDependencies = {
  adb: AdbClient;
  appium: AppiumClient;
  artifactsPath?: string;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
  leaseSignal?: AbortSignal;
};

export class CleanupUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CleanupUnknownError";
  }
}

const CURRENT_SETUP_REVISION = 1;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sessionCreationDefinitelyFailed(error: unknown) {
  return error instanceof AppiumClientError
    && (error.code === "APPIUM_UNREACHABLE"
      || (error.status !== undefined && error.status >= 400 && error.status < 500));
}

function sessionIdFromCreationError(error: unknown) {
  if (!(error instanceof AppiumClientError) || typeof error.details !== "object" || error.details === null) return null;
  const sessionId = (error.details as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId ? sessionId : null;
}

function mapProfile(row: {
  hardware_id: string;
  device_id: string;
  alias: string;
  physical_order: number;
  system_port: number;
  created_at: number;
  updated_at: number;
}): DeviceProfile {
  return {
    hardwareId: row.hardware_id,
    deviceId: row.device_id,
    alias: row.alias,
    physicalOrder: row.physical_order,
    systemPort: row.system_port,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getDeviceProfile(database: Database.Database, deviceId: string) {
  const row = database.prepare("SELECT * FROM device_profiles WHERE device_id = ?").get(deviceId) as Parameters<typeof mapProfile>[0] | undefined;
  return row ? mapProfile(row) : null;
}

export function upsertDeviceProfile(
  database: Database.Database,
  input: { hardwareId: string; deviceId: string; alias: string; physicalOrder: number; systemPort: number },
) {
  const hardwareId = input.hardwareId.trim().toLowerCase();
  const deviceId = input.deviceId.trim();
  const alias = input.alias.trim();
  if (!/^[0-9a-f]{64}$/.test(hardwareId)) throw new TypeError("hardwareId debe ser un SHA-256 hexadecimal.");
  if (!deviceId || /[\u0000-\u001f\u007f]/.test(deviceId)) throw new TypeError("deviceId no es valido.");
  if (!alias) throw new TypeError("alias es obligatorio.");
  if (!Number.isInteger(input.physicalOrder) || input.physicalOrder < 0) throw new TypeError("physicalOrder no es valido.");
  if (!Number.isInteger(input.systemPort) || input.systemPort < 8200 || input.systemPort > 8299) {
    throw new TypeError("systemPort debe estar entre 8200 y 8299.");
  }

  return database.transaction(() => {
    let existing = getDeviceProfile(database, deviceId);
    const hardwareRow = database.prepare("SELECT * FROM device_profiles WHERE hardware_id = ?")
      .get(hardwareId) as Parameters<typeof mapProfile>[0] | undefined;
    if (!existing && hardwareRow) existing = mapProfile(hardwareRow);
    const identityChanged = Boolean(existing && existing.hardwareId !== hardwareId);
    const transportChanged = Boolean(existing && existing.deviceId !== deviceId);
    const portChanged = Boolean(existing && existing.systemPort !== input.systemPort);
    if (existing && (identityChanged || transportChanged || portChanged)) {
      const inUse = database.prepare(`
        SELECT EXISTS(SELECT 1 FROM device_locks WHERE device_id = ?) AS locked,
          EXISTS(SELECT 1 FROM appium_sessions WHERE device_id = ?) AS hasSessions,
          EXISTS(
            SELECT 1 FROM appium_sessions
            WHERE device_id = ? AND status IN ('starting', 'active', 'closing', 'outcome_unknown')
          ) AS hasActiveSession,
          EXISTS(SELECT 1 FROM device_observations WHERE device_id = ?) AS observed,
          EXISTS(
            SELECT 1 FROM jobs j JOIN operations o ON o.id = j.operation_id
            WHERE o.device_id = ? AND j.status IN ('pending', 'running')
          ) AS hasQueuedWork
      `).get(existing.deviceId, existing.deviceId, existing.deviceId, existing.deviceId, existing.deviceId) as {
        locked: 0 | 1;
        hasSessions: 0 | 1;
        hasActiveSession: 0 | 1;
        observed: 0 | 1;
        hasQueuedWork: 0 | 1;
      };
      if (inUse.locked
        || (identityChanged && (inUse.hasSessions || inUse.observed))
        || ((transportChanged || portChanged) && inUse.hasActiveSession)
        || (transportChanged && inUse.hasQueuedWork)) {
        throw new Error("No se puede cambiar identidad, transporte o puerto mientras el perfil esta en uso.");
      }
    }
    if (existing && identityChanged) {
      database.prepare("UPDATE device_profiles SET hardware_id = ? WHERE device_id = ?")
        .run(hardwareId, existing.deviceId);
      existing.hardwareId = hardwareId;
    }
    if (existing && transportChanged) {
      database.pragma("defer_foreign_keys = ON");
      database.prepare("UPDATE assignments SET device_id = ? WHERE device_id = ?").run(deviceId, existing.deviceId);
      database.prepare("UPDATE operations SET device_id = ? WHERE device_id = ?").run(deviceId, existing.deviceId);
      database.prepare("UPDATE device_preparations SET device_id = ? WHERE device_id = ?").run(deviceId, existing.deviceId);
      database.prepare("UPDATE device_locks SET device_id = ? WHERE device_id = ?").run(deviceId, existing.deviceId);
      database.prepare("DELETE FROM device_observations WHERE device_id = ?").run(existing.deviceId);
      database.prepare("UPDATE appium_sessions SET device_id = ? WHERE device_id = ?").run(deviceId, existing.deviceId);
      database.prepare("UPDATE device_profiles SET device_id = ? WHERE device_id = ?").run(deviceId, existing.deviceId);
      existing.deviceId = deviceId;
    }
    if (existing
      && !identityChanged
      && !transportChanged
      && existing.alias === alias
      && existing.physicalOrder === input.physicalOrder
      && existing.systemPort === input.systemPort) {
      return existing;
    }
    const now = Date.now();
    database.prepare(`
      INSERT INTO device_profiles (
        hardware_id, device_id, alias, physical_order, system_port, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        alias = excluded.alias,
        physical_order = excluded.physical_order,
        system_port = excluded.system_port,
        updated_at = excluded.updated_at
    `).run(hardwareId, deviceId, alias, input.physicalOrder, input.systemPort, now, now);
    if (identityChanged || transportChanged || portChanged) {
      database.prepare(`
        UPDATE device_preparations
        SET status = 'not_ready', step = 'Perfil modificado', error = NULL,
            updated_at = ?, completed_at = NULL
        WHERE device_id = ? AND status = 'ready'
      `).run(now, deviceId);
    }
    return getDeviceProfile(database, deviceId)!;
  }).immediate();
}

export function listDeviceSnapshots(database: Database.Database) {
  return database.prepare(`
    SELECT
      p.hardware_id AS hardwareId,
      p.device_id AS deviceId,
      p.alias,
      p.physical_order AS physicalOrder,
      p.system_port AS systemPort,
      o.connection,
      o.model,
      o.foreground_package AS foregroundPackage,
      o.foreground_activity AS foregroundActivity,
      o.observed_at AS observedAt,
      o.error AS observationError,
      pr.status AS preparationStatus,
      pr.step AS preparationStep,
      pr.error AS preparationError,
      pr.updated_at AS preparationUpdatedAt,
      CASE WHEN l.device_id IS NULL THEN 'available' ELSE 'busy' END AS farmAvailability
    FROM device_profiles p
    LEFT JOIN device_observations o ON o.device_id = p.device_id
    LEFT JOIN device_locks l ON l.device_id = p.device_id
    LEFT JOIN device_preparations pr ON pr.id = (
      SELECT id FROM device_preparations
      WHERE device_id = p.device_id AND setup_revision = ${CURRENT_SETUP_REVISION}
      ORDER BY updated_at DESC LIMIT 1
    )
    ORDER BY p.physical_order, p.device_id
  `).all();
}

export function claimRuntimeOwnership(
  database: Database.Database,
  owner: string,
  pid: number,
  now: number,
  leaseMs: number,
) {
  if (!owner.trim() || !Number.isInteger(pid) || pid <= 0 || !Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError("El lease del worker no es valido.");
  }
  const result = database.prepare(`
    INSERT INTO runtime_ownership (singleton, owner, pid, heartbeat_at, expires_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      owner = excluded.owner,
      pid = excluded.pid,
      heartbeat_at = excluded.heartbeat_at,
      expires_at = excluded.expires_at
    WHERE runtime_ownership.owner = excluded.owner OR runtime_ownership.expires_at <= excluded.heartbeat_at
  `).run(owner, pid, now, now + leaseMs);
  return result.changes === 1;
}

export function releaseRuntimeOwnership(database: Database.Database, owner: string) {
  return database.prepare("DELETE FROM runtime_ownership WHERE singleton = 1 AND owner = ?").run(owner).changes === 1;
}

export function assertRuntimeOwnership(database: Database.Database, owner: string, now = Date.now()) {
  const row = database.prepare(`
    SELECT owner FROM runtime_ownership
    WHERE singleton = 1 AND owner = ? AND expires_at > ?
  `).get(owner, now);
  if (!row) throw new Error("El worker perdio su lease antes de una operacion de dispositivo.");
}

function withRuntimeOwnership<T>(database: Database.Database, owner: string, run: () => T) {
  return database.transaction(() => {
    assertRuntimeOwnership(database, owner);
    return run();
  }).immediate();
}

export function acquireDeviceLock(
  database: Database.Database,
  deviceId: string,
  operationId: string,
  owner: string,
  now: number,
  leaseMs: number,
) {
  const result = database.prepare(`
    INSERT INTO device_locks (device_id, operation_id, owner, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET expires_at = excluded.expires_at
    WHERE device_locks.operation_id = excluded.operation_id AND device_locks.owner = excluded.owner
  `).run(deviceId, operationId, owner, now, now + leaseMs);
  return result.changes === 1;
}

export function releaseDeviceLock(
  database: Database.Database,
  deviceId: string,
  operationId: string,
  owner: string,
) {
  return database.prepare(`
    DELETE FROM device_locks WHERE device_id = ? AND operation_id = ? AND owner = ?
  `).run(deviceId, operationId, owner).changes === 1;
}

function persistInspection(database: Database.Database, inspection: AdbDeviceInspection, now: number) {
  database.prepare(`
    INSERT INTO device_observations (
      device_id, connection, model, ro_serialno, android_id, hardware_id,
      packages_json, foreground_package, foreground_activity, launcher_package,
      observed_at, error
    ) VALUES (?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(device_id) DO UPDATE SET
      connection = excluded.connection,
      model = excluded.model,
      ro_serialno = excluded.ro_serialno,
      android_id = excluded.android_id,
      hardware_id = excluded.hardware_id,
      packages_json = excluded.packages_json,
      foreground_package = excluded.foreground_package,
      foreground_activity = excluded.foreground_activity,
      launcher_package = excluded.launcher_package,
      observed_at = excluded.observed_at,
      error = NULL
  `).run(
    inspection.deviceId,
    inspection.model,
    inspection.roSerialNo,
    inspection.androidId,
    inspection.hardwareId,
    stableJson(inspection.packages),
    inspection.foreground?.packageName ?? null,
    inspection.foreground?.activityName ?? null,
    inspection.launcher.packageName,
    now,
  );
}

export async function refreshDeviceInventory(
  database: Database.Database,
  adb: AdbClient,
  signal?: AbortSignal,
  owner?: string,
) {
  const inventory = await adb.listDevices({ signal });
  const bySerial = new Map(inventory.map((device) => [device.serial, device]));
  const profiles = database.prepare("SELECT device_id FROM device_profiles").all() as Array<{ device_id: string }>;
  const upsert = database.prepare(`
    INSERT INTO device_observations (
      device_id, connection, model, packages_json, observed_at, error
    ) VALUES (?, ?, ?, '[]', ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      connection = excluded.connection,
      model = excluded.model,
      ro_serialno = NULL,
      android_id = NULL,
      hardware_id = NULL,
      packages_json = '[]',
      foreground_package = NULL,
      foreground_activity = NULL,
      launcher_package = NULL,
      observed_at = excluded.observed_at,
      error = excluded.error
  `);
  const now = Date.now();
  const persist = () => {
    for (const profile of profiles) {
      const device = bySerial.get(profile.device_id);
      const connection = device?.state === "device" ? "connected" : device?.state ?? "offline";
      upsert.run(
        profile.device_id,
        connection,
        device?.model ?? null,
        now,
        connection === "connected" ? null : `ADB: ${connection}`,
      );
    }
  };
  if (owner) withRuntimeOwnership(database, owner, persist);
  else database.transaction(persist)();

  for (const profile of profiles) {
    if (bySerial.get(profile.device_id)?.state !== "device") continue;
    try {
      const inspection = await adb.inspectDevice(profile.device_id, { signal });
      const save = () => persistInspection(database, inspection, Date.now());
      if (owner) withRuntimeOwnership(database, owner, save);
      else database.transaction(save)();
    } catch (error) {
      const save = () => {
        database.prepare(`
          UPDATE device_observations
          SET hardware_id = ?, observed_at = ?, error = ?
          WHERE device_id = ?
        `).run(
          error instanceof HardwareIdentityMismatchError ? error.actualHardwareId : null,
          Date.now(),
          messageOf(error),
          profile.device_id,
        );
        if (error instanceof HardwareIdentityMismatchError) {
          database.prepare(`
            UPDATE device_preparations
            SET status = 'not_ready', step = 'Identidad fisica no coincide',
                error = ?, updated_at = ?, completed_at = NULL
            WHERE device_id = ? AND setup_revision = ? AND status = 'ready'
          `).run(error.message, Date.now(), profile.device_id, CURRENT_SETUP_REVISION);
        }
      };
      if (owner) withRuntimeOwnership(database, owner, save);
      else database.transaction(save)();
    }
  }
  return inventory;
}

function setPreparation(
  database: Database.Database,
  deviceId: string,
  operationId: string,
  status: "not_ready" | "preparing" | "ready" | "failed" | "recovery_required",
  step: string,
  error: string | null,
  now: number,
) {
  database.prepare(`
    INSERT INTO device_preparations (
      id, device_id, operation_id, status, step, error, created_at, updated_at, completed_at, setup_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${CURRENT_SETUP_REVISION})
    ON CONFLICT(operation_id) DO UPDATE SET
      status = excluded.status,
      step = excluded.step,
      error = excluded.error,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at
  `).run(
    randomUUID(),
    deviceId,
    operationId,
    status,
    step,
    error,
    now,
    now,
    ["ready", "failed", "recovery_required"].includes(status) ? now : null,
  );
}

function updateOperationRuntime(
  database: Database.Database,
  operationId: string,
  sessionStatus: SessionRow["status"],
  cleanupStatus: SessionRow["cleanup_status"],
  now: number,
) {
  database.prepare(`
    UPDATE operations SET session_status = ?, cleanup_status = ?, updated_at = ? WHERE id = ?
  `).run(sessionStatus, cleanupStatus, now, operationId);
}

function reserveSession(
  database: Database.Database,
  operationId: string,
  deviceId: string,
  systemPort: number,
  owner: string,
  now: number,
) {
  const previous = database.prepare("SELECT * FROM appium_sessions WHERE operation_id = ?").get(operationId) as SessionRow | undefined;
  if (previous) return previous;
  const id = randomUUID();
  database.prepare(`
    INSERT INTO appium_sessions (
      id, operation_id, device_id, system_port, owner, status, cleanup_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'starting', 'pending', ?, ?)
  `).run(id, operationId, deviceId, systemPort, owner, now, now);
  return database.prepare("SELECT * FROM appium_sessions WHERE id = ?").get(id) as SessionRow;
}

function updateSession(
  database: Database.Database,
  id: string,
  values: {
    appiumSessionId?: string | null;
    status: SessionRow["status"];
    cleanupStatus: SessionRow["cleanup_status"];
    error?: string | null;
    closed?: boolean;
  },
  now: number,
) {
  database.prepare(`
    UPDATE appium_sessions
    SET appium_session_id = COALESCE(?, appium_session_id), status = ?, cleanup_status = ?,
        error = ?, updated_at = ?, closed_at = ?
    WHERE id = ?
  `).run(
    values.appiumSessionId ?? null,
    values.status,
    values.cleanupStatus,
    values.error ?? null,
    now,
    values.closed ? now : null,
    id,
  );
}

export function getOwnedAppiumSessionIds(database: Database.Database) {
  return (database.prepare(`
    SELECT appium_session_id FROM appium_sessions
    WHERE appium_session_id IS NOT NULL AND status IN ('active', 'closing', 'outcome_unknown')
  `).all() as Array<{ appium_session_id: string }>).map((row) => row.appium_session_id);
}

async function saveFailureEvidence(
  database: Database.Database,
  operationId: string,
  deviceId: string,
  appium: AppiumClient,
  sessionId: string | null,
  artifactsPath: string,
  error: unknown,
  signal: AbortSignal,
) {
  const directory = join(artifactsPath, operationId, randomUUID());
  await mkdir(directory, { recursive: true });
  const failures: Record<string, string> = {};
  const evidence: Array<{ kind: "metadata" | "screenshot" | "page_source"; path: string }> = [];

  if (sessionId) {
    try {
      const screenshotPath = join(directory, "screenshot.png");
      await writeFile(screenshotPath, await appium.getScreenshot(sessionId, { signal }));
      evidence.push({ kind: "screenshot", path: screenshotPath });
    } catch (captureError) {
      failures.screenshot = messageOf(captureError);
    }
    try {
      const sourcePath = join(directory, "page-source.xml");
      await writeFile(sourcePath, await appium.getPageSource(sessionId, { signal }), "utf8");
      evidence.push({ kind: "page_source", path: sourcePath });
    } catch (captureError) {
      failures.pageSource = messageOf(captureError);
    }
  }

  const metadata = {
    operationId,
    deviceId,
    sessionId,
    error: messageOf(error),
    captureErrors: failures,
    createdAt: new Date().toISOString(),
  };
  const metadataPath = join(directory, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
  evidence.push({ kind: "metadata", path: metadataPath });

  const now = Date.now();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO evidence (
      id, operation_id, checkpoint_id, kind, path, metadata_json, created_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?)
  `);
  database.transaction(() => {
    for (const item of evidence) insert.run(randomUUID(), operationId, item.kind, item.path, stableJson(metadata), now);
  })();
}

async function trySaveFailureEvidence(...args: Parameters<typeof saveFailureEvidence>) {
  try {
    await saveFailureEvidence(...args);
    return null;
  } catch (error) {
    return `Evidencia: ${messageOf(error)}`;
  }
}

async function cleanupSession(
  adb: AdbClient,
  appium: AppiumClient,
  deviceId: string,
  sessionId: string,
  timeoutMs: number,
  sessionAlreadyClosed = false,
  parentSignal?: AbortSignal,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  const errors: string[] = [];
  let sessionClosed = sessionAlreadyClosed;
  if (!sessionAlreadyClosed) {
    try {
      await appium.deleteSession(sessionId, { signal });
      sessionClosed = true;
    } catch (error) {
      if (error instanceof AppiumClientError && error.code === "invalid session id") {
        sessionClosed = true;
      } else {
        errors.push(`Appium: ${messageOf(error)}`);
      }
    }
  }
  try {
    await adb.inspectDevice(deviceId, { signal, timeoutMs });
    await adb.goHome(deviceId, { signal, timeoutMs });
  } catch (error) {
    errors.push(`Identidad/Home: ${messageOf(error)}`);
  }
  return { sessionClosed, errors };
}

export async function prepareDevice(
  database: Database.Database,
  operationId: string,
  owner: string,
  dependencies: PrepareDependencies,
) {
  const operation = database.prepare(`
    SELECT device_id AS deviceId FROM operations
    WHERE id = ? AND kind = 'device.prepare' AND status = 'running'
  `).get(operationId) as { deviceId: string | null } | undefined;
  if (!operation?.deviceId) throw new Error("La operacion de preparacion no tiene un dispositivo valido.");
  const profile = getDeviceProfile(database, operation.deviceId);
  if (!profile) throw new Error("El dispositivo no esta permitido.");
  const locked = withRuntimeOwnership(database, owner, () => {
    const acquired = acquireDeviceLock(database, profile.deviceId, operationId, owner, Date.now(), appConfig.workerLeaseMs);
    if (acquired) {
      setPreparation(database, profile.deviceId, operationId, "preparing", "Leyendo estado ADB", null, Date.now());
    }
    return acquired;
  });
  if (!locked) {
    throw new Error("El dispositivo ya esta ocupado por Farm Appium.");
  }

  let session: SessionRow | null = null;
  let appiumSessionId: string | null = null;
  try {
    const inspection = await dependencies.adb.inspectDevice(profile.deviceId, { signal: dependencies.signal });
    session = withRuntimeOwnership(database, owner, () => {
      persistInspection(database, inspection, Date.now());
      setPreparation(database, profile.deviceId, operationId, "preparing", "Creando sesion Appium", null, Date.now());
      const reserved = reserveSession(database, operationId, profile.deviceId, profile.systemPort, owner, Date.now());
      updateOperationRuntime(database, operationId, "starting", "pending", Date.now());
      return reserved;
    });
    let created;
    try {
      created = await dependencies.appium.createSession({
        udid: profile.deviceId,
        systemPort: profile.systemPort,
        timeoutMs: appConfig.appiumTimeoutMs,
        signal: dependencies.signal,
      });
    } catch (error) {
      assertRuntimeOwnership(database, owner);
      const returnedSessionId = sessionIdFromCreationError(error);
      if (returnedSessionId) {
        appiumSessionId = returnedSessionId;
        withRuntimeOwnership(database, owner, () => {
          updateSession(database, session!.id, {
            appiumSessionId,
            status: "active",
            cleanupStatus: "pending",
            error: messageOf(error),
          }, Date.now());
          updateOperationRuntime(database, operationId, "active", "pending", Date.now());
        });
        throw error;
      }
      if (sessionCreationDefinitelyFailed(error)) {
        withRuntimeOwnership(database, owner, () => {
          updateSession(database, session!.id, {
            status: "failed",
            cleanupStatus: "not_required",
            error: messageOf(error),
            closed: true,
          }, Date.now());
          updateOperationRuntime(database, operationId, "failed", "not_required", Date.now());
          setPreparation(database, profile.deviceId, operationId, "failed", "Appium rechazo la sesion", messageOf(error), Date.now());
          releaseDeviceLock(database, profile.deviceId, operationId, owner);
        });
        throw error;
      }
      const evidenceTimeout = AbortSignal.timeout(dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs);
      const evidenceSignal = dependencies.leaseSignal
        ? AbortSignal.any([dependencies.leaseSignal, evidenceTimeout])
        : evidenceTimeout;
      const evidenceError = await trySaveFailureEvidence(
        database,
        operationId,
        profile.deviceId,
        dependencies.appium,
        null,
        dependencies.artifactsPath ?? appConfig.artifactsPath,
        error,
        evidenceSignal,
      );
      assertRuntimeOwnership(database, owner);
      const failure = [messageOf(error), evidenceError].filter(Boolean).join("; ");
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session!.id, {
          status: "outcome_unknown",
          cleanupStatus: "outcome_unknown",
          error: failure,
        }, Date.now());
        updateOperationRuntime(database, operationId, "outcome_unknown", "outcome_unknown", Date.now());
        setPreparation(database, profile.deviceId, operationId, "recovery_required", "Sesion Appium incierta", failure, Date.now());
      });
      throw new CleanupUnknownError("No se pudo determinar si Appium creo la sesion.", { cause: error });
    }

    appiumSessionId = created.sessionId;
    withRuntimeOwnership(database, owner, () => {
      updateSession(database, session!.id, {
        appiumSessionId,
        status: "active",
        cleanupStatus: "pending",
      }, Date.now());
      updateOperationRuntime(database, operationId, "active", "pending", Date.now());
      setPreparation(database, profile.deviceId, operationId, "preparing", "Validando jerarquia Android", null, Date.now());
    });
    await dependencies.appium.getPageSource(appiumSessionId, { signal: dependencies.signal });
    await dependencies.adb.goHome(profile.deviceId, { signal: dependencies.signal });
    assertRuntimeOwnership(database, owner);
    const safeUrlHandler = await dependencies.adb.resolveSafeUrlHandler(profile.deviceId, { signal: dependencies.signal });
    await dependencies.adb.openSafeUrl(profile.deviceId, SAFE_ADB_URL, { signal: dependencies.signal });
    const foreground = await dependencies.adb.getForeground(profile.deviceId, { signal: dependencies.signal });
    if (!foreground || foreground.packageName !== safeUrlHandler.packageName) {
      throw new Error("ADB no pudo confirmar el handler de la URL segura en foreground.");
    }

    assertRuntimeOwnership(database, owner);
    const cleanup = await cleanupSession(
      dependencies.adb,
      dependencies.appium,
      profile.deviceId,
      appiumSessionId,
      dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs,
      false,
      dependencies.leaseSignal,
    );
    assertRuntimeOwnership(database, owner);
    if (cleanup.errors.length) {
      const evidenceTimeout = AbortSignal.timeout(dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs);
      const evidenceSignal = dependencies.leaseSignal
        ? AbortSignal.any([dependencies.leaseSignal, evidenceTimeout])
        : evidenceTimeout;
      const evidenceError = await trySaveFailureEvidence(
        database,
        operationId,
        profile.deviceId,
        dependencies.appium,
        cleanup.sessionClosed ? null : appiumSessionId,
        dependencies.artifactsPath ?? appConfig.artifactsPath,
        cleanup.errors.join("; "),
        evidenceSignal,
      );
      if (evidenceError) cleanup.errors.push(evidenceError);
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session!.id, {
          status: cleanup.sessionClosed ? "closed" : "outcome_unknown",
          cleanupStatus: "outcome_unknown",
          error: cleanup.errors.join("; "),
          closed: cleanup.sessionClosed,
        }, Date.now());
        updateOperationRuntime(database, operationId, cleanup.sessionClosed ? "closed" : "outcome_unknown", "outcome_unknown", Date.now());
        setPreparation(database, profile.deviceId, operationId, "recovery_required", "Cleanup incierto", cleanup.errors.join("; "), Date.now());
      });
      throw new CleanupUnknownError("El cleanup del dispositivo quedo incierto.");
    }

    withRuntimeOwnership(database, owner, () => {
      updateSession(database, session!.id, {
        status: "closed",
        cleanupStatus: "home_confirmed",
        closed: true,
      }, Date.now());
      updateOperationRuntime(database, operationId, "closed", "home_confirmed", Date.now());
      setPreparation(database, profile.deviceId, operationId, "ready", "Preparacion completada", null, Date.now());
      releaseDeviceLock(database, profile.deviceId, operationId, owner);
    });
    return {
      deviceId: profile.deviceId,
      model: inspection.model,
      foregroundPackage: foreground.packageName,
      homePackage: inspection.launcher.packageName,
    };
  } catch (error) {
    try {
      assertRuntimeOwnership(database, owner);
    } catch {
      throw new CleanupUnknownError("El worker perdio el lease; el nuevo owner debe ejecutar recovery.", { cause: error });
    }
    if (!session) {
      withRuntimeOwnership(database, owner, () => {
        setPreparation(database, profile.deviceId, operationId, "failed", "Preparacion fallida", messageOf(error), Date.now());
        releaseDeviceLock(database, profile.deviceId, operationId, owner);
      });
      throw error;
    }
    if (!appiumSessionId || error instanceof CleanupUnknownError) throw error;

    const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs;
    const evidenceTimeout = AbortSignal.timeout(cleanupTimeoutMs);
    const evidenceSignal = dependencies.leaseSignal
      ? AbortSignal.any([dependencies.leaseSignal, evidenceTimeout])
      : evidenceTimeout;
    const evidenceError = await trySaveFailureEvidence(
      database,
      operationId,
      profile.deviceId,
      dependencies.appium,
      appiumSessionId,
      dependencies.artifactsPath ?? appConfig.artifactsPath,
      error,
      evidenceSignal,
    );
    const cleanup = await cleanupSession(
      dependencies.adb,
      dependencies.appium,
      profile.deviceId,
      appiumSessionId,
      cleanupTimeoutMs,
      false,
      dependencies.leaseSignal,
    );
    assertRuntimeOwnership(database, owner);
    if (cleanup.errors.length) {
      if (evidenceError) cleanup.errors.push(evidenceError);
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session!.id, {
          status: cleanup.sessionClosed ? "closed" : "outcome_unknown",
          cleanupStatus: "outcome_unknown",
          error: cleanup.errors.join("; "),
          closed: cleanup.sessionClosed,
        }, Date.now());
        updateOperationRuntime(database, operationId, cleanup.sessionClosed ? "closed" : "outcome_unknown", "outcome_unknown", Date.now());
        setPreparation(database, profile.deviceId, operationId, "recovery_required", "Cleanup incierto", cleanup.errors.join("; "), Date.now());
      });
      throw new CleanupUnknownError("El cleanup del dispositivo quedo incierto.", { cause: error });
    }

    withRuntimeOwnership(database, owner, () => {
      updateSession(database, session!.id, {
        status: "failed",
        cleanupStatus: "home_confirmed",
        error: [messageOf(error), evidenceError].filter(Boolean).join("; "),
        closed: true,
      }, Date.now());
      updateOperationRuntime(database, operationId, "closed", "home_confirmed", Date.now());
      setPreparation(
        database,
        profile.deviceId,
        operationId,
        "failed",
        "Preparacion fallida",
        [messageOf(error), evidenceError].filter(Boolean).join("; "),
        Date.now(),
      );
      releaseDeviceLock(database, profile.deviceId, operationId, owner);
    });
    throw error;
  }
}

export async function recoverOwnedSessions(
  database: Database.Database,
  owner: string,
  adb: AdbClient,
  appium: AppiumClient,
  cleanupTimeoutMs = appConfig.cleanupTimeoutMs,
  artifactsPath = appConfig.artifactsPath,
  signal?: AbortSignal,
) {
  assertRuntimeOwnership(database, owner);
  const sessions = database.prepare(`
    SELECT * FROM appium_sessions
    WHERE status IN ('starting', 'active', 'closing', 'outcome_unknown')
       OR cleanup_status = 'outcome_unknown'
    ORDER BY created_at
  `).all() as SessionRow[];

  for (const session of sessions) {
    if (!session.appium_session_id) {
      const now = Date.now();
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session.id, {
          status: "outcome_unknown",
          cleanupStatus: "outcome_unknown",
          error: session.error ?? "Sesion interrumpida antes de persistir el ID de Appium",
        }, now);
        updateOperationRuntime(database, session.operation_id, "outcome_unknown", "outcome_unknown", now);
        setPreparation(database, session.device_id, session.operation_id, "recovery_required", "Sesion Appium incierta", session.error, now);
      });
      continue;
    }
    const alreadyClosed = session.status === "closed";
    const cleanup = await cleanupSession(
      adb,
      appium,
      session.device_id,
      session.appium_session_id,
      cleanupTimeoutMs,
      alreadyClosed,
      signal,
    );
    if (cleanup.errors.length) {
      const evidenceTimeout = AbortSignal.timeout(cleanupTimeoutMs);
      const evidenceSignal = signal ? AbortSignal.any([signal, evidenceTimeout]) : evidenceTimeout;
      const evidenceError = await trySaveFailureEvidence(
        database,
        session.operation_id,
        session.device_id,
        appium,
        cleanup.sessionClosed ? null : session.appium_session_id,
        artifactsPath,
        cleanup.errors.join("; "),
        evidenceSignal,
      );
      if (evidenceError) cleanup.errors.push(evidenceError);
      const now = Date.now();
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session.id, {
          status: cleanup.sessionClosed ? "closed" : "outcome_unknown",
          cleanupStatus: "outcome_unknown",
          error: cleanup.errors.join("; "),
          closed: cleanup.sessionClosed,
        }, now);
        updateOperationRuntime(database, session.operation_id, cleanup.sessionClosed ? "closed" : "outcome_unknown", "outcome_unknown", now);
        setPreparation(database, session.device_id, session.operation_id, "recovery_required", "Cleanup incierto", cleanup.errors.join("; "), now);
      });
      continue;
    }
    const now = Date.now();
    withRuntimeOwnership(database, owner, () => {
      updateSession(database, session.id, { status: "closed", cleanupStatus: "home_confirmed", closed: true }, now);
      updateOperationRuntime(database, session.operation_id, "closed", "home_confirmed", now);
      setPreparation(database, session.device_id, session.operation_id, "failed", "Sesion recuperada tras reinicio", null, now);
      releaseDeviceLock(database, session.device_id, session.operation_id, session.owner);
    });
  }

  const orphanLocks = database.prepare(`
    SELECT l.device_id, l.operation_id, l.owner
    FROM device_locks l
    LEFT JOIN appium_sessions s ON s.operation_id = l.operation_id
      AND (s.status IN ('starting', 'active', 'closing', 'outcome_unknown') OR s.cleanup_status = 'outcome_unknown')
    WHERE s.id IS NULL
  `).all() as Array<{ device_id: string; operation_id: string; owner: string }>;
  for (const lock of orphanLocks) {
    try {
      const timeoutSignal = AbortSignal.timeout(cleanupTimeoutMs);
      const cleanupSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      await adb.inspectDevice(lock.device_id, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs });
      await adb.goHome(lock.device_id, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs });
      const now = Date.now();
      withRuntimeOwnership(database, owner, () => {
        updateOperationRuntime(database, lock.operation_id, "closed", "home_confirmed", now);
        setPreparation(database, lock.device_id, lock.operation_id, "failed", "Lock recuperado tras reinicio", null, now);
        releaseDeviceLock(database, lock.device_id, lock.operation_id, lock.owner);
      });
    } catch (error) {
      const now = Date.now();
      withRuntimeOwnership(database, owner, () => {
        updateOperationRuntime(database, lock.operation_id, "failed", "outcome_unknown", now);
        setPreparation(database, lock.device_id, lock.operation_id, "recovery_required", "Home incierto durante recovery", messageOf(error), now);
      });
    }
  }
}
