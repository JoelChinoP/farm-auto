import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../src/lib/database.ts";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getQueueStats,
  recoverStaleJobs,
} from "../src/lib/queue.ts";

function withDatabase(run: (filename: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "farm-appium-"));
  const filename = join(directory, "test.sqlite");
  try {
    run(filename);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("claims a job once and completes it with the owning worker", () => {
  withDatabase((filename) => {
    const firstConnection = openDatabase(filename);
    const secondConnection = openDatabase(filename);
    const queued = enqueueJob(firstConnection, "device.prepare", { deviceId: "serial-1" });

    const claimed = claimNextJob<{ deviceId: string }>(firstConnection, "worker-1");
    assert.equal(claimed?.id, queued.id);
    assert.equal(claimed.payload.deviceId, "serial-1");
    assert.equal(claimNextJob(secondConnection, "worker-2"), null);

    const completed = completeJob(firstConnection, queued.id, "worker-1", { ready: true });
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.result, { ready: true });
    assert.deepEqual(getQueueStats(firstConnection), {
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
    });

    secondConnection.close();
    firstConnection.close();
  });
});

test("retries until maxAttempts and then fails", () => {
  withDatabase((filename) => {
    const database = openDatabase(filename);
    const queued = enqueueJob(database, "device.prepare", {}, { maxAttempts: 2 });

    claimNextJob(database, "worker");
    assert.equal(failJob(database, queued.id, "worker", "first").status, "pending");
    claimNextJob(database, "worker");
    assert.equal(failJob(database, queued.id, "worker", "second").status, "failed");

    database.close();
  });
});

test("recovers stale jobs without duplicating completed work", () => {
  withDatabase((filename) => {
    const database = openDatabase(filename);
    enqueueJob(database, "device.prepare", {}, { availableAt: 0 });
    claimNextJob(database, "dead-worker", 100);

    assert.equal(recoverStaleJobs(database, 100, 200), 1);
    assert.equal(claimNextJob(database, "new-worker", 200)?.attempts, 2);

    database.close();
  });
});
