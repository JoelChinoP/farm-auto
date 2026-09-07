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
  recoverRequestedUncertainSessions,
  releaseRuntimeOwnership,
} from "./lib/device-runtime.ts";
import { FacebookBrowser } from "./lib/facebook-browser.ts";
import {
  executeFacebookAssignment,
  recoverFacebookExecutions,
} from "./lib/facebook-mobile.ts";
import type { FacebookMobileDriver } from "./lib/facebook-mobile.ts";
import {
  createFacebookCampaign,
  extractFacebookPost,
  generateFacebookComments,
} from "./lib/facebook.ts";
import type { DeepSeekFetch, FacebookCampaignRequest, FacebookExtractor } from "./lib/facebook.ts";
import { claimNextJob, completeJob, failJob, getJob, recoverStaleJobs } from "./lib/queue.ts";
import { executeTikTokAssignment, recoverTikTokExecutions } from "./lib/tiktok-mobile.ts";
import type { TikTokLiveMobileDriver, TikTokPostMobileDriver } from "./lib/tiktok-mobile.ts";
import {
  createTikTokCampaign,
  generateTikTokComment,
  resolveTikTokPostUrl,
  validateTikTokCampaignRequest,
} from "./lib/tiktok.ts";

type WorkerDependencies = {
  database?: Database.Database;
  adb?: AdbClient;
  appium?: AppiumClient;
  owner?: string;
  signal?: AbortSignal;
  once?: boolean;
  deviceConcurrency?: number;
  aiConcurrency?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  facebookBrowser?: FacebookExtractor & { close?: () => Promise<void> };
  deepSeekFetch?: DeepSeekFetch;
  facebookMobile?: FacebookMobileDriver;
  tiktokPostMobile?: TikTokPostMobileDriver;
  tiktokLiveMobile?: TikTokLiveMobileDriver;
  tiktokUrlFetch?: typeof fetch;
};

function campaignPlatform(database: Database.Database, campaignId: string | null) {
  if (!campaignId) return null;
  return (database.prepare("SELECT platform FROM campaigns WHERE id = ?").get(campaignId) as { platform: "facebook" | "tiktok" } | undefined)?.platform ?? null;
}

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
  const facebookBrowser = options.facebookBrowser ?? new FacebookBrowser(database, owner);
  const deviceConcurrency = options.deviceConcurrency ?? appConfig.workerDeviceConcurrency;
  const aiConcurrency = options.aiConcurrency ?? appConfig.deepSeekConcurrency;
  if (!Number.isInteger(deviceConcurrency) || deviceConcurrency < 1 || deviceConcurrency > 100) {
    throw new TypeError("deviceConcurrency debe ser un entero entre 1 y 100.");
  }
  if (!Number.isInteger(aiConcurrency) || aiConcurrency < 1 || aiConcurrency > 4) {
    throw new TypeError("aiConcurrency debe ser un entero entre 1 y 4.");
  }
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
    let inventoryInFlight: Promise<unknown> | null = null;
    const kickInventory = () => {
      if (inventoryInFlight) return;
      inventoryInFlight = refreshDeviceInventory(database, adb, signal, owner)
        .catch(() => undefined)
        .finally(() => {
          inventoryInFlight = null;
        });
    };
    kickInventory();
    signal.throwIfAborted();
    assertRuntimeOwnership(database, owner);
    recoverStaleJobs(database, owner);
    recoverFacebookExecutions(database, owner);
    recoverTikTokExecutions(database, owner);
    let nextInventoryAt = Date.now() + 5_000;
    const activeDeviceJobs = new Set<Promise<void>>();
    const activeAiJobs = new Set<Promise<void>>();

    const runJob = async (job: NonNullable<ReturnType<typeof claimNextJob>>) => {
      const jobController = new AbortController();
      const jobSignal = AbortSignal.any([signal, jobController.signal]);
      const cancellationPoll = setInterval(() => {
        if (getJob(database, job.id)?.cancellationRequestedAt !== null) {
          jobController.abort(new Error("Cancelacion solicitada"));
        }
      }, 100);
      cancellationPoll.unref();
      try {
        if (!job.operationId) throw new Error(`El job ${job.kind} no tiene una operacion asociada.`);
        let result: unknown;
        if (job.kind === "device.prepare") {
          result = await prepareDevice(database, job.operationId, owner, {
            adb,
            appium,
            signal: jobSignal,
            leaseSignal: leaseController.signal,
          });
        } else if (job.kind === "campaign.create") {
          if ((job.payload as { platform?: unknown }).platform === "tiktok") {
            const request = validateTikTokCampaignRequest(job.payload);
            const finalUrls = job.campaignId ? undefined : await Promise.all(
              request.urls.map((url) => resolveTikTokPostUrl(url, options.tiktokUrlFetch, jobSignal)),
            );
            jobSignal.throwIfAborted();
            result = createTikTokCampaign(database, job.operationId, request, finalUrls);
          } else {
            result = createFacebookCampaign(database, job.operationId, job.payload as FacebookCampaignRequest);
          }
        } else if (job.kind === "post.extract") {
          result = await extractFacebookPost(database, job.operationId, facebookBrowser, jobSignal);
        } else if (job.kind === "comments.generate") {
          result = campaignPlatform(database, job.campaignId) === "tiktok"
            ? await generateTikTokComment(database, job.operationId, options.deepSeekFetch, jobSignal)
            : await generateFacebookComments(database, job.operationId, options.deepSeekFetch, jobSignal);
        } else if (job.kind === "assignment.execute") {
          result = campaignPlatform(database, job.campaignId) === "tiktok"
            ? await executeTikTokAssignment(database, job.operationId, owner, {
              adb,
              appium,
              postMobile: options.tiktokPostMobile,
              liveMobile: options.tiktokLiveMobile,
              signal: jobSignal,
              leaseSignal: leaseController.signal,
            })
            : await executeFacebookAssignment(database, job.operationId, owner, {
              adb,
              appium,
              mobile: options.facebookMobile,
              signal: jobSignal,
              leaseSignal: leaseController.signal,
            });
        } else {
          throw new Error(`El worker no admite el job ${job.kind}.`);
        }
        completeJob(database, job.id, owner, result);
      } catch (error) {
        try {
          assertRuntimeOwnership(database, owner);
          const current = getJob(database, job.id);
          const interrupted = signal.aborted
            && current?.cancellationRequestedAt === null
            && ["none", "before_effect"].includes(current.effectPhase);
          if (!interrupted) failJob(database, job.id, owner, error, 0, job.kind === "device.prepare");
        } catch (leaseError) {
          if (!leaseController.signal.aborted) throw leaseError;
        }
      } finally {
        clearInterval(cancellationPoll);
      }
    };

    try {
      do {
        signal.throwIfAborted();
        if (!claimRuntimeOwnership(database, owner, process.pid, Date.now(), appConfig.workerLeaseMs)) {
          throw new Error("El worker perdio su lease.");
        }
        if (Date.now() >= nextInventoryAt) {
          kickInventory();
          nextInventoryAt = Date.now() + 5_000;
        }
        await recoverRequestedUncertainSessions(
          database,
          owner,
          adb,
          appium,
          appConfig.cleanupTimeoutMs,
          appConfig.artifactsPath,
          leaseController.signal,
        );
        signal.throwIfAborted();
        const excludeKinds = [
          ...(activeDeviceJobs.size >= deviceConcurrency ? ["assignment.execute"] : []),
          ...(activeAiJobs.size >= aiConcurrency ? ["comments.generate"] : []),
        ];
        const job = claimNextJob(database, owner, Date.now(), { excludeKinds });
        if (!job) {
          const activeJobs = [...activeDeviceJobs, ...activeAiJobs];
          if (activeJobs.length) {
            await Promise.race(activeJobs);
            continue;
          }
          if (options.once) break;
          await sleep(appConfig.workerPollMs, signal);
          continue;
        }
        if (["assignment.execute", "comments.generate"].includes(job.kind) && !options.once) {
          const running = runJob(job);
          const activeJobs = job.kind === "assignment.execute" ? activeDeviceJobs : activeAiJobs;
          activeJobs.add(running);
          void running.then(
            () => activeJobs.delete(running),
            () => activeJobs.delete(running),
          );
        } else {
          await runJob(job);
        }
      } while (!options.once);
    } finally {
      await Promise.allSettled([...activeDeviceJobs, ...activeAiJobs]);
    }
  } finally {
    clearInterval(heartbeat);
    try {
      await facebookBrowser.close?.();
    } finally {
      releaseRuntimeOwnership(database, owner);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Worker detenido"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  runWorker({ signal: controller.signal, once: process.argv.includes("--once") }).catch((error: unknown) => {
    if (!controller.signal.aborted) console.error(error);
    process.exitCode = controller.signal.aborted ? 0 : 1;
  });
}
