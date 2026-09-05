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
  recordTikTokLiveCalibration,
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
const DEVICE_ID_2 = "tiktok-device-2";
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

function addEligibleDevice(database: Database.Database, deviceId = DEVICE_ID, systemPort = 8200, physicalOrder = 1, hardwareId = "a".repeat(64)) {
  database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(hardwareId, deviceId, "TikTok QA", physicalOrder, systemPort, 1, 1);
  database.prepare(`
    INSERT INTO device_observations (device_id, connection, hardware_id, packages_json, observed_at)
    VALUES (?, 'connected', ?, ?, 1)
  `).run(deviceId, hardwareId, JSON.stringify([TIKTOK_APP_PACKAGE]));
  const operation = createOperation(database, {
    kind: "device.prepare",
    idempotencyKey: randomUUID(),
    request: { deviceId },
    deviceId,
  }).operation;
  database.prepare(`
    INSERT INTO device_preparations (
      id, device_id, operation_id, status, step, created_at, updated_at, completed_at, setup_revision
    ) VALUES (?, ?, ?, 'ready', 'Listo', 1, 1, 1, ?)
  `).run(randomUUID(), deviceId, operation.id, CURRENT_SETUP_REVISION);
}

function campaignRequest(options: { comment?: boolean; deviceIds?: string[]; urls?: string[] } = {}) {
  const comment = options.comment ?? true;
  const deviceIds = options.deviceIds ?? [DEVICE_ID];
  const urls = options.urls ?? ["https://www.tiktok.com/@controlled/video/7410000000000000000"];
  return {
    platform: "tiktok" as const,
    urls,
    deviceIds,
    actions: { like: true, comment },
    distribution: comment
      ? deviceIds.map(() => ({ intention: "Afinidad", tone: "Cercano" as const, count: 1 as const }))
      : [],
  };
}

function createCampaign(database: Database.Database, options: { comment?: boolean; deviceIds?: string[]; urls?: string[] } = {}) {
  const request = campaignRequest(options);
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

test("enforces multi-device campaigns with exact comment distribution", () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    assert.doesNotThrow(() => assertTikTokDeviceEligible(database, DEVICE_ID));
    const validated = validateTikTokCampaignRequest(campaignRequest());
    assert.deepEqual(validated.deviceIds, [DEVICE_ID]);
    const multi = validateTikTokCampaignRequest(campaignRequest({
      deviceIds: [DEVICE_ID, DEVICE_ID_2],
      urls: [
        "https://www.tiktok.com/@controlled/video/7410000000000000000",
        "https://www.tiktok.com/@controlled/video/7410000000000000001",
      ],
    }));
    assert.equal(multi.urls.length, 2);
    assert.equal(multi.deviceIds.length, 2);
    assert.equal(multi.distribution.length, 2);
    assert.throws(() => validateTikTokCampaignRequest(campaignRequest({ deviceIds: [DEVICE_ID, DEVICE_ID] })), /solo puede seleccionarse una vez/);
    assert.throws(() => validateTikTokCampaignRequest(campaignRequest({
      deviceIds: [DEVICE_ID, DEVICE_ID_2],
      urls: [
        "https://www.tiktok.com/@controlled/video/7410000000000000000",
        "https://www.tiktok.com/@controlled/video/7410000000000000000",
      ],
    })), (error) => error instanceof TikTokError && error.code === "DUPLICATE_TIKTOK_URL");
    assert.throws(() => validateTikTokCampaignRequest({
      ...campaignRequest({ deviceIds: [DEVICE_ID, DEVICE_ID_2] }),
      distribution: [{ intention: "Afinidad", tone: "Cercano", count: 1 }],
    }), /cubrir exactamente/);

    database.prepare("UPDATE device_observations SET packages_json = '[]' WHERE device_id = ?").run(DEVICE_ID);
    assert.throws(() => assertTikTokDeviceEligible(database, DEVICE_ID), (error) => error instanceof TikTokError && error.code === "TIKTOK_NOT_INSTALLED");
  } finally {
    database.close();
  }
});

test("creates a manual-context N×M campaign and generates one comment per assignment", async () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    addEligibleDevice(database, DEVICE_ID_2, 8201, 2, "b".repeat(64));
    const campaign = createCampaign(database, { deviceIds: [DEVICE_ID, DEVICE_ID_2] });
    assert.equal(campaign.mode, "post");
    assert.equal(campaign.posts.length, 1);
    assert.equal(campaign.assignments.length, 2);
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
    const assignmentIds = edited.assignments.map((assignment) => assignment.id);
    const generated = await generateTikTokComment(database, generation.operation.id, async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ comments: assignmentIds.map((assignmentId) => ({
        assignmentId,
        text: `Este comentario valida el contexto manual ${assignmentId.slice(0, 8)}`,
      })) }) } }],
    }), undefined, "test-key");
    assert.equal(generated.status, "ready");
    assert.equal(generated.posts[0].comments.length, 2);
    assert.ok(generated.posts[0].comments.every((comment) => comment.text.startsWith("Este comentario valida")));
  } finally {
    database.close();
  }
});

test("persists an explicit post authorization with no automatic retry", () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    const campaign = createCampaign(database, { comment: false });
    const post = campaign.posts[0];
    const assignment = campaign.assignments[0];
    const request = {
      idempotencyKey: randomUUID(),
      expectedRevision: campaign.revision,
      expectedActions: campaign.actions,
      assignments: [{
        assignmentId: assignment.id,
        postId: post.id,
        deviceId: assignment.deviceId,
        expectedAccount: ACCOUNT,
        expectedPostUrl: post.url,
        expectedComment: null,
        expectedTargetText: "Post controlado exacto",
      }],
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
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM jobs WHERE kind = 'assignment.execute'").get() as { total: number }).total, 1);
  } finally {
    database.close();
  }
});

test("validates and persists Live N×M separately behind its own gate", () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    addEligibleDevice(database, DEVICE_ID_2, 8201, 2, "b".repeat(64));
    const request = {
      deviceIds: [DEVICE_ID],
      urls: ["https://www.tiktok.com/@controlled/live"],
      rounds: 3,
      expectedAccount: ACCOUNT,
      targetTexts: ["Live controlado exacto"],
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
      { ...request, urls: [] },
      { ...request, targetTexts: [] },
    ]) assert.throws(() => validateTikTokLiveRequest(invalid), (error) => error instanceof TikTokError);
    assert.throws(() => requestTikTokLiveExecution(database, request, config({ liveEffectsEnabled: false })), (error) => (
      error instanceof TikTokError && error.code === "TIKTOK_LIVE_EFFECTS_DISABLED"
    ));
    assert.throws(() => requestTikTokLiveExecution(database, { ...request, deviceIds: [DEVICE_ID_2] }, config({
      liveCalibration: { deviceId: DEVICE_ID, x: 540, y: 960 },
    })), (error) => error instanceof TikTokError && error.code === "TIKTOK_LIVE_CALIBRATION_REQUIRED");
    assert.deepEqual(recordTikTokLiveCalibration(database, DEVICE_ID_2, 500, 900, 123), {
      deviceId: DEVICE_ID_2,
      x: 500,
      y: 900,
      calibratedAt: 123,
    });

    const created = requestTikTokLiveExecution(database, request, config());
    assert.equal(created.campaign?.mode, "live");
    assert.equal(created.job.maxAttempts, 1);
    assert.equal((created.operation.request as { x: number; y: number }).x, 540);
    assert.equal((created.operation.request as { x: number; y: number }).y, 960);
    assert.equal(requestTikTokLiveExecution(database, request, config()).replayed, true);
    assert.throws(() => requestTikTokLiveExecution(database, { ...request, idempotencyKey: randomUUID() }, config()), (error) => (
      error instanceof TikTokError && error.code === "TIKTOK_LIVE_IN_PROGRESS"
    ));
    database.prepare("UPDATE jobs SET status = 'succeeded', effect_phase = 'effect_confirmed' WHERE operation_id = ?").run(created.operation.id);
    database.prepare("UPDATE operations SET status = 'succeeded' WHERE id = ?").run(created.operation.id);

    const multi = requestTikTokLiveExecution(database, {
      ...request,
      idempotencyKey: randomUUID(),
      deviceIds: [DEVICE_ID, DEVICE_ID_2],
      urls: ["https://www.tiktok.com/@controlled/live", "https://www.tiktok.com/@controlled2/live"],
      targetTexts: ["Live controlado exacto", "Segundo live controlado"],
    }, config());
    assert.equal(multi.campaign?.assignments.length, 4);
    const snapshot = getTikTokCampaignSnapshot(database, multi.campaign!.id)!;
    assert.equal(snapshot.mode, "live");
    assert.equal(snapshot.assignments.filter((assignment) => assignment.deviceId === DEVICE_ID).length, 2);
    assert.equal(snapshot.assignments.find((assignment) => assignment.deviceId === DEVICE_ID_2)?.execution?.requestedRounds, 3);

    const multiJob = (database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(multi.operation.id) as { id: string }).id;
    database.prepare("UPDATE jobs SET status = 'outcome_unknown', effect_phase = 'effect_possible' WHERE id = ?").run(multiJob);
    database.prepare("UPDATE operations SET status = 'outcome_unknown', effect_phase = 'effect_possible' WHERE id = ?").run(multi.operation.id);
    database.prepare("UPDATE assignments SET status = 'outcome_unknown' WHERE id = ?").run(multi.campaign!.assignments[0].id);
    assert.throws(() => requestTikTokLiveExecution(database, { ...request, idempotencyKey: randomUUID() }, config()), (error) => (
      error instanceof TikTokError && error.code === "TIKTOK_LIVE_IN_PROGRESS"
    ));
    const siblings = database.prepare(`
      SELECT j.id AS job_id, o.id AS operation_id FROM jobs j
      JOIN operations o ON o.id = j.operation_id
      WHERE o.campaign_id = ? AND o.device_id = ? AND o.id != ?
    `).all(multi.campaign!.id, DEVICE_ID, multi.operation.id) as Array<{ job_id: string; operation_id: string }>;
    for (const sibling of siblings) {
      database.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(sibling.job_id);
      database.prepare("UPDATE operations SET status = 'succeeded' WHERE id = ?").run(sibling.operation_id);
    }
    assert.throws(() => requestTikTokLiveExecution(database, { ...request, idempotencyKey: randomUUID() }, config()), (error) => (
      error instanceof TikTokError && error.code === "TIKTOK_LIVE_RECONCILIATION_REQUIRED"
    ));
  } finally {
    database.close();
  }
});

test("the worker dispatches TikTok campaign jobs by their persisted platform", async () => {
  const database = openDatabase(":memory:");
  try {
    addEligibleDevice(database);
    const request = campaignRequest({ comment: false });
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
