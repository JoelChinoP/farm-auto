import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type Database from "better-sqlite3";

import {
  AdbClient,
  type AdbExecutor,
  calculateHardwareId,
} from "../src/lib/adb.ts";
import { AppiumClient, type AppiumFetch } from "../src/lib/appium-client.ts";
import { openDatabase } from "../src/lib/database.ts";
import {
  acquireDeviceLock,
  assertRuntimeOwnership,
  claimRuntimeOwnership,
  CleanupUnknownError,
  clearDeviceList,
  getDeviceProfile,
  listDeviceSnapshots,
  prepareDevice,
  queueDevicePreparation,
  registerConnectedDevices,
  recoverOwnedSessions,
  recoverRequestedUncertainSessions,
  refreshDeviceInventory,
  releaseDeviceLock,
  releaseRuntimeOwnership,
  runOwnedDeviceAutomation,
  upsertDeviceProfile,
} from "../src/lib/device-runtime.ts";
import { createOperation, getOperation } from "../src/lib/operations.ts";
import { claimNextJob, completeJob, enqueueJob, failJob, getJob } from "../src/lib/queue.ts";

const SERIAL = "serial-1";
const HARDWARE_ID = calculateHardwareId("physical-1", "android-1");

async function withDatabase(run: (database: Database.Database, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "farm-runtime-"));
  const database = openDatabase(join(directory, "test.sqlite"));
  try {
    await run(database, directory);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function createAdb(database: Database.Database, roSerialNo = "physical-1") {
  let foreground = "com.example.before/.MainActivity";
  const calls: string[] = [];
  const executor: AdbExecutor = async (_file: string, args: readonly string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "devices") return { stdout: `List of devices attached\n${SERIAL} device model:SM_G950U\n`, stderr: "" };
    const command = args.slice(2).join(" ");
    if (command === "shell getprop ro.product.model") return { stdout: "SM-G950U\n", stderr: "" };
    if (command === "shell getprop ro.serialno") return { stdout: `${roSerialNo}\n`, stderr: "" };
    if (command === "shell settings get secure android_id") return { stdout: "android-1\n", stderr: "" };
    if (command === "shell pm list packages") return { stdout: "package:com.android.chrome\npackage:com.sec.android.app.launcher\n", stderr: "" };
    if (command.includes("resolve-activity") && command.includes("android.intent.action.VIEW")) {
      return { stdout: "com.android.chrome/com.google.android.apps.chrome.Main\n", stderr: "" };
    }
    if (command.includes("resolve-activity")) return { stdout: "com.sec.android.app.launcher/.activities.LauncherActivity\n", stderr: "" };
    if (command === "shell input keyevent KEYCODE_HOME") foreground = "com.sec.android.app.launcher/.activities.LauncherActivity";
    if (command.includes("android.intent.action.VIEW")) foreground = "com.android.chrome/com.google.android.apps.chrome.Main";
    if (command === "shell dumpsys window windows") return { stdout: `mCurrentFocus=Window{42 u0 ${foreground}}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return {
    calls,
    client: new AdbClient({
      database,
      executor,
      homeTimeoutMs: 10,
      homePollIntervalMs: 1,
      sleep: async () => undefined,
    }),
  };
}

function setupPreparation(database: Database.Database, systemPort = 8200) {
  upsertDeviceProfile(database, {
    hardwareId: HARDWARE_ID,
    deviceId: SERIAL,
    alias: "Equipo 1",
    physicalOrder: 1,
    systemPort,
  });
  const operation = createOperation(database, {
    kind: "device.prepare",
    idempotencyKey: randomUUID(),
    request: { deviceId: SERIAL },
    deviceId: SERIAL,
  }).operation;
  const job = enqueueJob(database, "device.prepare", { deviceId: SERIAL }, {
    operationId: operation.id,
    maxAttempts: 1,
    availableAt: 0,
  });
  claimRuntimeOwnership(database, "worker-1", 1, Date.now(), 60_000);
  claimNextJob(database, "worker-1");
  return { job, operation };
}

test("registers a connected ADB device with verified identity and a persistent port", async () => {
  await withDatabase(async (database) => {
    const adb = createAdb(database);
    const [registered] = await registerConnectedDevices(database, adb.client, [SERIAL]);
    assert.equal(registered.hardwareId, HARDWARE_ID);
    assert.equal(registered.deviceId, SERIAL);
    assert.equal(registered.systemPort, 8200);
    assert.equal((database.prepare("SELECT connection FROM device_observations WHERE device_id = ?").get(SERIAL) as { connection: string }).connection, "connected");

    const [repeated] = await registerConnectedDevices(database, adb.client, [SERIAL]);
    assert.deepEqual(repeated, registered);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_profiles").get() as { total: number }).total, 1);
  });
});

test("prepares one allowlisted device and confirms owned-session cleanup", async () => {
  await withDatabase(async (database, directory) => {
    const { job, operation } = setupPreparation(database);
    const adb = createAdb(database);
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetch: AppiumFetch = async (input, init) => {
      const url = String(input);
      requests.push({
        method: init?.method ?? "GET",
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/session") && init?.method === "POST") {
        return Response.json({ value: { sessionId: "owned-1", capabilities: { platformName: "Android" } } });
      }
      if (url.endsWith("/source")) return Response.json({ value: "<hierarchy rotation=\"0\"><node /></hierarchy>" });
      return Response.json({ value: null });
    };
    const appium = new AppiumClient({ baseUrl: "http://127.0.0.1:4723", fetch });

    const result = await prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
    });
    completeJob(database, job.id, "worker-1", result);

    assert.equal(result.deviceId, SERIAL);
    assert.equal(result.hardwareId, HARDWARE_ID);
    assert.equal(getOperation(database, operation.id)?.status, "succeeded");
    assert.equal((database.prepare("SELECT status FROM device_preparations").get() as { status: string }).status, "ready");
    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "closed");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
    assert.equal(requests.filter((request) => request.method === "DELETE").length, 1);
    assert.ok(adb.calls.every((call) => call.startsWith("devices -l") || call.startsWith(`-s ${SERIAL} `)));
    assert.ok(adb.calls.every((call) => !call.includes("pm list packages") && !call.includes("KEYCODE_HOME") && !call.includes("https://example.com/")));
  });
});

test("clears the visible list and restarts default names when devices are added again", async () => {
  await withDatabase(async (database) => {
    const adb = createAdb(database);
    await registerConnectedDevices(database, adb.client, [SERIAL]);

    assert.equal(clearDeviceList(database), 1);
    assert.equal((database.prepare("SELECT status FROM device_retirements WHERE device_id = ?").get(SERIAL) as { status: string }).status, "completed");

    const [registeredAgain] = await registerConnectedDevices(database, adb.client, [SERIAL]);
    assert.equal(registeredAgain.alias, "Equipo 1");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_retirements").get() as { total: number }).total, 0);
  });
});

test("explains why an uncertain Appium session blocks clearing the device list", async () => {
  await withDatabase(async (database) => {
    upsertDeviceProfile(database, {
      hardwareId: HARDWARE_ID,
      deviceId: SERIAL,
      alias: "Equipo 1",
      physicalOrder: 1,
      systemPort: 8200,
    });
    const operation = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: randomUUID(),
      request: { deviceId: SERIAL },
      deviceId: SERIAL,
    }).operation;
    database.prepare(`
      INSERT INTO appium_sessions (
        id, operation_id, device_id, system_port, owner, status, cleanup_status, created_at, updated_at
      ) VALUES (?, ?, ?, 8200, 'test', 'outcome_unknown', 'outcome_unknown', 1, 1)
    `).run(randomUUID(), operation.id, SERIAL);

    assert.throws(() => clearDeviceList(database), /resultado incierto/);
  });
});

test("persists a queued Appium check for the next device snapshot", async () => {
  await withDatabase(async (database) => {
    const { operation } = setupPreparation(database);
    queueDevicePreparation(database, SERIAL, operation.id);

    const [device] = listDeviceSnapshots(database) as unknown as Array<{ preparationStatus: string; preparationStep: string }>;
    assert.equal(device.preparationStatus, "preparing");
    assert.equal(device.preparationStep, "En cola para comprobar Appium");
  });
});

test("preserves evidence and blocks the device when cleanup is uncertain", async () => {
  await withDatabase(async (database, directory) => {
    const { job, operation } = setupPreparation(database);
    const adb = createAdb(database);
    const screenshot = Buffer.from("png").toString("base64");
    const fetch: AppiumFetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/session") && init?.method === "POST") {
        return Response.json({ value: { sessionId: "owned-1", capabilities: {} } });
      }
      if (init?.method === "DELETE") {
        return Response.json({ value: { error: "unknown error", message: "delete timed out" } }, { status: 500 });
      }
      if (url.endsWith("/screenshot")) return Response.json({ value: screenshot });
      if (url.endsWith("/source")) return Response.json({ value: "<hierarchy><node /></hierarchy>" });
      return Response.json({ value: null });
    };
    const appium = new AppiumClient({ baseUrl: "http://127.0.0.1:4723", fetch });

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
      cleanupTimeoutMs: 100,
    }), CleanupUnknownError);
    failJob(database, job.id, "worker-1", "cleanup unknown");

    assert.equal(getJob(database, job.id)?.status, "failed");
    assert.equal(getOperation(database, operation.id)?.cleanupStatus, "outcome_unknown");
    assert.equal((database.prepare("SELECT status FROM device_preparations").get() as { status: string }).status, "recovery_required");
    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "outcome_unknown");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM evidence").get() as { total: number }).total, 3);
    const paths = database.prepare("SELECT path FROM evidence WHERE operation_id = ?").all(operation.id) as Array<{ path: string }>;
    await Promise.all(paths.map(({ path }) => access(path)));
  });
});

test("keeps an unknown create-session reservation and never opens the safe URL", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async () => { throw new Error("connection reset"); },
    });

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
      cleanupTimeoutMs: 100,
    }), /determinar si Appium creo/);

    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "outcome_unknown");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 1);
    assert.equal(adb.calls.some((call) => call.includes("android.intent.action.VIEW")), false);
    const metadata = database.prepare("SELECT path FROM evidence WHERE operation_id = ? AND kind = 'metadata'")
      .get(operation.id) as { path: string };
    await access(metadata.path);
  });
});

test("keeps the reservation when Appium returns an invalid HTTP 200 session", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async () => Response.json({ value: { capabilities: {} } }),
    });

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
      cleanupTimeoutMs: 100,
    }), /determinar si Appium creo/);

    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "outcome_unknown");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 1);
  });
});

test("closes a known session id from a malformed Appium response", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    const adb = createAdb(database);
    let deletes = 0;
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/session") && init?.method === "POST") {
          return Response.json({ value: { sessionId: "owned-partial" } });
        }
        if (init?.method === "DELETE") {
          deletes += 1;
          return Response.json({ value: null });
        }
        if (url.endsWith("/source")) return Response.json({ value: "<hierarchy><node /></hierarchy>" });
        if (url.endsWith("/screenshot")) return Response.json({ value: Buffer.from("png").toString("base64") });
        return Response.json({ value: null });
      },
    });

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
    }), /invalid session response/);

    const session = database.prepare("SELECT appium_session_id, status, cleanup_status FROM appium_sessions").get() as {
      appium_session_id: string;
      status: string;
      cleanup_status: string;
    };
    assert.deepEqual(session, {
      appium_session_id: "owned-partial",
      status: "failed",
      cleanup_status: "session_closed",
    });
    assert.equal(deletes, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
  });
});

test("cancellation aborts work but not owned-session cleanup", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    const adb = createAdb(database);
    const controller = new AbortController();
    let sourceRequests = 0;
    let deletes = 0;
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/session") && init?.method === "POST") {
          return Response.json({ value: { sessionId: "owned-1", capabilities: {} } });
        }
        if (url.endsWith("/source")) {
          sourceRequests += 1;
          if (sourceRequests === 1) {
            controller.abort(new Error("cancelled"));
            throw controller.signal.reason;
          }
          return Response.json({ value: "<hierarchy><node /></hierarchy>" });
        }
        if (url.endsWith("/screenshot")) return Response.json({ value: Buffer.from("png").toString("base64") });
        if (init?.method === "DELETE") {
          deletes += 1;
          return Response.json({ value: null });
        }
        return Response.json({ value: null });
      },
    });

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
      signal: controller.signal,
    }), /aborted/);

    assert.equal(deletes, 1);
    assert.equal((database.prepare("SELECT cleanup_status FROM appium_sessions").get() as { cleanup_status: string }).cleanup_status, "session_closed");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
  });
});

test("treats invalid session id as an already closed Appium session", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/session") && init?.method === "POST") {
          return Response.json({ value: { sessionId: "owned-1", capabilities: {} } });
        }
        if (init?.method === "DELETE") {
          return Response.json({ value: { error: "invalid session id", message: "already gone" } }, { status: 404 });
        }
        if (url.endsWith("/source")) return Response.json({ value: "<hierarchy><node /></hierarchy>" });
        return Response.json({ value: null });
      },
    });

    await prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
    });

    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "closed");
    assert.equal((database.prepare("SELECT cleanup_status FROM appium_sessions").get() as { cleanup_status: string }).cleanup_status, "session_closed");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
  });
});

test("does not persist cleanup after losing runtime ownership", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/session") && init?.method === "POST") {
          return Response.json({ value: { sessionId: "owned-1", capabilities: {} } });
        }
        if (init?.method === "DELETE") {
          database.prepare("DELETE FROM runtime_ownership").run();
          assert.equal(claimRuntimeOwnership(database, "worker-2", 2, Date.now(), 60_000), true);
          return Response.json({ value: null });
        }
        if (url.endsWith("/source")) return Response.json({ value: "<hierarchy><node /></hierarchy>" });
        return Response.json({ value: null });
      },
    });

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
    }), /perdio el lease/);

    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "active");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 1);
  });
});

test("releases the device after UiAutomator2 rejects a new session", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async () => Response.json({
        value: { error: "session not created", message: "UiAutomation not connected" },
      }, { status: 500 }),
    });

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
    }), /UiAutomation not connected/);
    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "failed");
    assert.equal((database.prepare("SELECT status FROM device_preparations").get() as { status: string }).status, "failed");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
    assert.equal(adb.calls.some((call) => call.includes("android.intent.action.VIEW")), false);
  });
});

test("marks a preparation as blocked instead of leaving it queued", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    assert.equal(acquireDeviceLock(database, SERIAL, operation.id, "other-worker", Date.now(), 60_000), true);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async () => { throw new Error("Appium must not be contacted"); },
    });

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: join(directory, "artifacts"),
    }), /ocupado/);

    assert.deepEqual(database.prepare("SELECT status, step FROM device_preparations").get(), {
      status: "recovery_required",
      step: "Dispositivo bloqueado",
    });
  });
});

test("invalidates a ready preparation when an execution session is rejected", async () => {
  await withDatabase(async (database, directory) => {
    const { operation: preparation } = setupPreparation(database);
    database.prepare(`
      INSERT INTO device_preparations (
        id, device_id, operation_id, status, step, created_at, updated_at, completed_at, setup_revision
      ) VALUES (?, ?, ?, 'ready', 'Preparacion completada', 1, 1, 1, 1)
    `).run(randomUUID(), SERIAL, preparation.id);
    const execution = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: randomUUID(),
      request: { deviceId: SERIAL },
      deviceId: SERIAL,
    }).operation;
    database.prepare("UPDATE operations SET status = 'running' WHERE id = ?").run(execution.id);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async () => Response.json({
        value: { error: "session not created", message: "UiAutomation not connected" },
      }, { status: 500 }),
    });

    await assert.rejects(runOwnedDeviceAutomation(database, execution.id, "worker-1", {
      adb: adb.client,
      appium,
      requiredPackage: "com.android.chrome",
      artifactsPath: join(directory, "artifacts"),
    }, async () => { throw new Error("El flujo no debio ejecutarse."); }), /UiAutomation not connected/);

    assert.deepEqual(database.prepare("SELECT status, step FROM device_preparations WHERE device_id = ?").get(SERIAL), {
      status: "recovery_required",
      step: "Sesion Appium rechazada",
    });
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "failed");
  });
});

test("still closes Appium when evidence storage fails", async () => {
  await withDatabase(async (database, directory) => {
    const { operation } = setupPreparation(database);
    const adb = createAdb(database);
    let deletes = 0;
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/session") && init?.method === "POST") {
          return Response.json({ value: { sessionId: "owned-1", capabilities: {} } });
        }
        if (init?.method === "DELETE") {
          deletes += 1;
          return Response.json({ value: null });
        }
        if (url.endsWith("/source")) return Response.json({ value: "invalid" });
        if (url.endsWith("/screenshot")) return Response.json({ value: Buffer.from("png").toString("base64") });
        return Response.json({ value: null });
      },
    });
    const invalidArtifactsPath = join(directory, "not-a-directory");
    await writeFile(invalidArtifactsPath, "file");

    await assert.rejects(prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
      artifactsPath: invalidArtifactsPath,
      cleanupTimeoutMs: 100,
    }), /hierarchy/);
    assert.equal(deletes, 1);
    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "failed");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
  });
});

test("recovers an orphan device lock only after confirming Home", async () => {
  await withDatabase(async (database) => {
    upsertDeviceProfile(database, {
      hardwareId: HARDWARE_ID,
      deviceId: SERIAL,
      alias: "Equipo 1",
      physicalOrder: 1,
      systemPort: 8200,
    });
    const operation = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: SERIAL },
      deviceId: SERIAL,
    }).operation;
    assert.equal(acquireDeviceLock(database, SERIAL, operation.id, "dead-worker", 1, 1), true);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async () => { throw new Error("Appium must not be contacted"); },
    });

    claimRuntimeOwnership(database, "recovery-worker", 2, Date.now(), 60_000);
    await recoverOwnedSessions(database, "recovery-worker", adb.client, appium, 100);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
    assert.equal((database.prepare("SELECT cleanup_status FROM operations").get() as { cleanup_status: string }).cleanup_status, "home_confirmed");
  });
});

test("keeps an orphan lock when the physical identity changed", async () => {
  await withDatabase(async (database) => {
    upsertDeviceProfile(database, {
      hardwareId: HARDWARE_ID,
      deviceId: SERIAL,
      alias: "Equipo 1",
      physicalOrder: 1,
      systemPort: 8200,
    });
    const operation = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: SERIAL },
      deviceId: SERIAL,
    }).operation;
    assert.equal(acquireDeviceLock(database, SERIAL, operation.id, "dead-worker", 1, 1), true);
    claimRuntimeOwnership(database, "recovery-worker", 2, Date.now(), 60_000);
    const adb = createAdb(database, "different-physical-device");
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async () => { throw new Error("Appium must not be contacted"); },
    });

    await recoverOwnedSessions(database, "recovery-worker", adb.client, appium, 100);

    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 1);
    assert.equal((database.prepare("SELECT cleanup_status FROM operations").get() as { cleanup_status: string }).cleanup_status, "outcome_unknown");
    assert.equal((database.prepare("SELECT status FROM device_preparations").get() as { status: string }).status, "recovery_required");
  });
});

test("releases an unidentified Appium reservation after confirming Home", async () => {
  await withDatabase(async (database) => {
    const { operation } = setupPreparation(database);
    assert.equal(acquireDeviceLock(database, SERIAL, operation.id, "dead-worker", 1, 60_000), true);
    database.prepare(`
      INSERT INTO appium_sessions (
        id, operation_id, device_id, system_port, owner, status, cleanup_status, created_at, updated_at
      ) VALUES (?, ?, ?, 8200, 'dead-worker', 'outcome_unknown', 'outcome_unknown', 1, 1)
    `).run(randomUUID(), operation.id, SERIAL);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async () => { throw new Error("No Appium session ID was persisted"); },
    });
    await recoverOwnedSessions(database, "worker-1", adb.client, appium, 1_000);

    assert.equal((database.prepare("SELECT status FROM appium_sessions").get() as { status: string }).status, "closed");
    assert.equal((database.prepare("SELECT cleanup_status FROM operations").get() as { cleanup_status: string }).cleanup_status, "home_confirmed");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 0);
    assert.ok(adb.calls.some((call) => call.includes("KEYCODE_HOME")));
  });
});

test("worker recovery request only closes uncertain sessions", async () => {
  await withDatabase(async (database) => {
    const { operation: uncertain } = setupPreparation(database);
    const activeDevice = "serial-2";
    upsertDeviceProfile(database, {
      hardwareId: calculateHardwareId("physical-2", "android-2"),
      deviceId: activeDevice,
      alias: "Equipo 2",
      physicalOrder: 2,
      systemPort: 8201,
    });
    const active = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: activeDevice },
      deviceId: activeDevice,
    }).operation;
    const now = Date.now();
    const insertSession = database.prepare(`
      INSERT INTO appium_sessions (
        id, appium_session_id, operation_id, device_id, system_port, owner,
        status, cleanup_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'dead-worker', ?, ?, ?, ?)
    `);
    insertSession.run(randomUUID(), "uncertain-session", uncertain.id, SERIAL, 8200, "outcome_unknown", "outcome_unknown", now, now);
    insertSession.run(randomUUID(), "active-session", active.id, activeDevice, 8201, "active", "pending", now, now);
    database.prepare("INSERT INTO device_recovery_requests VALUES (1, 'pending', ?, NULL, NULL, NULL)").run(now);
    claimRuntimeOwnership(database, "worker-1", process.pid, now, 60_000);

    const adb = createAdb(database);
    const deleted: string[] = [];
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      ownedSessionIds: ["uncertain-session", "active-session"],
      fetch: async (input, init) => {
        if (init?.method === "DELETE") deleted.push(String(input));
        return Response.json({ value: null });
      },
    });

    assert.equal(await recoverRequestedUncertainSessions(database, "worker-1", adb.client, appium, 100), true);
    assert.deepEqual(deleted, ["http://127.0.0.1:4723/session/uncertain-session"]);
    assert.equal((database.prepare("SELECT status FROM appium_sessions WHERE appium_session_id = 'active-session'").get() as { status: string }).status, "active");
    assert.equal((database.prepare("SELECT status FROM device_recovery_requests").get() as { status: string }).status, "completed");
  });
});

test("persists offline and unauthorized inventory without directed ADB commands", async () => {
  await withDatabase(async (database) => {
    upsertDeviceProfile(database, {
      hardwareId: HARDWARE_ID,
      deviceId: SERIAL,
      alias: "Equipo 1",
      physicalOrder: 1,
      systemPort: 8200,
    });
    const calls: string[] = [];
    const adb = new AdbClient({
      database,
      executor: async (_file, args) => {
        calls.push(args.join(" "));
        return { stdout: `List of devices attached\n${SERIAL} unauthorized\n`, stderr: "" };
      },
    });
    await refreshDeviceInventory(database, adb);

    assert.deepEqual(calls, ["devices -l"]);
    assert.equal((database.prepare("SELECT connection FROM device_observations").get() as { connection: string }).connection, "unauthorized");
  });
});

test("persists complete inventory for connected allowlisted devices", async () => {
  await withDatabase(async (database) => {
    upsertDeviceProfile(database, {
      hardwareId: HARDWARE_ID,
      deviceId: SERIAL,
      alias: "Equipo 1",
      physicalOrder: 1,
      systemPort: 8200,
    });
    const adb = createAdb(database);

    await refreshDeviceInventory(database, adb.client);

    const observation = database.prepare(`
      SELECT hardware_id, packages_json, foreground_package, launcher_package, error
      FROM device_observations
    `).get() as Record<string, string | null>;
    assert.equal(observation.hardware_id, HARDWARE_ID);
    assert.deepEqual(JSON.parse(observation.packages_json!), ["com.android.chrome", "com.sec.android.app.launcher"]);
    assert.equal(observation.foreground_package, "com.example.before");
    assert.equal(observation.launcher_package, "com.sec.android.app.launcher");
    assert.equal(observation.error, null);
  });
});

test("keeps the last validated identity while a connected refresh is still inspecting", async () => {
  await withDatabase(async (database) => {
    upsertDeviceProfile(database, {
      hardwareId: HARDWARE_ID,
      deviceId: SERIAL,
      alias: "Equipo 1",
      physicalOrder: 1,
      systemPort: 8200,
    });
    await refreshDeviceInventory(database, createAdb(database).client);
    let releaseInspection!: () => void;
    const inspectionBlocked = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const adb = new AdbClient({
      database,
      executor: async (_file, args) => {
        if (args.join(" ") === "devices -l") return { stdout: `List of devices attached\n${SERIAL} device model:SM-G950U\n`, stderr: "" };
        await inspectionBlocked;
        throw new Error("inspection stopped");
      },
    });
    const refresh = refreshDeviceInventory(database, adb);
    await new Promise((resolve) => setImmediate(resolve));
    const duringRefresh = database.prepare("SELECT hardware_id, packages_json FROM device_observations WHERE device_id = ?")
      .get(SERIAL) as { hardware_id: string | null; packages_json: string };
    assert.equal(duringRefresh.hardware_id, HARDWARE_ID);
    assert.deepEqual(JSON.parse(duringRefresh.packages_json), ["com.android.chrome", "com.sec.android.app.launcher"]);
    releaseInspection();
    await refresh;
  });
});

test("updates a stable hardware profile to a new ADB transport and invalidates readiness", async () => {
  await withDatabase(async (database) => {
    const { job, operation } = setupPreparation(database);
    const adb = createAdb(database);
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/session") && init?.method === "POST") {
          return Response.json({ value: { sessionId: "owned-1", capabilities: {} } });
        }
        if (url.endsWith("/source")) return Response.json({ value: "<hierarchy><node /></hierarchy>" });
        return Response.json({ value: null });
      },
    });
    const result = await prepareDevice(database, operation.id, "worker-1", {
      adb: adb.client,
      appium,
    });
    completeJob(database, job.id, "worker-1", result);
    database.prepare("INSERT INTO device_retirements VALUES (?, 'completed', 1, 1)").run(SERIAL);

    const updated = upsertDeviceProfile(database, {
      hardwareId: HARDWARE_ID,
      deviceId: "serial-2",
      alias: "Equipo movido",
      physicalOrder: 2,
      systemPort: 8201,
    });

    assert.equal(updated.deviceId, "serial-2");
    assert.equal(getDeviceProfile(database, SERIAL), null);
    assert.equal((database.prepare("SELECT status FROM device_preparations").get() as { status: string }).status, "not_ready");
    assert.equal((database.prepare("SELECT device_id FROM operations").get() as { device_id: string }).device_id, "serial-2");
    assert.equal((database.prepare("SELECT device_id FROM appium_sessions").get() as { device_id: string }).device_id, "serial-2");
    assert.equal((database.prepare("SELECT device_id FROM device_retirements").get() as { device_id: string }).device_id, "serial-2");
  });
});

test("allows only one worker and one owner per device lock", async () => {
  await withDatabase(async (database) => {
    upsertDeviceProfile(database, {
      hardwareId: HARDWARE_ID,
      deviceId: SERIAL,
      alias: "Equipo 1",
      physicalOrder: 1,
      systemPort: 8200,
    });
    const first = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: SERIAL },
      deviceId: SERIAL,
    }).operation;
    const second = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: SERIAL, second: true },
      deviceId: SERIAL,
    }).operation;

    assert.equal(claimRuntimeOwnership(database, "worker-1", 1, 100, 50), true);
    assert.equal(claimRuntimeOwnership(database, "worker-2", 2, 120, 50), false);
    assert.equal(claimRuntimeOwnership(database, "worker-2", 2, 150, 50), true);
    assert.throws(() => assertRuntimeOwnership(database, "worker-1", 151), /perdio su lease/);
    assert.equal(releaseRuntimeOwnership(database, "worker-1"), false);
    assert.equal(releaseRuntimeOwnership(database, "worker-2"), true);

    assert.equal(acquireDeviceLock(database, SERIAL, first.id, "worker-1", 100, 50), true);
    assert.equal(acquireDeviceLock(database, SERIAL, second.id, "worker-2", 200, 50), false);
    assert.equal(releaseDeviceLock(database, SERIAL, first.id, "worker-2"), false);
    assert.equal(releaseDeviceLock(database, SERIAL, first.id, "worker-1"), true);
  });
});
