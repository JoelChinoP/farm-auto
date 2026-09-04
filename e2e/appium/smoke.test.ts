import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdbClient } from "../../src/lib/adb.ts";
import { AppiumClient } from "../../src/lib/appium-client.ts";
import { appConfig } from "../../src/lib/config.ts";
import { openDatabase } from "../../src/lib/database.ts";
import { upsertDeviceProfile } from "../../src/lib/device-runtime.ts";
import { createOperation } from "../../src/lib/operations.ts";
import { enqueueJob } from "../../src/lib/queue.ts";
import { runWorker } from "../../src/worker.ts";

type E2eDevice = {
  deviceId: string;
  hardwareId: string;
  systemPort: number;
};

const enabled = process.env.RUN_APPIUM_E2E === "1";
const requestedDeviceCount = Number(process.env.FARM_APPIUM_E2E_COUNT || 2);
if (enabled && ![1, 2].includes(requestedDeviceCount)) {
  throw new Error("FARM_APPIUM_E2E_COUNT debe ser 1 o 2.");
}

function configuredDevices(required: number) {
  const value = JSON.parse(process.env.FARM_APPIUM_E2E_DEVICES || "[]") as unknown;
  if (!Array.isArray(value) || value.length < required) {
    throw new Error(`FARM_APPIUM_E2E_DEVICES debe contener al menos ${required} dispositivos explicitos.`);
  }
  const devices = value.map((device): E2eDevice => {
    if (typeof device !== "object" || device === null) throw new Error("Cada dispositivo E2E debe ser un objeto.");
    const candidate = device as Record<string, unknown>;
    return {
      deviceId: typeof candidate.deviceId === "string" ? candidate.deviceId.trim() : "",
      hardwareId: typeof candidate.hardwareId === "string" ? candidate.hardwareId.trim().toLowerCase() : "",
      systemPort: candidate.systemPort as number,
    };
  });
  if (devices.some((device) => !device.deviceId || !/^[0-9a-f]{64}$/.test(device.hardwareId))) {
    throw new Error("Cada dispositivo E2E requiere deviceId y hardwareId SHA-256 validos.");
  }
  if (new Set(devices.map((device) => device.deviceId)).size !== devices.length) {
    throw new Error("Los dispositivos E2E deben tener seriales distintos.");
  }
  if (new Set(devices.map((device) => device.systemPort)).size !== devices.length) {
    throw new Error("Los dispositivos E2E deben tener systemPort distintos.");
  }
  return devices;
}

async function runSmoke(devices: E2eDevice[]) {
  const directory = await mkdtemp(join(tmpdir(), "farm-appium-e2e-"));
  const database = openDatabase(join(directory, "smoke.sqlite"));
  try {
    for (const [index, device] of devices.entries()) {
      upsertDeviceProfile(database, {
        ...device,
        alias: `Smoke ${index + 1}`,
        physicalOrder: index + 1,
      });
      const operation = createOperation(database, {
        kind: "device.prepare",
        idempotencyKey: randomUUID(),
        request: { deviceId: device.deviceId, safeSmoke: true },
        deviceId: device.deviceId,
      }).operation;
      enqueueJob(database, "device.prepare", { deviceId: device.deviceId }, {
        operationId: operation.id,
        maxAttempts: 1,
      });
    }

    const adb = new AdbClient({ database, timeoutMs: appConfig.adbTimeoutMs });
    const appium = new AppiumClient({ baseUrl: appConfig.appiumUrl, timeoutMs: appConfig.appiumTimeoutMs });
    for (let index = 0; index < devices.length; index += 1) {
      await runWorker({ database, adb, appium, owner: `e2e-${index + 1}-${randomUUID()}`, once: true });
    }

    const jobs = database.prepare("SELECT status FROM jobs ORDER BY created_at, id").all() as Array<{ status: string }>;
    assert.deepEqual(jobs.map((job) => job.status), devices.map(() => "succeeded"));
    const preparations = database.prepare("SELECT status FROM device_preparations ORDER BY created_at, id").all() as Array<{ status: string }>;
    assert.deepEqual(preparations.map((preparation) => preparation.status), devices.map(() => "ready"));
    const sessions = database.prepare("SELECT status, cleanup_status FROM appium_sessions").all() as Array<{ status: string; cleanup_status: string }>;
    assert.ok(sessions.every((session) => session.status === "closed" && session.cleanup_status === "home_confirmed"));
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("safe Appium smoke with one explicit device", { skip: !enabled || requestedDeviceCount < 1 }, async () => {
  await runSmoke(configuredDevices(1).slice(0, 1));
});

test("safe Appium smoke with two explicit devices sequentially", { skip: !enabled || requestedDeviceCount < 2 }, async () => {
  await runSmoke(configuredDevices(2).slice(0, 2));
});
