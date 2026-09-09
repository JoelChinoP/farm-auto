import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AdbClient, HardwareIdentityMismatchError } from "./adb.ts";
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
  operation_kind?: string;
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

class EvidencePersistenceError extends Error {}

export const CURRENT_SETUP_REVISION = 1;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sessionCreationDefinitelyFailed(error: unknown) {
  return error instanceof AppiumClientError
    && (error.code === "APPIUM_UNREACHABLE"
      || error.code === "session not created"
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
      database.prepare("UPDATE facebook_device_identities SET device_id = ? WHERE device_id = ?").run(deviceId, existing.deviceId);
      database.prepare("UPDATE device_retirements SET device_id = ? WHERE device_id = ?").run(deviceId, existing.deviceId);
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

export async function registerConnectedDevices(
  database: Database.Database,
  adb: AdbClient,
  serials: string[],
  signal?: AbortSignal,
) {
  const deviceIds = serials.map((serial) => serial.trim());
  if (!deviceIds.length || deviceIds.length > 100 || deviceIds.some((serial) => !serial || /[\u0000-\u001f\u007f]/.test(serial))) {
    throw new TypeError("La lista debe incluir entre 1 y 100 seriales ADB validos.");
  }
  if (new Set(deviceIds).size !== deviceIds.length) throw new TypeError("Los seriales ADB no pueden repetirse.");
  const inspections = [] as AdbDeviceInspection[];
  for (const deviceId of deviceIds) {
    try {
      inspections.push(await adb.inspectUnregisteredDevice(deviceId, { signal }));
    } catch (error) {
      throw new Error(`Fallo la inspeccion de ${deviceId}: ${messageOf(error)}`);
    }
  }

  return database.transaction(() => {
    const profiles = database.prepare("SELECT * FROM device_profiles").all() as Array<Parameters<typeof mapProfile>[0]>;
    const retirementStatuses = new Map((database.prepare("SELECT device_id, status FROM device_retirements").all() as Array<{
      device_id: string;
      status: "pending" | "completed";
    }>).map((retirement) => [retirement.device_id, retirement.status]));
    const usedPorts = new Set(profiles.map((profile) => profile.system_port));
    let nextOrder = Math.max(0, ...profiles.map((profile) => profile.physical_order));
    let nextAlias = Math.max(
      0,
      ...profiles
        .filter((profile) => retirementStatuses.get(profile.device_id) !== "completed")
        .map((profile) => profile.physical_order),
    );
    return inspections.map((inspection) => {
      const existingRow = profiles.find((profile) => profile.device_id === inspection.deviceId || profile.hardware_id === inspection.hardwareId);
      const existing = existingRow ? mapProfile(existingRow) : null;
      const retirementStatus = existing ? retirementStatuses.get(existing.deviceId) : null;
      if (retirementStatus === "pending") {
        throw new Error(`El dispositivo ${inspection.deviceId} tiene un retiro pendiente.`);
      }
      const restored = retirementStatus === "completed";
      if (restored) database.prepare("DELETE FROM device_retirements WHERE device_id = ?").run(existing!.deviceId);
      let systemPort = existing?.systemPort;
      if (systemPort === undefined) {
        systemPort = Array.from({ length: 100 }, (_, index) => 8200 + index).find((port) => !usedPorts.has(port));
        if (systemPort === undefined) throw new Error("No quedan systemPort disponibles entre 8200 y 8299.");
        usedPorts.add(systemPort);
      }
      const profile = upsertDeviceProfile(database, {
        hardwareId: inspection.hardwareId,
        deviceId: inspection.deviceId,
        alias: existing && !restored ? existing.alias : `Equipo ${++nextAlias}`,
        physicalOrder: existing?.physicalOrder ?? ++nextOrder,
        systemPort,
      });
      persistInspection(database, inspection, Date.now());
      return profile;
    });
  }).immediate();
}

export function clearDeviceList(database: Database.Database, now = Date.now()) {
  return database.transaction(() => {
    const active = database.prepare(`
      SELECT o.kind, j.status, 'trabajo' AS source
      FROM jobs j JOIN operations o ON o.id = j.operation_id
      WHERE o.device_id IS NOT NULL AND j.status IN ('pending', 'running')
      UNION ALL
      SELECT o.kind, s.status, 'sesion' AS source
      FROM appium_sessions s JOIN operations o ON o.id = s.operation_id
      WHERE s.status IN ('starting', 'active', 'closing', 'outcome_unknown')
      UNION ALL
      SELECT o.kind, 'locked', 'bloqueo' AS source
      FROM device_locks l JOIN operations o ON o.id = l.operation_id
      LIMIT 1
    `).get() as { kind: string; status: string; source: "trabajo" | "sesion" | "bloqueo" } | undefined;
    if (active) {
      if (active.status === "outcome_unknown") {
        throw new Error("Hay una sesion Appium con resultado incierto. Recupérala o reconcíliala desde Historial antes de borrar los equipos.");
      }
      throw new Error(`No se puede borrar la lista: hay ${active.source} ${active.status} de ${active.kind}.`);
    }

    const deviceIds = (database.prepare("SELECT device_id FROM device_profiles").all() as Array<{ device_id: string }>)
      .map((profile) => profile.device_id);
    const retire = database.prepare(`
      INSERT INTO device_retirements (device_id, status, requested_at, completed_at)
      VALUES (?, 'completed', ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        status = 'completed', requested_at = excluded.requested_at, completed_at = excluded.completed_at
    `);
    for (const deviceId of deviceIds) retire.run(deviceId, now, now);
    return deviceIds.length;
  }).immediate();
}

export function listDeviceSnapshots(database: Database.Database) {
  const rows = database.prepare(`
    SELECT
      p.hardware_id AS hardwareId,
      p.device_id AS deviceId,
      p.alias,
      p.physical_order AS physicalOrder,
      p.system_port AS systemPort,
      o.connection,
      o.model,
      o.hardware_id AS observedHardwareId,
      o.packages_json AS packagesJson,
      o.foreground_package AS foregroundPackage,
      o.foreground_activity AS foregroundActivity,
      o.observed_at AS observedAt,
      o.error AS observationError,
      pr.status AS preparationStatus,
      pr.step AS preparationStep,
      pr.error AS preparationError,
      pr.updated_at AS preparationUpdatedAt,
      r.status AS retirementStatus,
      fi.account_label AS facebookAccount,
      fi.account_fingerprint AS facebookAccountFingerprint,
      CASE WHEN l.device_id IS NULL THEN 'available' ELSE 'busy' END AS farmAvailability
    FROM device_profiles p
    LEFT JOIN device_observations o ON o.device_id = p.device_id
    LEFT JOIN device_locks l ON l.device_id = p.device_id
    LEFT JOIN device_retirements r ON r.device_id = p.device_id
    LEFT JOIN facebook_device_identities fi ON fi.device_id = p.device_id
    LEFT JOIN device_preparations pr ON pr.id = (
      SELECT id FROM device_preparations
      WHERE device_id = p.device_id AND setup_revision = ${CURRENT_SETUP_REVISION}
      ORDER BY updated_at DESC LIMIT 1
    )
    WHERE r.status IS NULL OR r.status = 'pending'
    ORDER BY p.physical_order, p.device_id
  `).all() as Array<Record<string, unknown> & { packagesJson: string | null }>;
  return rows.map(({ packagesJson, ...row }) => ({
    ...row,
    packages: packagesJson ? JSON.parse(packagesJson) as unknown[] : [],
  }));
}

export function requestDeviceRetirement(database: Database.Database, deviceId: string, now = Date.now()) {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) throw new TypeError("deviceId es obligatorio.");
  return database.transaction(() => {
    if (!getDeviceProfile(database, normalizedDeviceId)) throw new Error("El dispositivo no existe.");
    database.prepare(`
      INSERT INTO device_retirements (device_id, status, requested_at, completed_at)
      VALUES (?, 'pending', ?, NULL)
      ON CONFLICT(device_id) DO UPDATE SET
        status = device_retirements.status
    `).run(normalizedDeviceId, now);
    completeDeviceRetirementIfIdle(database, normalizedDeviceId, now);
    return database.prepare("SELECT * FROM device_retirements WHERE device_id = ?").get(normalizedDeviceId) as {
      device_id: string;
      status: "pending" | "completed";
      requested_at: number;
      completed_at: number | null;
    };
  }).immediate();
}

export function completeDeviceRetirementIfIdle(
  database: Database.Database,
  deviceId: string,
  now = Date.now(),
) {
  return database.prepare(`
    UPDATE device_retirements SET status = 'completed', completed_at = ?
    WHERE device_id = ? AND status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM jobs j JOIN operations o ON o.id = j.operation_id
        WHERE o.device_id = device_retirements.device_id AND j.status IN ('pending', 'running')
      )
      AND NOT EXISTS (SELECT 1 FROM device_locks WHERE device_id = device_retirements.device_id)
      AND NOT EXISTS (
        SELECT 1 FROM appium_sessions
        WHERE device_id = device_retirements.device_id
          AND status IN ('starting', 'active', 'closing', 'outcome_unknown')
      )
  `).run(now, deviceId).changes === 1;
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

export function requestUncertainSessionRecovery(database: Database.Database, now = Date.now()) {
  database.prepare(`
    INSERT INTO device_recovery_requests (singleton, status, requested_at, started_at, completed_at, error)
    VALUES (1, 'pending', ?, NULL, NULL, NULL)
    ON CONFLICT(singleton) DO UPDATE SET
      status = 'pending', requested_at = excluded.requested_at, started_at = NULL,
      completed_at = NULL, error = NULL
  `).run(now);
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
  const released = database.prepare(`
    DELETE FROM device_locks WHERE device_id = ? AND operation_id = ? AND owner = ?
  `).run(deviceId, operationId, owner).changes === 1;
  completeDeviceRetirementIfIdle(database, deviceId);
  return released;
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

function persistVerifiedIdentity(
  database: Database.Database,
  identity: { deviceId: string; roSerialNo: string; androidId: string; hardwareId: string },
  now: number,
) {
  database.prepare(`
    INSERT INTO device_observations (
      device_id, connection, ro_serialno, android_id, hardware_id, packages_json, observed_at, error
    ) VALUES (?, 'connected', ?, ?, ?, '[]', ?, NULL)
    ON CONFLICT(device_id) DO UPDATE SET
      connection = 'connected', ro_serialno = excluded.ro_serialno, android_id = excluded.android_id,
      hardware_id = excluded.hardware_id, observed_at = excluded.observed_at, error = NULL
  `).run(identity.deviceId, identity.roSerialNo, identity.androidId, identity.hardwareId, now);
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
      ro_serialno = CASE WHEN excluded.connection = 'connected' THEN ro_serialno ELSE NULL END,
      android_id = CASE WHEN excluded.connection = 'connected' THEN android_id ELSE NULL END,
      hardware_id = CASE WHEN excluded.connection = 'connected' THEN hardware_id ELSE NULL END,
      packages_json = CASE WHEN excluded.connection = 'connected' THEN packages_json ELSE '[]' END,
      foreground_package = CASE WHEN excluded.connection = 'connected' THEN foreground_package ELSE NULL END,
      foreground_activity = CASE WHEN excluded.connection = 'connected' THEN foreground_activity ELSE NULL END,
      launcher_package = CASE WHEN excluded.connection = 'connected' THEN launcher_package ELSE NULL END,
      observed_at = CASE WHEN excluded.connection = 'connected' THEN observed_at ELSE excluded.observed_at END,
      error = CASE WHEN excluded.connection = 'connected' THEN error ELSE excluded.error END
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

export function queueDevicePreparation(database: Database.Database, deviceId: string, operationId: string) {
  setPreparation(database, deviceId, operationId, "preparing", "En cola para comprobar Appium", null, Date.now());
}

export function cancelQueuedDevicePreparation(database: Database.Database, operationId: string, now = Date.now()) {
  database.prepare(`
    UPDATE device_preparations
    SET status = 'failed', step = 'Cancelada antes de comenzar',
        error = 'Cancelacion solicitada antes de que el worker iniciara la preparacion.',
        updated_at = ?, completed_at = ?
    WHERE operation_id = ? AND status = 'preparing'
  `).run(now, now, operationId);
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

type CapturedSessionEvidence = {
  screenshot?: Buffer;
  pageSource?: string;
  failures: Record<string, string>;
};

async function captureSessionEvidence(appium: AppiumClient, sessionId: string, signal: AbortSignal): Promise<CapturedSessionEvidence> {
  const captured: CapturedSessionEvidence = { failures: {} };
  try {
    captured.screenshot = await appium.getScreenshot(sessionId, { signal });
  } catch (error) {
    captured.failures.screenshot = messageOf(error);
  }
  try {
    captured.pageSource = await appium.getPageSource(sessionId, { signal });
  } catch (error) {
    captured.failures.pageSource = messageOf(error);
  }
  return captured;
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
  checkpointId: string | null = null,
  metadataDetails: Record<string, unknown> = {},
  captured?: CapturedSessionEvidence,
) {
  const directory = join(artifactsPath, operationId, randomUUID());
  await mkdir(directory, { recursive: true });
  const failures: Record<string, string> = {};
  const evidence: Array<{ kind: "metadata" | "screenshot" | "page_source"; path: string }> = [];

  if (captured) {
    Object.assign(failures, captured.failures);
    if (captured.screenshot) {
      const screenshotPath = join(directory, "screenshot.png");
      await writeFile(screenshotPath, captured.screenshot);
      evidence.push({ kind: "screenshot", path: screenshotPath });
    }
    if (captured.pageSource) {
      const sourcePath = join(directory, "page-source.xml");
      await writeFile(sourcePath, captured.pageSource, "utf8");
      evidence.push({ kind: "page_source", path: sourcePath });
    }
  } else if (sessionId) {
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
    checkpointId,
    ...metadataDetails,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  database.transaction(() => {
    for (const item of evidence) insert.run(randomUUID(), operationId, checkpointId, item.kind, item.path, stableJson(metadata), now);
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
  cleanupPackage?: string,
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
    if (cleanupPackage) await adb.forceStopApp(deviceId, cleanupPackage, { signal, timeoutMs });
    await adb.inspectDevice(deviceId, { signal, timeoutMs });
    await adb.goHome(deviceId, { signal, timeoutMs });
  } catch (error) {
    errors.push(`Identidad/Home: ${messageOf(error)}`);
  }
  return { sessionClosed, errors };
}

async function closePreparationSession(
  appium: AppiumClient,
  sessionId: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  try {
    await appium.deleteSession(sessionId, { signal });
    return { sessionClosed: true, errors: [] as string[] };
  } catch (error) {
    if (error instanceof AppiumClientError && error.code === "invalid session id") {
      return { sessionClosed: true, errors: [] as string[] };
    }
    return { sessionClosed: false, errors: [`Appium: ${messageOf(error)}`] };
  }
}

export async function prepareDevice(
  database: Database.Database,
  operationId: string,
  owner: string,
  dependencies: PrepareDependencies,
) {
  const operation = database.prepare(`
    SELECT device_id AS deviceId, request_json AS requestJson FROM operations
    WHERE id = ? AND kind = 'device.prepare' AND status = 'running'
  `).get(operationId) as { deviceId: string | null; requestJson: string } | undefined;
  if (!operation?.deviceId) throw new Error("La operacion de preparacion no tiene un dispositivo valido.");
  const profile = getDeviceProfile(database, operation.deviceId);
  if (!profile) throw new Error("El dispositivo no esta permitido.");
  const launchPackage = (() => {
    const value = JSON.parse(operation.requestJson) as { launchPackage?: unknown };
    return typeof value.launchPackage === "string" ? value.launchPackage : null;
  })();
  const locked = withRuntimeOwnership(database, owner, () => {
    const acquired = acquireDeviceLock(database, profile.deviceId, operationId, owner, Date.now(), appConfig.workerLeaseMs);
    if (acquired) {
      setPreparation(database, profile.deviceId, operationId, "preparing", "Comprobando conexion ADB", null, Date.now());
    }
    return acquired;
  });
  if (!locked) {
    withRuntimeOwnership(database, owner, () => {
      setPreparation(database, profile.deviceId, operationId, "recovery_required", "Dispositivo bloqueado", "El dispositivo ya esta ocupado por Farm Appium.", Date.now());
    });
    throw new Error("El dispositivo ya esta ocupado por Farm Appium.");
  }

  let session: SessionRow | null = null;
  let appiumSessionId: string | null = null;
  try {
    const identity = await dependencies.adb.verifyDeviceIdentity(profile.deviceId, { signal: dependencies.signal });
    if (launchPackage) {
      withRuntimeOwnership(database, owner, () => {
        setPreparation(database, profile.deviceId, operationId, "preparing", "Reiniciando Facebook Lite", null, Date.now());
      });
      await dependencies.adb.resetToHomeAndLaunchApp(profile.deviceId, launchPackage, { signal: dependencies.signal });
    }
    session = withRuntimeOwnership(database, owner, () => {
      persistVerifiedIdentity(database, identity, Date.now());
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
      setPreparation(database, profile.deviceId, operationId, "preparing", "Validando acceso UiAutomator2", null, Date.now());
    });
    if (launchPackage) await dependencies.appium.activateApp(appiumSessionId, launchPackage, { signal: dependencies.signal });
    await dependencies.appium.getPageSource(appiumSessionId, { signal: dependencies.signal });

    assertRuntimeOwnership(database, owner);
    const cleanup = await closePreparationSession(
      dependencies.appium,
      appiumSessionId,
      dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs,
      dependencies.leaseSignal,
    );
    if (launchPackage) {
      try {
        await dependencies.adb.forceStopApp(profile.deviceId, launchPackage, { signal: dependencies.leaseSignal });
        await dependencies.adb.goHome(profile.deviceId, { signal: dependencies.leaseSignal });
      } catch (error) {
        cleanup.errors.push(`Facebook Lite/Home: ${messageOf(error)}`);
      }
    }
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
          cleanupStatus: "session_closed",
          closed: true,
        }, Date.now());
        updateOperationRuntime(database, operationId, "closed", "session_closed", Date.now());
        setPreparation(database, profile.deviceId, operationId, "ready", "Listo para Appium", null, Date.now());
        releaseDeviceLock(database, profile.deviceId, operationId, owner);
      });
      return {
        deviceId: profile.deviceId,
        hardwareId: identity.hardwareId,
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
    const cleanup = await closePreparationSession(
      dependencies.appium,
      appiumSessionId,
      cleanupTimeoutMs,
      dependencies.leaseSignal,
    );
    if (launchPackage) {
      try {
        await dependencies.adb.forceStopApp(profile.deviceId, launchPackage, { signal: dependencies.leaseSignal });
        await dependencies.adb.goHome(profile.deviceId, { signal: dependencies.leaseSignal });
      } catch (cleanupError) {
        cleanup.errors.push(`Facebook Lite/Home: ${messageOf(cleanupError)}`);
      }
    }
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
        cleanupStatus: "session_closed",
        error: [messageOf(error), evidenceError].filter(Boolean).join("; "),
        closed: true,
      }, Date.now());
      updateOperationRuntime(database, operationId, "closed", "session_closed", Date.now());
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

export type DeviceAutomationDependencies = {
  adb: AdbClient;
  appium: AppiumClient;
  requiredPackage: string;
  cleanupPackage?: string;
  artifactsPath?: string;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
  leaseSignal?: AbortSignal;
};

function markDeviceRecoveryRequired(
  database: Database.Database,
  deviceId: string,
  message: string,
  now: number,
  step = "Cleanup incierto",
) {
  database.prepare(`
    UPDATE device_preparations
    SET status = 'recovery_required', step = ?, error = ?,
        updated_at = ?, completed_at = ?
    WHERE id = (
      SELECT id FROM device_preparations
      WHERE device_id = ? AND setup_revision = ?
      ORDER BY updated_at DESC LIMIT 1
    )
  `).run(step, message, now, now, deviceId, CURRENT_SETUP_REVISION);
}

export async function runOwnedDeviceAutomation<T>(
  database: Database.Database,
  operationId: string,
  owner: string,
  dependencies: DeviceAutomationDependencies,
  run: (sessionId: string, inspection: AdbDeviceInspection) => Promise<T>,
) {
  const operation = database.prepare(`
    SELECT device_id AS deviceId FROM operations
    WHERE id = ? AND kind = 'assignment.execute' AND status = 'running'
  `).get(operationId) as { deviceId: string | null } | undefined;
  if (!operation?.deviceId) throw new Error("La ejecucion no tiene un dispositivo valido.");
  const profile = getDeviceProfile(database, operation.deviceId);
  if (!profile) throw new Error("El dispositivo no esta permitido.");
  const locked = withRuntimeOwnership(database, owner, () => acquireDeviceLock(
    database,
    profile.deviceId,
    operationId,
    owner,
    Date.now(),
    appConfig.workerLeaseMs,
  ));
  if (!locked) throw new Error("El dispositivo ya esta ocupado por Farm Appium.");

  let session: SessionRow | null = null;
  let appiumSessionId: string | null = null;
  try {
    const inspection = await dependencies.adb.inspectDevice(profile.deviceId, { signal: dependencies.signal });
    if (!inspection.packages.includes(dependencies.requiredPackage)) {
      throw new Error(`El paquete ${dependencies.requiredPackage} no esta instalado.`);
    }
    session = withRuntimeOwnership(database, owner, () => {
      const preparation = database.prepare(`
        SELECT status FROM device_preparations
        WHERE device_id = ? AND setup_revision = ?
        ORDER BY updated_at DESC LIMIT 1
      `).get(profile.deviceId, CURRENT_SETUP_REVISION) as { status: string } | undefined;
      if (preparation?.status !== "ready") throw new Error("El dispositivo ya no esta preparado.");
      persistInspection(database, inspection, Date.now());
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
          markDeviceRecoveryRequired(database, profile.deviceId, messageOf(error), Date.now(), "Sesion Appium rechazada");
          releaseDeviceLock(database, profile.deviceId, operationId, owner);
        });
        throw error;
      }
      const cleanupSignal = dependencies.leaseSignal
        ? AbortSignal.any([dependencies.leaseSignal, AbortSignal.timeout(dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs)])
        : AbortSignal.timeout(dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs);
      const evidenceError = await trySaveFailureEvidence(
        database,
        operationId,
        profile.deviceId,
        dependencies.appium,
        null,
        dependencies.artifactsPath ?? appConfig.artifactsPath,
        error,
        cleanupSignal,
        null,
        { stage: "create_session" },
      );
      const failure = [messageOf(error), evidenceError].filter(Boolean).join("; ");
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session!.id, {
          status: "outcome_unknown",
          cleanupStatus: "outcome_unknown",
          error: failure,
        }, Date.now());
        updateOperationRuntime(database, operationId, "outcome_unknown", "outcome_unknown", Date.now());
        markDeviceRecoveryRequired(database, profile.deviceId, failure, Date.now());
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
    });
    await dependencies.appium.getPageSource(appiumSessionId, { signal: dependencies.signal });
    const result = await run(appiumSessionId, inspection);
    const action = database.prepare(`
      SELECT checkpoint_id, action FROM assignment_action_results
      WHERE operation_id = ? AND checkpoint_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(operationId) as { checkpoint_id: string; action: string } | undefined;
    const evidenceSignal = AbortSignal.timeout(dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs);
    const preCleanupEvidence = await captureSessionEvidence(dependencies.appium, appiumSessionId, evidenceSignal);
    const preCleanupEvidenceError = await trySaveFailureEvidence(
      database,
      operationId,
      profile.deviceId,
      dependencies.appium,
      appiumSessionId,
      dependencies.artifactsPath ?? appConfig.artifactsPath,
      "Estado posterior al efecto publico antes del cleanup",
      AbortSignal.timeout(dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs),
      action?.checkpoint_id ?? null,
      { stage: "before_cleanup", action: action?.action ?? null },
      preCleanupEvidence,
    );
    const cleanup = await cleanupSession(
      dependencies.adb,
      dependencies.appium,
      profile.deviceId,
      appiumSessionId,
      dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs,
      false,
      dependencies.leaseSignal,
      dependencies.cleanupPackage,
    );
    assertRuntimeOwnership(database, owner);
    if (cleanup.errors.length) {
      if (preCleanupEvidenceError) cleanup.errors.push(preCleanupEvidenceError);
      const cleanupSignal = dependencies.leaseSignal
        ? AbortSignal.any([dependencies.leaseSignal, AbortSignal.timeout(dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs)])
        : AbortSignal.timeout(dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs);
      const evidenceError = await trySaveFailureEvidence(
        database,
        operationId,
        profile.deviceId,
        dependencies.appium,
        cleanup.sessionClosed ? null : appiumSessionId,
        dependencies.artifactsPath ?? appConfig.artifactsPath,
        cleanup.errors.join("; "),
        cleanupSignal,
        action?.checkpoint_id ?? null,
        { stage: "cleanup", action: action?.action ?? null },
      );
      if (evidenceError) cleanup.errors.push(evidenceError);
      const failure = cleanup.errors.join("; ");
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session!.id, {
          status: cleanup.sessionClosed ? "closed" : "outcome_unknown",
          cleanupStatus: "outcome_unknown",
          error: failure,
          closed: cleanup.sessionClosed,
        }, Date.now());
        updateOperationRuntime(database, operationId, cleanup.sessionClosed ? "closed" : "outcome_unknown", "outcome_unknown", Date.now());
        markDeviceRecoveryRequired(database, profile.deviceId, failure, Date.now());
      });
      throw new CleanupUnknownError("El cleanup del dispositivo quedo incierto.");
    }
    withRuntimeOwnership(database, owner, () => {
      updateSession(database, session!.id, {
        status: "closed",
        cleanupStatus: "home_confirmed",
        closed: true,
        ...(preCleanupEvidenceError ? { error: preCleanupEvidenceError } : {}),
      }, Date.now());
      updateOperationRuntime(database, operationId, "closed", "home_confirmed", Date.now());
      releaseDeviceLock(database, profile.deviceId, operationId, owner);
    });
    if (preCleanupEvidenceError) throw new EvidencePersistenceError(preCleanupEvidenceError);
    return result;
  } catch (error) {
    try {
      assertRuntimeOwnership(database, owner);
    } catch {
      throw new CleanupUnknownError("El worker perdio el lease; el nuevo owner debe ejecutar recovery.", { cause: error });
    }
    if (error instanceof EvidencePersistenceError) throw error;
    if (!session) {
      withRuntimeOwnership(database, owner, () => releaseDeviceLock(database, profile.deviceId, operationId, owner));
      throw error;
    }
    if (!appiumSessionId || error instanceof CleanupUnknownError) throw error;

    const action = database.prepare(`
      SELECT checkpoint_id, action FROM assignment_action_results
      WHERE operation_id = ? AND status = 'effect_possible'
      ORDER BY updated_at DESC LIMIT 1
    `).get(operationId) as { checkpoint_id: string | null; action: string } | undefined;
    const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? appConfig.cleanupTimeoutMs;
    const cleanupSignal = dependencies.leaseSignal
      ? AbortSignal.any([dependencies.leaseSignal, AbortSignal.timeout(cleanupTimeoutMs)])
      : AbortSignal.timeout(cleanupTimeoutMs);
    const evidenceError = await trySaveFailureEvidence(
      database,
      operationId,
      profile.deviceId,
      dependencies.appium,
      appiumSessionId,
      dependencies.artifactsPath ?? appConfig.artifactsPath,
      error,
      cleanupSignal,
      action?.checkpoint_id ?? null,
      { action: action?.action ?? null, stage: "automation" },
    );
    const cleanup = await cleanupSession(
      dependencies.adb,
      dependencies.appium,
      profile.deviceId,
      appiumSessionId,
      cleanupTimeoutMs,
      false,
      dependencies.leaseSignal,
      dependencies.cleanupPackage,
    );
    if (cleanup.errors.length) {
      if (evidenceError) cleanup.errors.push(evidenceError);
      const failure = cleanup.errors.join("; ");
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session!.id, {
          status: cleanup.sessionClosed ? "closed" : "outcome_unknown",
          cleanupStatus: "outcome_unknown",
          error: failure,
          closed: cleanup.sessionClosed,
        }, Date.now());
        updateOperationRuntime(database, operationId, cleanup.sessionClosed ? "closed" : "outcome_unknown", "outcome_unknown", Date.now());
        markDeviceRecoveryRequired(database, profile.deviceId, failure, Date.now());
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
  onlyUncertain = false,
) {
  assertRuntimeOwnership(database, owner);
  const sessions = database.prepare(`
    SELECT s.*, o.kind AS operation_kind FROM appium_sessions s
    JOIN operations o ON o.id = s.operation_id
    WHERE ${onlyUncertain
      ? "s.status = 'outcome_unknown' OR s.cleanup_status = 'outcome_unknown'"
      : "s.status IN ('starting', 'active', 'closing', 'outcome_unknown') OR s.cleanup_status = 'outcome_unknown'"}
    ORDER BY s.created_at
  `).all() as SessionRow[];

  for (const session of sessions) {
    if (!session.appium_session_id) {
      const timeoutSignal = AbortSignal.timeout(cleanupTimeoutMs);
      const cleanupSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        // No Appium command can run before its session ID is persisted, so no public effect occurred.
        await adb.inspectDevice(session.device_id, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs });
        await adb.goHome(session.device_id, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs });
      } catch (error) {
        const now = Date.now();
        withRuntimeOwnership(database, owner, () => {
          const message = [session.error, `Identidad/Home: ${messageOf(error)}`].filter(Boolean).join("; ");
          updateSession(database, session.id, {
            status: "outcome_unknown",
            cleanupStatus: "outcome_unknown",
            error: message,
          }, now);
          updateOperationRuntime(database, session.operation_id, "outcome_unknown", "outcome_unknown", now);
          if (session.operation_kind === "device.prepare") {
            setPreparation(database, session.device_id, session.operation_id, "recovery_required", "Inicio incierto durante recovery", message, now);
          } else {
            markDeviceRecoveryRequired(database, session.device_id, message, now);
          }
        });
        continue;
      }

      const now = Date.now();
      withRuntimeOwnership(database, owner, () => {
        updateSession(database, session.id, {
          status: "closed",
          cleanupStatus: "home_confirmed",
          error: [session.error, "ID de sesion Appium no persistido; Inicio confirmado"].filter(Boolean).join("; "),
          closed: true,
        }, now);
        updateOperationRuntime(database, session.operation_id, "closed", "home_confirmed", now);
        if (session.operation_kind === "device.prepare") {
          setPreparation(database, session.device_id, session.operation_id, "failed", "Sesion no identificada; Inicio confirmado", null, now);
        }
        releaseDeviceLock(database, session.device_id, session.operation_id, session.owner);
      });
      continue;
    }
    const alreadyClosed = session.status === "closed";
    const recoveryAction = session.operation_kind === "assignment.execute"
      ? database.prepare(`
          SELECT action, status, checkpoint_id FROM assignment_action_results
          WHERE operation_id = ?
          ORDER BY CASE status WHEN 'effect_possible' THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 1
        `).get(session.operation_id) as { action: string; status: string; checkpoint_id: string | null } | undefined
      : undefined;
    let recoveryEvidenceError: string | null = null;
    if (session.operation_kind === "assignment.execute" && !alreadyClosed) {
      const capturedKinds = (database.prepare(`
        SELECT COUNT(DISTINCT kind) AS total FROM evidence
        WHERE operation_id = ? AND checkpoint_id IS ? AND kind IN ('screenshot', 'page_source')
      `).get(session.operation_id, recoveryAction?.checkpoint_id ?? null) as { total: number }).total;
      if (capturedKinds < 2) {
        const evidenceTimeout = AbortSignal.timeout(cleanupTimeoutMs);
        const evidenceSignal = signal ? AbortSignal.any([signal, evidenceTimeout]) : evidenceTimeout;
        recoveryEvidenceError = await trySaveFailureEvidence(
          database,
          session.operation_id,
          session.device_id,
          appium,
          session.appium_session_id,
          artifactsPath,
          recoveryAction?.status === "effect_possible"
            ? "Worker interrumpido despues de un posible efecto publico"
            : "Worker interrumpido con una sesion de ejecucion activa",
          evidenceSignal,
          recoveryAction?.checkpoint_id ?? null,
          { stage: "recovery_before_cleanup", action: recoveryAction?.action ?? null },
        );
      }
    }
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
      if (recoveryEvidenceError) cleanup.errors.push(recoveryEvidenceError);
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
        recoveryAction?.checkpoint_id ?? null,
        { stage: "recovery_cleanup", action: recoveryAction?.action ?? null },
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
        if (session.operation_kind === "device.prepare") {
          setPreparation(database, session.device_id, session.operation_id, "recovery_required", "Cleanup incierto", cleanup.errors.join("; "), now);
        } else {
          markDeviceRecoveryRequired(database, session.device_id, cleanup.errors.join("; "), now);
        }
      });
      continue;
    }
    const now = Date.now();
    withRuntimeOwnership(database, owner, () => {
      updateSession(database, session.id, {
        status: "closed",
        cleanupStatus: "home_confirmed",
        closed: true,
        ...(recoveryEvidenceError ? { error: recoveryEvidenceError } : {}),
      }, now);
      updateOperationRuntime(database, session.operation_id, "closed", "home_confirmed", now);
      if (session.operation_kind === "device.prepare") {
        setPreparation(database, session.device_id, session.operation_id, "failed", "Sesion recuperada tras reinicio", null, now);
      }
      releaseDeviceLock(database, session.device_id, session.operation_id, session.owner);
    });
  }

  const orphanLocks = database.prepare(`
    SELECT l.device_id, l.operation_id, l.owner, o.kind AS operation_kind
    FROM device_locks l
    JOIN operations o ON o.id = l.operation_id
    LEFT JOIN appium_sessions s ON s.operation_id = l.operation_id
      AND (s.status IN ('starting', 'active', 'closing', 'outcome_unknown') OR s.cleanup_status = 'outcome_unknown')
    WHERE s.id IS NULL${onlyUncertain ? " AND (o.status = 'outcome_unknown' OR o.cleanup_status = 'outcome_unknown')" : ""}
  `).all() as Array<{ device_id: string; operation_id: string; owner: string; operation_kind: string }>;
  for (const lock of orphanLocks) {
    try {
      const timeoutSignal = AbortSignal.timeout(cleanupTimeoutMs);
      const cleanupSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      await adb.inspectDevice(lock.device_id, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs });
      await adb.goHome(lock.device_id, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs });
      const now = Date.now();
      withRuntimeOwnership(database, owner, () => {
        updateOperationRuntime(database, lock.operation_id, "closed", "home_confirmed", now);
        if (lock.operation_kind === "device.prepare") {
          setPreparation(database, lock.device_id, lock.operation_id, "failed", "Lock recuperado tras reinicio", null, now);
        }
        releaseDeviceLock(database, lock.device_id, lock.operation_id, lock.owner);
      });
    } catch (error) {
      const now = Date.now();
      withRuntimeOwnership(database, owner, () => {
        updateOperationRuntime(database, lock.operation_id, "failed", "outcome_unknown", now);
        if (lock.operation_kind === "device.prepare") {
          setPreparation(database, lock.device_id, lock.operation_id, "recovery_required", "Home incierto durante recovery", messageOf(error), now);
        } else {
          markDeviceRecoveryRequired(database, lock.device_id, messageOf(error), now);
        }
      });
    }
  }
}

export async function recoverRequestedUncertainSessions(
  database: Database.Database,
  owner: string,
  adb: AdbClient,
  appium: AppiumClient,
  cleanupTimeoutMs = appConfig.cleanupTimeoutMs,
  artifactsPath = appConfig.artifactsPath,
  signal?: AbortSignal,
) {
  const request = database.prepare("SELECT status FROM device_recovery_requests WHERE singleton = 1 AND status = 'pending'").get();
  if (!request) return false;

  withRuntimeOwnership(database, owner, () => {
    database.prepare(`
      UPDATE device_recovery_requests
      SET status = 'running', started_at = ?, completed_at = NULL, error = NULL
      WHERE singleton = 1 AND status = 'pending'
    `).run(Date.now());
  });

  try {
    await recoverOwnedSessions(database, owner, adb, appium, cleanupTimeoutMs, artifactsPath, signal, true);
    withRuntimeOwnership(database, owner, () => {
      database.prepare(`
        UPDATE device_recovery_requests
        SET status = 'completed', completed_at = ?, error = NULL
        WHERE singleton = 1 AND status = 'running'
      `).run(Date.now());
    });
  } catch (error) {
    withRuntimeOwnership(database, owner, () => {
      database.prepare(`
        UPDATE device_recovery_requests
        SET status = 'failed', completed_at = ?, error = ?
        WHERE singleton = 1 AND status = 'running'
      `).run(Date.now(), messageOf(error));
    });
  }
  return true;
}
