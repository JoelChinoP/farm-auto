import assert from "node:assert/strict";
import test from "node:test";

import {
  AsyncSemaphore,
  mapWithConcurrency,
  retryOperation,
} from "../src/lib/generation-utils.ts";

test("limits concurrent generation work", async () => {
  const semaphore = new AsyncSemaphore(4);
  let active = 0;
  let maximum = 0;
  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      semaphore.run(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, index % 3));
        active--;
      }),
    ),
  );
  assert.equal(maximum, 4);
});

test("retries transient generation failures with controlled delays", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await retryOperation(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "generated";
    },
    {
      attempts: 3,
      shouldRetry: () => true,
      delayMilliseconds: (_error, attempt) => attempt * 100,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
  );
  assert.equal(result, "generated");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("processes large batches without exceeding the worker limit", async () => {
  let active = 0;
  let maximum = 0;
  const completed: number[] = [];
  await mapWithConcurrency(
    Array.from({ length: 50 }, (_, index) => index),
    4,
    async (item) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, item % 2));
      completed.push(item);
      active--;
    },
  );
  assert.equal(maximum, 4);
  assert.equal(new Set(completed).size, 50);
});

test("waits for every generation worker before reporting a failure", async () => {
  let slowWorkerFinished = false;
  await assert.rejects(
    mapWithConcurrency(["fails", "slow"], 2, async (item) => {
      if (item === "fails") throw new Error("database failure");
      await new Promise((resolve) => setTimeout(resolve, 10));
      slowWorkerFinished = true;
    }),
  );
  assert.equal(slowWorkerFinished, true);
});
