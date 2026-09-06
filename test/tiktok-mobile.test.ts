import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdbClient, AdbDeviceInspection } from "../src/lib/adb.ts";
import { AppiumClient, AppiumClientError } from "../src/lib/appium-client.ts";
import { openDatabase } from "../src/lib/database.ts";
import { claimRuntimeOwnership, CURRENT_SETUP_REVISION } from "../src/lib/device-runtime.ts";
import { recoverFacebookExecutions } from "../src/lib/facebook-mobile.ts";
import { createOperation } from "../src/lib/operations.ts";
import { claimNextJob, completeJob, enqueueJob, failJob, getJob } from "../src/lib/queue.ts";
import {
  AppiumTikTokMobileDriver,
  executeTikTokAssignment,
  recoverTikTokExecutions,
  type TikTokLiveMobileDriver,
  type TikTokPostMobileDriver,
} from "../src/lib/tiktok-mobile.ts";
import {
  createTikTokCampaign,
  editTikTokComment,
  editTikTokPostContext,
  getTikTokCampaignSnapshot,
  reconcileTikTokAssignment,
  requestTikTokLiveExecution,
  requestTikTokPostExecution,
  TIKTOK_APP_PACKAGE,
  type TikTokConfig,
} from "../src/lib/tiktok.ts";

const OWNER = "tiktok-worker";
const DEVICE_ID = "tiktok-device";
const ACCOUNT = "@controlled.qa";
const POST_URL = "https://www.tiktok.com/@controlled/video/7410000000000000000";
const LIVE_URL = "https://www.tiktok.com/@controlled/live";
const TARGET = "Contenido TikTok controlado";
const COMMENT = "Este comentario corresponde al contenido controlado";

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

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "farm-tiktok-mobile-"));
  const database = openDatabase(":memory:");
  const hardwareId = "b".repeat(64);
  database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(hardwareId, DEVICE_ID, "TikTok QA", 1, 8200, 1, 1);
  database.prepare(`
    INSERT INTO device_observations (device_id, connection, hardware_id, packages_json, observed_at)
    VALUES (?, 'connected', ?, ?, 1)
  `).run(DEVICE_ID, hardwareId, JSON.stringify([TIKTOK_APP_PACKAGE]));
  const preparation = createOperation(database, {
    kind: "device.prepare",
    idempotencyKey: randomUUID(),
    request: { deviceId: DEVICE_ID },
    deviceId: DEVICE_ID,
  }).operation;
  database.prepare(`
    INSERT INTO device_preparations (
      id, device_id, operation_id, status, step, created_at, updated_at, completed_at, setup_revision
    ) VALUES (?, ?, ?, 'ready', 'Listo', 1, 1, 1, ?)
  `).run(randomUUID(), DEVICE_ID, preparation.id, CURRENT_SETUP_REVISION);

  let sessions = 0;
  const appium = new AppiumClient({
    baseUrl: "http://127.0.0.1:4723",
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/session") && init?.method === "POST") {
        sessions += 1;
        return Response.json({ value: { sessionId: `tiktok-session-${sessions}`, capabilities: {} } });
      }
      if (url.endsWith("/source")) return Response.json({ value: "<hierarchy><node text=\"TikTok QA\" /></hierarchy>" });
      if (url.endsWith("/screenshot")) return Response.json({ value: Buffer.from("png").toString("base64") });
      return Response.json({ value: null });
    },
  });
  const inspection: AdbDeviceInspection = {
    deviceId: DEVICE_ID,
    state: "device",
    model: "TikTok QA",
    roSerialNo: "physical",
    androidId: "android",
    hardwareId,
    packages: [TIKTOK_APP_PACKAGE],
    foreground: null,
    launcher: { packageName: "launcher", activityName: "Launcher", component: "launcher/Launcher" },
  };
  const adb = {
    inspectDevice: async () => inspection,
    goHome: async () => inspection.launcher,
    getForeground: async () => ({ packageName: TIKTOK_APP_PACKAGE, activityName: "Main", component: `${TIKTOK_APP_PACKAGE}/Main` }),
  } as unknown as AdbClient;
  return {
    database,
    directory,
    appium,
    adb,
    close: async () => {
      database.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    },
  };
}

function createPostExecution(setup: Setup, actions = { like: true, comment: true }) {
  const request = {
    platform: "tiktok" as const,
    urls: [POST_URL],
    deviceIds: [DEVICE_ID],
    actions,
    distribution: actions.comment ? [{ intention: "Afinidad", tone: "Cercano" as const, count: 1 as const }] : [],
  };
  const creation = createOperation(setup.database, {
    kind: "campaign.create",
    idempotencyKey: randomUUID(),
    request,
  }).operation;
  enqueueJob(setup.database, "campaign.create", request, { operationId: creation.id });
  let campaign = createTikTokCampaign(setup.database, creation.id, request)!;
  if (actions.comment) {
    campaign = editTikTokPostContext(setup.database, campaign.id, campaign.posts[0].id, `${TARGET} con contexto manual real.`);
    campaign = editTikTokComment(setup.database, campaign.posts[0].comments[0].id, {
      text: COMMENT,
      intention: "Afinidad",
      tone: "Cercano",
    });
  }
  setup.database.prepare("DELETE FROM jobs").run();
  const post = campaign.posts[0];
  const assignment = campaign.assignments[0];
  const comment = post.comments[0];
  const requested = requestTikTokPostExecution(setup.database, campaign.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: campaign.revision,
    expectedActions: campaign.actions,
    assignments: [{
      assignmentId: assignment.id,
      postId: post.id,
      deviceId: assignment.deviceId,
      expectedAccount: ACCOUNT,
      expectedPostUrl: post.url,
      expectedComment: comment ? { id: comment.id, version: comment.version, textHash: comment.textHash } : null,
      expectedTargetText: TARGET,
    }],
    confirmed: true,
    controlledAccount: true,
    controlledContent: true,
  }, config());
  return { campaignId: campaign.id, assignmentId: assignment.id, requested };
}

function postMobile(overrides: Partial<TikTokPostMobileDriver> = {}) {
  const calls: string[] = [];
  let liked = false;
  let draft = "";
  const driver: TikTokPostMobileDriver = {
    openPost: async () => { calls.push("open"); },
    verifyAccountAndPost: async () => { calls.push("verify"); },
    readLikeState: async () => { calls.push("read-like"); return liked; },
    prepareLike: async () => { calls.push("prepare-like"); return "like"; },
    tapLike: async () => { calls.push("tap-like"); liked = true; },
    openCommentComposer: async () => { calls.push("open-comment"); },
    assertCommentAbsent: async () => { calls.push("comment-absent"); },
    enterComment: async (_sessionId, text) => { calls.push("enter-comment"); draft = text; },
    readCommentDraft: async () => { calls.push("read-comment"); return draft; },
    prepareCommentSubmit: async () => { calls.push("prepare-submit"); return "submit"; },
    submitComment: async () => { calls.push("submit-comment"); },
    confirmCommentVisible: async () => { calls.push("confirm-comment"); },
    ...overrides,
  };
  return { calls, driver, setLiked(value: boolean) { liked = value; } };
}

async function runClaimed(setup: Setup, dependencies: { postMobile?: TikTokPostMobileDriver; liveMobile?: TikTokLiveMobileDriver }) {
  const job = claimNextJob(setup.database, OWNER);
  assert.ok(job?.operationId);
  try {
    const result = await executeTikTokAssignment(setup.database, job.operationId, OWNER, {
      adb: setup.adb,
      appium: setup.appium,
      config: config(),
      artifactsPath: setup.directory,
      ...dependencies,
    });
    completeJob(setup.database, job.id, OWNER, result);
    return { job: getJob(setup.database, job.id)!, error: null };
  } catch (error) {
    return { job: failJob(setup.database, job.id, OWNER, error, 0, false), error };
  }
}

test("executes the post once, preserves exact boundaries, and cleans up", async () => {
  const current = await setup();
  try {
    const execution = createPostExecution(current);
    claimRuntimeOwnership(current.database, OWNER, 1, Date.now(), 60_000);
    const mobile = postMobile();
    const result = await runClaimed(current, { postMobile: mobile.driver });
    assert.equal(result.error, null);
    assert.equal(result.job.status, "succeeded");
    assert.deepEqual(mobile.calls.filter((call) => call === "tap-like" || call === "submit-comment"), ["tap-like", "submit-comment"]);
    assert.equal(getTikTokCampaignSnapshot(current.database, execution.campaignId)?.assignments[0].status, "sent");
    assert.deepEqual(
      current.database.prepare("SELECT action, status FROM assignment_action_results ORDER BY action").all(),
      [{ action: "comment", status: "confirmed" }, { action: "like", status: "confirmed" }],
    );
    assert.equal((current.database.prepare("SELECT COUNT(*) AS total FROM checkpoints").get() as { total: number }).total, 2);
    assert.equal((current.database.prepare("SELECT cleanup_status FROM appium_sessions").get() as { cleanup_status: string }).cleanup_status, "home_confirmed");
  } finally {
    await current.close();
  }
});

test("never toggles an existing Like off", async () => {
  const current = await setup();
  try {
    createPostExecution(current, { like: true, comment: false });
    claimRuntimeOwnership(current.database, OWNER, 1, Date.now(), 60_000);
    const mobile = postMobile();
    mobile.setLiked(true);
    assert.equal((await runClaimed(current, { postMobile: mobile.driver })).job.status, "succeeded");
    assert.equal(mobile.calls.includes("tap-like"), false);
    assert.equal((current.database.prepare("SELECT result FROM assignment_action_results").get() as { result: string }).result, "already_active");
  } finally {
    await current.close();
  }
});

test("a comment that may have been sent becomes outcome_unknown and requires manual reconciliation", async () => {
  const current = await setup();
  try {
    const execution = createPostExecution(current, { like: false, comment: true });
    claimRuntimeOwnership(current.database, OWNER, 1, Date.now(), 60_000);
    const mobile = postMobile({ confirmCommentVisible: async () => { throw new Error("visibilidad incierta"); } });
    const result = await runClaimed(current, { postMobile: mobile.driver });
    assert.equal(result.job.status, "outcome_unknown");
    assert.equal(recoverFacebookExecutions(current.database, OWNER), 0);
    assert.equal(getTikTokCampaignSnapshot(current.database, execution.campaignId)?.assignments[0].status, "outcome_unknown");
    assert.equal(claimNextJob(current.database, OWNER), null);
    const evidence = current.database.prepare("SELECT kind, checkpoint_id FROM evidence").all() as Array<{ kind: string; checkpoint_id: string | null }>;
    assert.deepEqual(new Set(evidence.map((item) => item.kind)), new Set(["metadata", "screenshot", "page_source"]));
    assert.ok(evidence.every((item) => item.checkpoint_id));

    const jobsBefore = (current.database.prepare("SELECT COUNT(*) AS total FROM jobs").get() as { total: number }).total;
    const reconciled = reconcileTikTokAssignment(current.database, execution.assignmentId, {
      idempotencyKey: randomUUID(),
      operationId: execution.requested.operation.id,
      action: "comment",
      resolution: "not_sent",
    });
    assert.equal(reconciled.campaign?.assignments[0].status, "approved");
    assert.equal(reconciled.campaign?.status, "ready");
    assert.equal((current.database.prepare("SELECT COUNT(*) AS total FROM jobs").get() as { total: number }).total, jobsBefore);
    const campaign = reconciled.campaign!;
    const post = campaign.posts[0];
    const assignment = campaign.assignments[0];
    const comment = post.comments[0];
    assert.doesNotThrow(() => requestTikTokPostExecution(current.database, campaign.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: campaign.revision,
      expectedActions: campaign.actions,
      assignments: [{
        assignmentId: assignment.id,
        postId: post.id,
        deviceId: assignment.deviceId,
        expectedAccount: ACCOUNT,
        expectedPostUrl: post.url,
        expectedComment: { id: comment.id, version: comment.version, textHash: comment.textHash },
        expectedTargetText: TARGET,
      }],
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    }, config()));
  } finally {
    await current.close();
  }
});

test("Live checkpoints every round and an uncertain round is never retried", async () => {
  const current = await setup();
  try {
    const created = requestTikTokLiveExecution(current.database, {
      deviceIds: [DEVICE_ID],
      urls: [LIVE_URL],
      rounds: 3,
      expectedAccount: ACCOUNT,
      targetTexts: ["Live TikTok controlado"],
      idempotencyKey: randomUUID(),
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
      tapTapConfirmed: true,
    }, config());
    claimRuntimeOwnership(current.database, OWNER, 1, Date.now(), 60_000);
    let calls = 0;
    const live: TikTokLiveMobileDriver = {
      openLive: async () => undefined,
      verifyAccountAndLive: async () => undefined,
      doubleTapRound: async (_sessionId, x, y) => {
        calls += 1;
        assert.deepEqual({ x, y }, { x: 540, y: 960 });
        if (calls === 2) throw new Error("resultado de ronda perdido");
      },
    };
    const result = await runClaimed(current, { liveMobile: live });
    assert.equal(result.job.status, "outcome_unknown");
    assert.equal(calls, 2);
    const snapshot = getTikTokCampaignSnapshot(current.database, created.campaign!.id)!;
    assert.equal(snapshot.assignments[0].status, "outcome_unknown");
    assert.equal(snapshot.assignments[0].execution?.confirmedRounds, 1);
    assert.equal(snapshot.assignments[0].execution?.requestedRounds, 3);
    assert.deepEqual(
      current.database.prepare("SELECT phase, sequence FROM checkpoints ORDER BY sequence, phase").all(),
      [
        { phase: "before_tiktok_live_round", sequence: 1 },
        { phase: "tiktok_live_round_confirmed", sequence: 1 },
        { phase: "before_tiktok_live_round", sequence: 2 },
      ],
    );
    assert.equal(claimNextJob(current.database, OWNER), null);
  } finally {
    await current.close();
  }
});

test("recovery reflects a domain-committed cleanup uncertainty in the campaign", async () => {
  const current = await setup();
  try {
    const execution = createPostExecution(current, { like: true, comment: false });
    claimRuntimeOwnership(current.database, OWNER, 1, Date.now(), 60_000);
    assert.equal((await runClaimed(current, { postMobile: postMobile().driver })).job.status, "succeeded");
    current.database.prepare("UPDATE operations SET cleanup_status = 'outcome_unknown' WHERE id = ?")
      .run(execution.requested.operation.id);
    assert.equal(recoverTikTokExecutions(current.database, OWNER), 1);
    assert.equal(getTikTokCampaignSnapshot(current.database, execution.campaignId)?.status, "completed_with_issues");
    assert.equal(recoverTikTokExecutions(current.database, OWNER), 0);
  } finally {
    await current.close();
  }
});

test("the Appium Live adapter issues exactly one calibrated doubleClickGesture command", async () => {
  const scripts: Array<{ script: string; args: unknown[] }> = [];
  const liveConfig = config();
  const appium = {
    findElements: async (_sessionId: string, using: string, value: string) => {
      if (using === "id" && value === liveConfig.accountResourceId) return [{ elementId: "account" }];
      if (using === "id" && value === liveConfig.liveContainerResourceId) return [{ elementId: "live" }];
      return [];
    },
    findElementsFromElement: async (_sessionId: string, parent: string, using: string, value: string) => {
      if (parent === "live" && using === "xpath" && value.includes("Live TikTok controlado")) return [{ elementId: "target" }];
      if (parent === "live" && using === "id" && value === liveConfig.liveUrlResourceId) return [{ elementId: "url" }];
      return [];
    },
    getElementText: async (_sessionId: string, elementId: string) => elementId === "url" ? LIVE_URL : ACCOUNT,
    getElementAttribute: async () => null,
    executeScript: async (_sessionId: string, script: string, args: unknown[]) => { scripts.push({ script, args }); },
  } as unknown as AppiumClient;
  const driver = new AppiumTikTokMobileDriver({} as AdbClient, appium, liveConfig);
  await driver.verifyAccountAndLive(
    "session",
    ACCOUNT,
    liveConfig.accountResourceId,
    liveConfig.liveContainerResourceId,
    liveConfig.liveUrlResourceId,
    LIVE_URL,
    "Live TikTok controlado",
  );
  await driver.doubleTapRound("session", 540, 960);
  assert.deepEqual(scripts, [{ script: "mobile: doubleClickGesture", args: [{ x: 540, y: 960 }] }]);
});

test("Post and Live visibly launch via ADB before deepLink, with at most one quoted navigation fallback", async () => {
  for (const mode of ["post", "live"] as const) {
    for (const fallback of [false, true]) {
      const calls: string[] = [];
      const signal = new AbortController().signal;
      const url = `${mode === "post" ? POST_URL : LIVE_URL}?a=1&b=$(echo%20no);x=\`id\``;
      const adb = {
        launchApp: async (serial: string, packageName: string, options: { signal: AbortSignal }) => {
          assert.equal(serial, DEVICE_ID);
          assert.equal(packageName, TIKTOK_APP_PACKAGE);
          assert.equal(options.signal, signal);
          calls.push("launch");
        },
        execute: async (serial: string, args: string[], options: { signal: AbortSignal }) => {
          assert.equal(serial, DEVICE_ID);
          assert.equal(options.signal, signal);
          assert.deepEqual(args, ["shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
            "-d", `'${url}'`, "-p", TIKTOK_APP_PACKAGE]);
          calls.push("fallback");
          return { stdout: "Status: ok\n", stderr: "" };
        },
        getForeground: async (serial: string) => {
          assert.equal(serial, DEVICE_ID);
          calls.push("foreground");
          return { packageName: TIKTOK_APP_PACKAGE };
        },
      } as unknown as AdbClient;
      const appium = {
        executeScript: async (sessionId: string, script: string, args: unknown[], options: { signal: AbortSignal }) => {
          assert.equal(sessionId, "session");
          assert.equal(options.signal, signal);
          assert.equal(script, "mobile: deepLink");
          assert.deepEqual(args, [{ url, package: TIKTOK_APP_PACKAGE }]);
          calls.push("deepLink");
          if (fallback) throw new Error("deepLink failed");
        },
      } as unknown as AppiumClient;
      const driver = new AppiumTikTokMobileDriver(adb, appium, config());
      await driver[mode === "post" ? "openPost" : "openLive"]("session", DEVICE_ID, `${url}#discarded`, signal);
      assert.deepEqual(calls, ["launch", "deepLink", ...(fallback ? ["fallback"] : []), "foreground"]);
      await assert.rejects(mode === "post" ? driver.readLikeState("session") : driver.doubleTapRound("session", 540, 960), /objetivo TikTok no fue verificado/);
    }
  }
});

test("opening validates URLs before launch and never falls back after cancellation or launch failure", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  let failure: "launch" | "deepLink" | "aborted" | "during-deepLink" = "launch";
  const adb = {
    launchApp: async () => {
      calls.push("launch");
      if (failure === "launch") throw new Error("launch failed");
    },
    execute: async () => { calls.push("fallback"); throw new Error("unexpected fallback"); },
    getForeground: async () => { calls.push("foreground"); return { packageName: TIKTOK_APP_PACKAGE }; },
  } as unknown as AdbClient;
  const appium = {
    executeScript: async () => {
      calls.push("deepLink");
      if (failure === "during-deepLink") controller.abort(new Error("cancelled during deepLink"));
      if (failure === "aborted") throw new AppiumClientError("APPIUM_REQUEST_ABORTED", "request cancelled");
      throw new DOMException("deepLink cancelled", "AbortError");
    },
  } as unknown as AppiumClient;
  const driver = new AppiumTikTokMobileDriver(adb, appium, config());
  for (const url of ["not a URL", "http://www.tiktok.com/", "https://example.com/", "https://tiktok.com.evil.test/",
    "https://user:pass@tiktok.com/", "https://tiktok.com:444/", `${POST_URL}'`, `${LIVE_URL}\n`, `${POST_URL}?x=${"a".repeat(2048)}`]) {
    await assert.rejects(driver.openPost("session", DEVICE_ID, url));
  }
  assert.equal(calls.length, 0);
  await assert.rejects(driver.openPost("session", DEVICE_ID, POST_URL), /launch failed/);
  assert.deepEqual(calls.splice(0), ["launch"]);
  for (failure of ["deepLink", "aborted", "during-deepLink"] as const) {
    await assert.rejects(driver.openLive("session", DEVICE_ID, LIVE_URL, controller.signal), /cancelled/);
    assert.deepEqual(calls.splice(0), ["launch", "deepLink"]);
  }
  await assert.rejects(driver.openPost("session", DEVICE_ID, POST_URL, controller.signal), /cancelled/);
  assert.equal(calls.length, 0);
  const duringLaunch = new AbortController();
  adb.launchApp = async () => {
    calls.push("launch");
    duringLaunch.abort(new Error("cancelled during launch"));
    return { packageName: TIKTOK_APP_PACKAGE, activityName: "Main", component: `${TIKTOK_APP_PACKAGE}/Main` };
  };
  await assert.rejects(driver.openLive("session", DEVICE_ID, LIVE_URL, duringLaunch.signal), /cancelled during launch/);
  assert.deepEqual(calls, ["launch"]);
});

test("fallback transport failure, cancellation and wrong foreground stop without another navigation attempt", async () => {
  for (const failure of ["transport", "cancelled", "foreground"] as const) {
    const calls: string[] = [];
    const controller = new AbortController();
    const adb = {
      launchApp: async () => { calls.push("launch"); },
      execute: async () => {
        calls.push("fallback");
        if (failure === "transport") throw new Error("ADB timed out");
        if (failure === "cancelled") controller.abort(new Error("cancelled during fallback"));
        return { stdout: "Status: ok", stderr: "" };
      },
      getForeground: async () => { calls.push("foreground"); return { packageName: "com.android.chrome" }; },
    } as unknown as AdbClient;
    const appium = {
      executeScript: async () => { calls.push("deepLink"); throw new Error("deepLink failed"); },
    } as unknown as AppiumClient;
    const driver = new AppiumTikTokMobileDriver(adb, appium, config({ uiTimeoutMs: 1 }));
    await assert.rejects(driver.openLive("session", DEVICE_ID, LIVE_URL, controller.signal),
      failure === "transport" ? /ADB timed out/ : failure === "cancelled" ? /cancelled during fallback/ : /primer plano/);
    assert.deepEqual(calls.filter((call) => call !== "foreground"), ["launch", "deepLink", "fallback"]);
    assert.equal(calls.includes("foreground"), failure === "foreground");
  }
});

test("failed deep-link fallback stops before selectors or gestures and owned runtime saves evidence and returns Home", async () => {
  const current = await setup();
  const calls: string[] = [];
  try {
    createPostExecution(current);
    claimRuntimeOwnership(current.database, OWNER, 1, Date.now(), 60_000);
    current.adb.launchApp = async () => { calls.push("launch"); return (await current.adb.getForeground(DEVICE_ID))!; };
    current.adb.execute = async () => { calls.push("fallback"); return { stdout: "Error: unable to resolve Intent", stderr: "" }; };
    current.adb.goHome = async () => { calls.push("home"); return { packageName: "launcher", activityName: "Launcher", component: "launcher/Launcher" }; };
    current.appium.executeScript = async () => { calls.push("deepLink"); throw new Error("deepLink failed"); };
    current.appium.findElements = async () => { calls.push("selectors"); return []; };
    current.appium.clickElement = async () => { calls.push("click"); };
    const result = await runClaimed(current, {});
    assert.match(String(result.error), /unable to resolve Intent/);
    assert.equal(result.job.status, "failed");
    assert.equal(result.job.effectPhase, "before_effect");
    assert.deepEqual(calls, ["launch", "deepLink", "fallback", "home"]);
    assert.equal((current.database.prepare("SELECT COUNT(*) AS total FROM checkpoints").get() as { total: number }).total, 0);
    assert.deepEqual(new Set((current.database.prepare("SELECT kind FROM evidence").all() as Array<{ kind: string }>).map((row) => row.kind)),
      new Set(["metadata", "screenshot", "page_source"]));
    assert.equal((current.database.prepare("SELECT cleanup_status FROM appium_sessions").get() as { cleanup_status: string }).cleanup_status, "home_confirmed");
    assert.equal(claimNextJob(current.database, OWNER), null);
  } finally {
    await current.close();
  }
});
