import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type Database from "better-sqlite3";

import type { AdbClient } from "../src/lib/adb.ts";
import type { AppiumClient } from "../src/lib/appium-client.ts";
import { openDatabase } from "../src/lib/database.ts";
import { CURRENT_SETUP_REVISION } from "../src/lib/device-runtime.ts";
import { createOperation } from "../src/lib/operations.ts";
import { enqueueJob } from "../src/lib/queue.ts";
import {
  assertTikTokDeviceEligible,
  createTikTokCampaign,
  editTikTokPostContext,
  generateTikTokComment,
  getTikTokCampaignSnapshot,
  normalizeTikTokLiveUrl,
  normalizeTikTokUrl,
  readTikTokConfig,
  requestTikTokCommentGeneration,
  requestTikTokLiveExecution,
  requestTikTokPostExecution,
  TIKTOK_APP_PACKAGE,
  TikTokError,
  type TikTokConfig,
  validateTikTokCampaignRequest,
  validateTikTokLiveRequest,
} from "../src/lib/tiktok.ts";
import { runWorker } from "../src/worker.ts";

const DEVICE_ID = "tiktok-device-1";
const ACCOUNT = "@controlled.qa";

function config(overrides: Partial<TikTokConfig> = {}): TikTokConfig {
  return {
    controlledAccount: ACCOUNT,
    accountResourceId: "com.zhiliaoapp.musically:id/account",
    postContainerResourceId: "com.zhiliaoapp.musically:id/post",
    postUrlResourceId: "com.zhiliaoapp.musically:id/post_url",
    commentComposerResourceId: "com.zhiliaoapp.musically:id/comment_composer",
    commentEditorResourceId: "com.zhiliaoapp.musically:id/comment_editor",
    commentSubmitResourceId: "com.zhiliaoapp.musically:id/comment_submit",
    commentResultContainerResourceId: "com.zhiliaoapp.musically:id/comment_results",
    liveContainerResourceId: "com.zhiliaoapp.musically:id/live",
    liveUrlResourceId: "com.zhiliaoapp.musically:id/live_url",
    likeActiveLabels: ["Unlike"],
    likeInactiveLabels: ["Like"],
    commentLabels: ["Comments"],
    uiTimeoutMs: 50,
    publicEffectsEnabled: true,
    liveEffectsEnabled: true,
    liveCalibration: { deviceId: DEVICE_ID, x: 540, y: 960 },
    ...overrides,
  };
}

function addEligibleDevice(database: Database.Database) {
  const hardwareId = "a".repeat(64);
  database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(hardwareId, DEVICE_ID, "TikTok QA", 1, 8200, 1, 1);
  database.prepare(`
    INSERT INTO device_observations (device_id, connection, hardware_id, packages_json, observed_at)
    VALUES (?, 'connected', ?, ?, 1)
  `).run(DEVICE_ID, hardwareId, JSON.stringify([TIKTOK_APP_PACKAGE]));
  const operation = createOperation(database, {
    kind: "device.prepare",
    idempotencyKey: randomUUID(),
    request: { deviceId: DEVICE_ID },
    deviceId: DEVICE_ID,
  }).operation;
  database.prepare(`
    INSERT INTO device_preparations (
      id, device_id, operation_id, status, step, created_at, updated_at, completed_at, setup_revision
    ) VALUES (?, ?, ?, 'ready', 'Listo', 1, 1, 1, ?)
  `).run(randomUUID(), DEVICE_ID, operation.id, CURRENT_SETUP_REVISION);
}

function campaignRequest(comment = true) {
  return {
    platform: "tiktok" as const,
    urls: ["https://www.tiktok.com/@controlled/video/7410000000000000000"],
    deviceIds: [DEVICE_ID],
    actions: { like: true, comment },
    distribution: comment ? [{ intention: "Afinidad", tone: "Cercano" as const, count: 1 as const }] : [],
  };
}

function createCampaign(database: Database.Database, comment = true) {
  const request = campaignRequest(comment);
  const operation = createOperation(database, {
    kind: "campaign.create",
    idempotencyKey: randomUUID(),
    request,
  }).operation;
  enqueueJob(database, "campaign.create", request, { operationId: operation.id, maxAttempts: 2 });
  return createTikTokCampaign(database, operation.id, request)!;
}

test("accepts only safe TikTok domains and strict Live URLs", () => {
  assert.equal(readTikTokConfig({ NODE_ENV: "test" }).publicEffectsEnabled, false);
  assert.equal(readTikTokConfig({ NODE_ENV: "test" }).liveEffectsEnabled, false);
  assert.throws(() => readTikTokConfig({ NODE_ENV: "test", TIKTOK_LIVE_CALIBRATED_DEVICE_ID: DEVICE_ID }), /requiere dispositivo, X e Y/);
  assert.deepEqual(normalizeTikTokUrl("https://m.tiktok.com/@qa/video/1?utm_source=test#comments"), {
    sourceUrl: "https://m.tiktok.com/@qa/video/1?utm_source=test",
    normalizedUrl: "https://m.tiktok.com/@qa/video/1",
  });
  assert.equal(normalizeTikTokLiveUrl("https://www.tiktok.com/@qa/live/").normalizedUrl, "https://www.tiktok.com/@qa/live");
  for (const invalid of [
    "http://tiktok.com/@qa/video/1",
    "https://user@tiktok.com/@qa/video/1",
    "https://tiktok.com:444/@qa/video/1",
    "https://tiktok.com.example.test/@qa/video/1",
    "https://example.com/?next=tiktok.com",
  ]) assert.throws(() => normalizeTikTokUrl(invalid), TikTokError);
  assert.throws(() => normalizeTikTokLiveUrl("https://www.tiktok.com/@qa/video/1"), /Live/);
  assert.throws(() => validateTikTokCampaignRequest({ ...campaignRequest(), urls: ["https://www.tiktok.com/@qa/live"] }), /no admite una URL Live/);
});

test("enforces one post by one device and prepared TikTok package eligibility", () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    assert.doesNotThrow(() => assertTikTokDeviceEligible(database, DEVICE_ID));
    const validated = validateTikTokCampaignRequest(campaignRequest());
    assert.deepEqual(validated.deviceIds, [DEVICE_ID]);
    assert.throws(() => validateTikTokCampaignRequest({ ...campaignRequest(), urls: [
      campaignRequest().urls[0],
      "https://www.tiktok.com/@controlled/video/2",
    ] }), (error) => error instanceof TikTokError && error.code === "TIKTOK_REQUIRES_1X1");
    assert.throws(() => validateTikTokCampaignRequest({ ...campaignRequest(), deviceIds: [DEVICE_ID, "other"] }), /exactamente un dispositivo/);

    database.prepare("UPDATE device_observations SET packages_json = '[]' WHERE device_id = ?").run(DEVICE_ID);
    assert.throws(() => assertTikTokDeviceEligible(database, DEVICE_ID), (error) => error instanceof TikTokError && error.code === "TIKTOK_NOT_INSTALLED");
  } finally {
    database.close();
  }
});

test("creates a manual-context campaign and generates exactly one comment without extraction", async () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    const campaign = createCampaign(database);
    assert.equal(campaign.mode, "post");
    assert.equal(campaign.posts.length, 1);
    assert.equal(campaign.assignments.length, 1);
    assert.equal(campaign.posts[0].contextStatus, "queued");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM jobs WHERE kind = 'post.extract'").get() as { total: number }).total, 0);
    assert.throws(() => requestTikTokCommentGeneration(database, {
      postId: campaign.posts[0].id,
      idempotencyKey: randomUUID(),
    }), (error) => error instanceof TikTokError && error.code === "MANUAL_CONTEXT_REQUIRED");

    const edited = editTikTokPostContext(database, campaign.id, campaign.posts[0].id, "Contexto manual real para el post controlado.");
    assert.equal(edited.posts[0].contextSource, "manual");
    const key = randomUUID();
    const generation = requestTikTokCommentGeneration(database, { postId: campaign.posts[0].id, idempotencyKey: key });
    assert.equal(requestTikTokCommentGeneration(database, { postId: campaign.posts[0].id, idempotencyKey: key }).replayed, true);
    const assignmentId = edited.assignments[0].id;
    const generated = await generateTikTokComment(database, generation.operation.id, async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ comments: [{
        assignmentId,
        text: "Este comentario valida el contexto manual",
      }] }) } }],
    }), undefined, "test-key");
    assert.equal(generated.status, "ready");
    assert.equal(generated.posts[0].comments.length, 1);
    assert.equal(generated.posts[0].comments[0].text, "Este comentario valida el contexto manual");
  } finally {
    database.close();
  }
});

test("persists an explicit post authorization with no automatic retry", () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    const campaign = createCampaign(database, false);
    const post = campaign.posts[0];
    const assignment = campaign.assignments[0];
    const request = {
      idempotencyKey: randomUUID(),
      expectedRevision: campaign.revision,
      expectedAccount: ACCOUNT,
      expectedAssignmentId: assignment.id,
      expectedPostId: post.id,
      expectedDeviceId: assignment.deviceId,
      expectedPostUrl: post.url,
      expectedActions: campaign.actions,
      expectedComment: null,
      expectedTargetText: "Post controlado exacto",
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    };
    assert.throws(
      () => requestTikTokPostExecution(database, campaign.id, request, config({ publicEffectsEnabled: false })),
      (error) => error instanceof TikTokError && error.code === "TIKTOK_EFFECTS_DISABLED",
    );
    const authorized = requestTikTokPostExecution(database, campaign.id, request, config());
    assert.equal(authorized.replayed, false);
    assert.equal(authorized.job.maxAttempts, 1);
    assert.equal(authorized.job.effectPhase, "before_effect");
    assert.equal((authorized.operation.request as { mode: string; authorization: { environmentGate: string } }).mode, "post");
    assert.equal((authorized.operation.request as { authorization: { environmentGate: string } }).authorization.environmentGate, "TIKTOK_PUBLIC_EFFECTS_ENABLED");
    assert.equal(requestTikTokPostExecution(database, campaign.id, request, config()).replayed, true);
  } finally {
    database.close();
  }
});

test("validates and persists Live separately behind its own gate", () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    const request = {
      deviceId: DEVICE_ID,
      url: "https://www.tiktok.com/@controlled/live",
      rounds: 3,
      x: 540,
      y: 960,
      expectedAccount: ACCOUNT,
      expectedTargetText: "Live controlado exacto",
      idempotencyKey: randomUUID(),
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
      tapTapConfirmed: true,
    };
    assert.equal(validateTikTokLiveRequest(request).rounds, 3);
    for (const invalid of [
      { ...request, rounds: 0 },
      { ...request, rounds: 51 },
      { ...request, x: -1 },
      { ...request, y: 5001 },
    ]) assert.throws(() => validateTikTokLiveRequest(invalid), /entero entre/);
    assert.throws(() => requestTikTokLiveExecution(database, request, config({ liveEffectsEnabled: false })), (error) => (
      error instanceof TikTokError && error.code === "TIKTOK_LIVE_EFFECTS_DISABLED"
    ));
    assert.throws(() => requestTikTokLiveExecution(database, request, config({
      liveCalibration: { deviceId: DEVICE_ID, x: 541, y: 960 },
    })), (error) => error instanceof TikTokError && error.code === "TIKTOK_LIVE_CALIBRATION_REQUIRED");

    const created = requestTikTokLiveExecution(database, request, config());
    assert.equal(created.campaign?.mode, "live");
    assert.equal(created.job.maxAttempts, 1);
    assert.equal((created.operation.request as { x: number; y: number }).x, 540);
    assert.equal((created.operation.request as { x: number; y: number }).y, 960);
    assert.equal(requestTikTokLiveExecution(database, request, config()).replayed, true);
    assert.throws(() => requestTikTokLiveExecution(database, { ...request, idempotencyKey: randomUUID() }, config()), (error) => (
      error instanceof TikTokError && error.code === "TIKTOK_LIVE_IN_PROGRESS"
    ));
    database.prepare("UPDATE jobs SET status = 'outcome_unknown', effect_phase = 'effect_possible' WHERE operation_id = ?").run(created.operation.id);
    database.prepare("UPDATE operations SET status = 'outcome_unknown', effect_phase = 'effect_possible' WHERE id = ?").run(created.operation.id);
    database.prepare("UPDATE assignments SET status = 'outcome_unknown' WHERE id = ?").run(created.campaign!.assignments[0].id);
    assert.throws(() => requestTikTokLiveExecution(database, { ...request, idempotencyKey: randomUUID() }, config()), (error) => (
      error instanceof TikTokError && error.code === "TIKTOK_LIVE_RECONCILIATION_REQUIRED"
    ));
    assert.equal(getTikTokCampaignSnapshot(database, created.campaign!.id)?.assignments.length, 1);
  } finally {
    database.close();
  }
});

test("the worker dispatches TikTok campaign jobs by their persisted platform", async () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    const request = campaignRequest(false);
    const operation = createOperation(database, {
      kind: "campaign.create",
      idempotencyKey: randomUUID(),
      request,
    }).operation;
    enqueueJob(database, "campaign.create", request, { operationId: operation.id });
    await runWorker({
      database,
      adb: {} as AdbClient,
      appium: {} as AppiumClient,
      owner: "tiktok-dispatch-worker",
      once: true,
      facebookBrowser: {
        extract: async () => { throw new Error("Facebook no debe ejecutarse"); },
        close: async () => undefined,
      },
    });
    assert.equal(getTikTokCampaignSnapshot(database, (database.prepare("SELECT id FROM campaigns").get() as { id: string }).id)?.platform, "tiktok");
  } finally {
    database.close();
  }
});
