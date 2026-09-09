import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { AdbClient, calculateHardwareId } from "../src/lib/adb.ts";
import type { AdbExecutor } from "../src/lib/adb.ts";
import { AppiumClient } from "../src/lib/appium-client.ts";
import type { AppiumFetch } from "../src/lib/appium-client.ts";
import { openDatabase } from "../src/lib/database.ts";
import { upsertDeviceProfile } from "../src/lib/device-runtime.ts";
import { createOperation, getOperation } from "../src/lib/operations.ts";
import { enqueueJob } from "../src/lib/queue.ts";
import { runWorker, runWorkerProcess } from "../src/worker.ts";

const browser = {
  extract: async () => { throw new Error("No hay extracciones pendientes."); },
  close: async () => undefined,
};

async function eventually(check: () => void, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw lastError instanceof Error ? lastError : new Error("La condicion no se cumplio a tiempo.");
}

test("the worker drains its background inventory before releasing ownership", async () => {
  const database = openDatabase(":memory:");
  let releaseInventory!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const adb = {
    listDevices: async () => {
      markStarted();
      await new Promise<void>((resolve) => { releaseInventory = resolve; });
      return [];
    },
  } as unknown as AdbClient;

  try {
    let settled = false;
    const running = runWorker({
      database,
      adb,
      appium: {} as AppiumClient,
      owner: "inventory-drain-worker",
      once: true,
      facebookBrowser: browser,
    }).then(() => { settled = true; });
    await started;
    await delay(0);
    assert.equal(settled, false);

    releaseInventory();
    await running;
    assert.equal(settled, true);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM runtime_ownership").get() as { total: number }).total, 0);
  } finally {
    database.close();
  }
});

test("the worker process removes shutdown listeners after a clean stop", async () => {
  const database = openDatabase(":memory:");
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  try {
    const exitCode = await runWorkerProcess({
      database,
      adb: { listDevices: async () => [] } as unknown as AdbClient,
      appium: {} as AppiumClient,
      owner: "clean-stop-worker",
      once: true,
      facebookBrowser: browser,
    });
    assert.equal(exitCode, 0);
    assert.equal(process.listenerCount("SIGINT"), sigintListeners);
    assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
  } finally {
    database.close();
  }
});

test("the worker heartbeat keeps the daemon alive until controlled shutdown", async () => {
  const database = openDatabase(":memory:");
  const originalSetInterval = globalThis.setInterval;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    heartbeat = originalSetInterval(...args);
    return heartbeat;
  }) as typeof setInterval;
  try {
    await runWorker({
      database,
      adb: { listDevices: async () => [] } as unknown as AdbClient,
      appium: {} as AppiumClient,
      owner: "heartbeat-worker",
      once: true,
      facebookBrowser: browser,
    });
    assert.equal(heartbeat?.hasRef(), true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    database.close();
  }
});

test("the worker releases ownership before waiting for browser shutdown", async () => {
  const database = openDatabase(":memory:");
  const controller = new AbortController();
  let closeStarted!: () => void;
  let finishClose!: () => void;
  const closing = new Promise<void>((resolve) => { closeStarted = resolve; });
  const closeBlocked = new Promise<void>((resolve) => { finishClose = resolve; });
  try {
    const running = runWorker({
      database,
      adb: { listDevices: async () => [] } as unknown as AdbClient,
      appium: {} as AppiumClient,
      owner: "browser-close-worker",
      signal: controller.signal,
      facebookBrowser: {
        ...browser,
        close: async () => {
          closeStarted();
          await closeBlocked;
        },
      },
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    await eventually(() => {
      assert.equal((database.prepare("SELECT COUNT(*) AS total FROM runtime_ownership").get() as { total: number }).total, 1);
    });

    controller.abort();
    await closing;
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM runtime_ownership").get() as { total: number }).total, 0);
    finishClose();
    await running;
  } finally {
    database.close();
  }
});

test("the dispatcher keeps claiming new jobs while another device is stuck", async () => {
  const database = openDatabase(":memory:");
  const controller = new AbortController();
  let releaseA!: () => void;
  let aCreating!: () => void;
  const aBlocked = new Promise<void>((resolve) => { releaseA = resolve; });
  const aStarted = new Promise<void>((resolve) => { aCreating = resolve; });

  try {
    for (const [serial, hardware, port] of [["serial-A", "physical-A", 8200], ["serial-B", "physical-B", 8201]] as const) {
      upsertDeviceProfile(database, {
        hardwareId: calculateHardwareId(hardware, `android-${hardware}`),
        deviceId: serial,
        alias: serial,
        physicalOrder: port - 8199,
        systemPort: port,
      });
    }
    const operationA = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: "serial-A" },
      deviceId: "serial-A",
    }).operation;
    const operationB = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: "serial-B" },
      deviceId: "serial-B",
    }).operation;
    enqueueJob(database, "device.prepare", { deviceId: "serial-A" }, { operationId: operationA.id, maxAttempts: 1 });

    const executor: AdbExecutor = async (_file, args) => {
      const command = args.join(" ");
      if (args[0] === "devices") {
        return { stdout: "List of devices attached\nserial-A device model:SM_A\nserial-B device model:SM_B\n", stderr: "" };
      }
      for (const [serial, hardware] of [["serial-A", "physical-A"], ["serial-B", "physical-B"]] as const) {
        if (command === `-s ${serial} shell getprop ro.serialno`) return { stdout: `${hardware}\n`, stderr: "" };
        if (command === `-s ${serial} shell settings get secure android_id`) return { stdout: `android-${hardware}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const adb = new AdbClient({ database, executor });
    const fetch: AppiumFetch = async (input, init) => {
      const body = String(init?.body ?? "");
      if (body.includes("serial-A")) {
        aCreating();
        await aBlocked;
      }
      const url = String(input);
      if (url.endsWith("/session") && init?.method === "POST") {
        return Response.json({
          value: { sessionId: body.includes("serial-A") ? "session-a" : "session-b", capabilities: { platformName: "Android" } },
        });
      }
      if (url.endsWith("/source")) return Response.json({ value: "<hierarchy rotation=\"0\"><node /></hierarchy>" });
      return Response.json({ value: null });
    };
    const appium = new AppiumClient({ baseUrl: "http://127.0.0.1:4723", fetch });

    const running = runWorker({
      database,
      adb,
      appium,
      owner: "dispatcher-test",
      deviceConcurrency: 2,
      facebookBrowser: browser,
      signal: controller.signal,
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });

    await aStarted;
    enqueueJob(database, "device.prepare", { deviceId: "serial-B" }, { operationId: operationB.id, maxAttempts: 1 });

    await eventually(() => {
      assert.equal(getOperation(database, operationB.id)?.status, "succeeded");
      assert.equal(getOperation(database, operationA.id)?.status, "running");
    });

    releaseA();
    await eventually(() => {
      assert.equal(getOperation(database, operationA.id)?.status, "succeeded");
    });

    controller.abort();
    await running;
  } finally {
    database.close();
  }
});
