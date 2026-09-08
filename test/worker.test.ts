import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { AdbClient } from "../src/lib/adb.ts";
import type { AppiumClient } from "../src/lib/appium-client.ts";
import { openDatabase } from "../src/lib/database.ts";
import { runWorker, runWorkerProcess } from "../src/worker.ts";

const browser = {
  extract: async () => { throw new Error("No hay extracciones pendientes."); },
  close: async () => undefined,
};

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
