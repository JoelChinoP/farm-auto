import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { openDatabase } from "../src/lib/database.ts";
import { claimRuntimeOwnership } from "../src/lib/device-runtime.ts";
import {
  completeOperation,
  createOperation,
  getOperation,
  markOperationOutcomeUnknown,
} from "../src/lib/operations.ts";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  getQueueStats,
  markJobEffectPhase,
  recoverStaleJobs,
  requestJobCancellation,
} from "../src/lib/queue.ts";

async function withDatabase(run: (filename: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "farm-appium-"));
  const filename = join(directory, "test.sqlite");
  try {
    run(filename);
  } finally {
    try {
      const cleanup = new Database(filename);
      cleanup.pragma("journal_mode = DELETE");
      cleanup.close();
    } catch {
      // Preserve the test failure if its connection could not be closed.
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("claims a job once and completes it with the owning worker", async () => {
  await withDatabase((filename) => {
    const firstConnection = openDatabase(filename);
    const secondConnection = openDatabase(filename);
    const queued = enqueueJob(firstConnection, "device.prepare", { deviceId: "serial-1" });
    claimRuntimeOwnership(firstConnection, "worker-1", 1, Date.now(), 60_000);

    const claimed = claimNextJob<{ deviceId: string }>(firstConnection, "worker-1");
    assert.equal(claimed?.id, queued.id);
    assert.equal(claimed.payload.deviceId, "serial-1");
    assert.equal(claimNextJob(secondConnection, "worker-1"), null);

    const completed = completeJob(firstConnection, queued.id, "worker-1", { ready: true });
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.result, { ready: true });
    assert.deepEqual(getQueueStats(firstConnection), {
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      outcome_unknown: 0,
    });

    secondConnection.close();
    firstConnection.close();
  });
});

test("retries until maxAttempts and then fails", async () => {
  await withDatabase((filename) => {
    const database = openDatabase(filename);
    const queued = enqueueJob(database, "device.prepare", {}, { maxAttempts: 2 });
    claimRuntimeOwnership(database, "worker", 1, Date.now(), 60_000);

    claimNextJob(database, "worker");
    assert.equal(failJob(database, queued.id, "worker", "first").status, "pending");
    claimNextJob(database, "worker");
    assert.equal(failJob(database, queued.id, "worker", "second").status, "failed");

    database.close();
  });
});

test("recovers stale jobs without duplicating completed work", async () => {
  await withDatabase((filename) => {
    const database = openDatabase(filename);
    const queued = enqueueJob(database, "device.prepare", {}, { availableAt: 0 });
    const now = Date.now();
    claimRuntimeOwnership(database, "dead-worker", 1, now, 60_000);
    claimNextJob(database, "dead-worker", now);
    claimRuntimeOwnership(database, "new-worker", 2, now + 60_000, 60_000);

    assert.throws(() => completeJob(database, queued.id, "dead-worker", {}), /lease del runtime/);
    assert.equal(recoverStaleJobs(database, "new-worker", now + 60_001), 1);
    assert.equal(claimNextJob(database, "new-worker", now + 60_001)?.attempts, 2);

    database.close();
  });
});

test("never retries a stale job after a possible public effect", async () => {
  await withDatabase((filename) => {
    const database = openDatabase(filename);
    const operation = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: randomUUID(),
      request: { controlled: true },
    }).operation;
    const queued = enqueueJob(database, "assignment.execute", {}, {
      operationId: operation.id,
      effectPhase: "before_effect",
      availableAt: 0,
    });
    const now = Date.now();
    claimRuntimeOwnership(database, "dead-worker", 1, now, 60_000);
    claimNextJob(database, "dead-worker", now);
    markJobEffectPhase(database, queued.id, "dead-worker", "effect_possible");
    claimRuntimeOwnership(database, "new-worker", 2, now + 60_000, 60_000);

    assert.equal(recoverStaleJobs(database, "new-worker", now + 60_001), 1);
    assert.equal(getJob(database, queued.id)?.status, "outcome_unknown");
    assert.equal(getOperation(database, operation.id)?.status, "outcome_unknown");
    assert.equal(claimNextJob(database, "new-worker", now + 60_001), null);
    assert.throws(() => enqueueJob(database, "assignment.execute", {}, {
      effectPhase: "effect_possible",
    }), /no puede comenzar/);

    database.close();
  });
});

test("cancellation is idempotent and prevents pending claims", async () => {
  await withDatabase((filename) => {
    const database = openDatabase(filename);
    const operation = createOperation(database, {
      kind: "campaign.cancel",
      idempotencyKey: randomUUID(),
      request: { campaignId: "campaign-1" },
    }).operation;
    const queued = enqueueJob(database, "campaign.cancel", {}, { operationId: operation.id });
    claimRuntimeOwnership(database, "worker", 1, Date.now(), 60_000);

    assert.equal(requestJobCancellation(database, queued.id, 100).status, "cancelled");
    assert.equal(requestJobCancellation(database, queued.id, 200).completedAt, 100);
    assert.equal(getOperation(database, operation.id)?.status, "cancelled");
    assert.equal(claimNextJob(database, "worker", 300), null);

    database.close();
  });
});

test("a running cancellation cannot complete as succeeded before an effect", async () => {
  await withDatabase((filename) => {
    const database = openDatabase(filename);
    const operation = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: "safe-device" },
    }).operation;
    const queued = enqueueJob(database, "device.prepare", {}, {
      operationId: operation.id,
      availableAt: 0,
    });
    claimRuntimeOwnership(database, "worker", 1, Date.now(), 60_000);
    claimNextJob(database, "worker");
    assert.equal(requestJobCancellation(database, queued.id, 110).status, "running");
    assert.equal(completeJob(database, queued.id, "worker", { ready: true }).status, "cancelled");
    assert.equal(getOperation(database, operation.id)?.status, "cancelled");
    database.close();
  });
});

test("enforces one job per operation and requires public-effect confirmation", async () => {
  await withDatabase((filename) => {
    const database = openDatabase(filename);
    const operation = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: randomUUID(),
      request: { controlled: true },
    }).operation;
    const queued = enqueueJob(database, "assignment.execute", { controlled: true }, {
      operationId: operation.id,
      effectPhase: "before_effect",
      availableAt: 0,
    });
    claimRuntimeOwnership(database, "worker", 1, Date.now(), 60_000);
    assert.equal(enqueueJob(database, "assignment.execute", { controlled: true }, {
      operationId: operation.id,
      effectPhase: "before_effect",
      availableAt: 0,
    }).id, queued.id);
    assert.throws(() => enqueueJob(database, "assignment.execute", { controlled: false }, {
      operationId: operation.id,
    }), /clave idempotente/);

    markOperationOutcomeUnknown(database, operation.id, "requiere revision");
    assert.equal(claimNextJob(database, "worker"), null);

    const publicOperation = createOperation(database, {
      kind: "assignment.execute",
      idempotencyKey: randomUUID(),
      request: { publicEffect: true },
    }).operation;
    const publicJob = enqueueJob(database, "assignment.execute", {}, {
      operationId: publicOperation.id,
      effectPhase: "before_effect",
      availableAt: 0,
    });
    claimNextJob(database, "worker");
    markJobEffectPhase(database, publicJob.id, "worker", "effect_possible");
    assert.throws(() => completeJob(database, publicJob.id, "worker", {}), /confirmarse/);
    assert.throws(() => completeOperation(database, publicOperation.id, {}), /confirmarse/);
    markJobEffectPhase(database, publicJob.id, "worker", "effect_confirmed");
    assert.equal(completeJob(database, publicJob.id, "worker", {}).status, "succeeded");
    assert.equal(enqueueJob(database, "assignment.execute", {}, {
      operationId: publicOperation.id,
      effectPhase: "before_effect",
      availableAt: 0,
    }).id, publicJob.id);

    database.close();
  });
});
