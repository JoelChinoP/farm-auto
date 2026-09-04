import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { AdbClient } from "./lib/adb.ts";
import { AppiumClient } from "./lib/appium-client.ts";
import { appConfig } from "./lib/config.ts";
import { getDatabase } from "./lib/database.ts";
import {
  claimRuntimeOwnership,
  assertRuntimeOwnership,
  getOwnedAppiumSessionIds,
  prepareDevice,
  refreshDeviceInventory,
  recoverOwnedSessions,
  releaseRuntimeOwnership,
} from "./lib/device-runtime.ts";
import { claimNextJob, completeJob, failJob, getJob, recoverStaleJobs } from "./lib/queue.ts";

type WorkerDependencies = {
  database?: Database.Database;
  adb?: AdbClient;
  appium?: AppiumClient;
  owner?: string;
  signal?: AbortSignal;
  once?: boolean;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export async function runWorker(options: WorkerDependencies = {}) {
  const database = options.database ?? getDatabase();
  const owner = options.owner ?? `worker-${randomUUID()}`;
  const adb = options.adb ?? new AdbClient({ database, timeoutMs: appConfig.adbTimeoutMs });
  const appium = options.appium ?? new AppiumClient({
    baseUrl: appConfig.appiumUrl,
    timeoutMs: appConfig.appiumTimeoutMs,
    ownedSessionIds: getOwnedAppiumSessionIds(database),
  });
  const sleep = options.sleep ?? (async (milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  if (!claimRuntimeOwnership(database, owner, process.pid, Date.now(), appConfig.workerLeaseMs)) {
    throw new Error("Otro worker de Farm Appium mantiene el lease activo.");
  }
  const leaseController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, leaseController.signal])
    : leaseController.signal;
  const heartbeat = setInterval(() => {
    try {
      if (!claimRuntimeOwnership(database, owner, process.pid, Date.now(), appConfig.workerLeaseMs)) {
        leaseController.abort(new Error("El worker perdio su lease."));
      }
    } catch (error) {
      leaseController.abort(error);
    }
  }, Math.max(250, Math.floor(appConfig.workerLeaseMs / 3)));
  heartbeat.unref();

  try {
    await recoverOwnedSessions(
      database,
      owner,
      adb,
      appium,
      appConfig.cleanupTimeoutMs,
      appConfig.artifactsPath,
      leaseController.signal,
    );
    signal.throwIfAborted();
    try {
      await refreshDeviceInventory(database, adb, signal, owner);
    } catch {
      // Each preparation persists its own concrete ADB failure.
    }
    signal.throwIfAborted();
    assertRuntimeOwnership(database, owner);
    recoverStaleJobs(database, owner);
    let nextInventoryAt = Date.now() + 5_000;

    do {
      signal.throwIfAborted();
      if (!claimRuntimeOwnership(database, owner, process.pid, Date.now(), appConfig.workerLeaseMs)) {
        throw new Error("El worker perdio su lease.");
      }
      if (Date.now() >= nextInventoryAt) {
        try {
          await refreshDeviceInventory(database, adb, signal, owner);
        } catch {
          // Inventory is best-effort; preparation records concrete device failures.
        }
        signal.throwIfAborted();
        nextInventoryAt = Date.now() + 5_000;
      }
      const job = claimNextJob(database, owner);
      if (!job) {
        if (options.once) break;
        await sleep(appConfig.workerPollMs, signal);
        continue;
      }

      const jobController = new AbortController();
      const jobSignal = AbortSignal.any([signal, jobController.signal]);
      const cancellationPoll = setInterval(() => {
        if (getJob(database, job.id)?.cancellationRequestedAt !== null) {
          jobController.abort(new Error("Cancelacion solicitada"));
        }
      }, 100);
      cancellationPoll.unref();
      try {
        if (job.kind !== "device.prepare" || !job.operationId) {
          throw new Error(`El worker de Fase 2 no admite el job ${job.kind}.`);
        }
        const result = await prepareDevice(database, job.operationId, owner, {
          adb,
          appium,
          signal: jobSignal,
          leaseSignal: leaseController.signal,
        });
        completeJob(database, job.id, owner, result);
      } catch (error) {
        try {
          assertRuntimeOwnership(database, owner);
          failJob(database, job.id, owner, error);
        } catch (leaseError) {
          if (!leaseController.signal.aborted) throw leaseError;
        }
      } finally {
        clearInterval(cancellationPoll);
      }
    } while (!options.once);
  } finally {
    clearInterval(heartbeat);
    releaseRuntimeOwnership(database, owner);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Worker detenido"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  runWorker({ signal: controller.signal }).catch((error: unknown) => {
    if (!controller.signal.aborted) console.error(error);
    process.exitCode = controller.signal.aborted ? 0 : 1;
  });
}
