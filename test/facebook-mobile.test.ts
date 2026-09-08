import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdbClient, AdbDeviceInspection } from "../src/lib/adb.ts";
import { AppiumClient } from "../src/lib/appium-client.ts";
import { openDatabase } from "../src/lib/database.ts";
import {
  claimRuntimeOwnership,
  CURRENT_SETUP_REVISION,
  recoverOwnedSessions,
} from "../src/lib/device-runtime.ts";
import {
  createFacebookCampaign,
  getFacebookCampaignSnapshot,
  reconcileFacebookAssignment,
  reduceFacebookCampaignExecution,
  requestFacebookCampaignExecution,
  requestFacebookCampaignSchedule,
  requestFacebookExecutionCancellation,
} from "../src/lib/facebook.ts";
import {
  AppiumFacebookMobileDriver,
  executeFacebookAssignment,
  type FacebookMobileDriver,
  recoverFacebookExecutions,
} from "../src/lib/facebook-mobile.ts";
import { createOperation, IdempotencyConflictError } from "../src/lib/operations.ts";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  recoverStaleJobs,
  requestJobCancellation,
} from "../src/lib/queue.ts";

const OWNER = "worker-1";
const ACCOUNT = "Cuenta Controlada QA";
// Facebook Lite 527 keeps the com.facebook.katana resource namespace.
const ACCOUNT_RESOURCE_ID = "com.facebook.katana:id/active_account";
const POST_CONTAINER_RESOURCE_ID = "com.facebook.katana:id/post_container";
const POST_URL_RESOURCE_ID = "com.facebook.katana:id/post_url";
const COMMENT_COMPOSER_RESOURCE_ID = "com.facebook.katana:id/comment_composer";
const COMMENT_EDITOR_RESOURCE_ID = "com.facebook.katana:id/comment_editor";
const COMMENT_SUBMIT_RESOURCE_ID = "com.facebook.katana:id/comment_submit";
const COMMENT_RESULT_CONTAINER_RESOURCE_ID = "com.facebook.katana:id/comment_results";
const DEVICE_ID = "serial-1";
const TARGET_TEXT = "Publicación controlada exacta";
const COMMENT = "Este comentario pertenece al contenido controlado";

type Setup = Awaited<ReturnType<typeof setupExecution>>;
type FacebookActions = { like: boolean; comment: boolean; share?: boolean };

async function setupExecution(actions: FacebookActions = { like: true, comment: true }) {
  const directory = await mkdtemp(join(tmpdir(), "farm-facebook-mobile-"));
  const database = openDatabase(":memory:");
  const hardwareId = "a".repeat(64);
  database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(hardwareId, DEVICE_ID, "Equipo controlado", 1, 8200, 1, 1);
  database.prepare(`
    INSERT INTO device_observations (
      device_id, connection, hardware_id, packages_json, observed_at
    ) VALUES (?, 'connected', ?, '["com.facebook.lite"]', 1)
  `).run(DEVICE_ID, hardwareId);
  const preparation = createOperation(database, {
    kind: "device.prepare",
    idempotencyKey: randomUUID(),
    request: { deviceId: DEVICE_ID },
    deviceId: DEVICE_ID,
  }).operation;
  database.prepare(`
    INSERT INTO device_preparations (
      id, device_id, operation_id, status, step, created_at, updated_at,
      completed_at, setup_revision
    ) VALUES (?, ?, ?, 'ready', 'Listo', 1, 1, 1, ?)
  `).run(randomUUID(), DEVICE_ID, preparation.id, CURRENT_SETUP_REVISION);

  const campaignRequest = {
    urls: ["https://www.facebook.com/control/posts/1"],
    deviceIds: [DEVICE_ID],
    actions,
    distribution: actions.comment
      ? [{ intention: "Afinidad", tone: "Cercano" as const, count: 1 }]
      : [],
  };
  const creation = createOperation(database, {
    kind: "campaign.create",
    idempotencyKey: randomUUID(),
    request: campaignRequest,
  }).operation;
  enqueueJob(database, "campaign.create", campaignRequest, { operationId: creation.id });
  const created = createFacebookCampaign(database, creation.id, campaignRequest);
  const post = created!.posts[0];
  const assignment = created!.assignments[0];
  const context = `${TARGET_TEXT} con contexto adicional suficiente.`;
  database.prepare(`
    UPDATE posts SET status = 'ready', context_status = 'ready', context = ?,
       context_hash = ?, context_source = 'manual', context_version = 1,
       final_url = source_url, content_kind = 'post', updated_at = 2
    WHERE id = ?
  `).run(context, createHash("sha256").update(context).digest("hex"), post.id);
  if (actions.comment) {
    database.prepare(`
      UPDATE comments SET text = ?, status = 'ready', stale = 0, updated_at = 2
      WHERE assignment_id = ?
    `).run(COMMENT, assignment.id);
  }
  database.prepare("UPDATE assignments SET status = 'draft', updated_at = 2 WHERE id = ?").run(assignment.id);
  database.prepare("UPDATE campaigns SET status = 'ready', updated_at = 2 WHERE id = ?").run(created!.id);
  database.prepare("DELETE FROM jobs").run();

  let sessionCounter = 0;
  const appium = new AppiumClient({
    baseUrl: "http://127.0.0.1:4723",
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/session") && init?.method === "POST") {
        sessionCounter += 1;
        return Response.json({ value: { sessionId: `session-${sessionCounter}`, capabilities: {} } });
      }
      if (url.endsWith("/source")) return Response.json({ value: "<hierarchy><node text=\"controlado\" /></hierarchy>" });
      if (url.endsWith("/screenshot")) return Response.json({ value: Buffer.from("png").toString("base64") });
      return Response.json({ value: null });
    },
  });
  let failHome = false;
  const inspection: AdbDeviceInspection = {
    deviceId: DEVICE_ID,
    state: "device",
    model: "Controlado",
    roSerialNo: "physical",
    androidId: "android",
    hardwareId,
    packages: ["com.facebook.lite"],
    foreground: null,
    launcher: { packageName: "launcher", activityName: "Launcher", component: "launcher/Launcher" },
  };
  const adb = {
    inspectDevice: async () => inspection,
    goHome: async () => {
      if (failHome) throw new Error("Home no confirmado");
      return inspection.launcher;
    },
    getForeground: async () => ({ packageName: "com.facebook.lite", activityName: "Main", component: "com.facebook.lite/Main" }),
  } as unknown as AdbClient;

  const close = async () => {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  };
  return {
    database,
    directory,
    appium,
    adb,
    campaignId: created!.id,
    assignmentId: assignment.id,
    setFailHome(value: boolean) { failHome = value; },
    close,
  };
}

function mobileDriver(overrides: Partial<FacebookMobileDriver> = {}) {
  const calls: string[] = [];
  let liked = false;
  let draft = "";
  const driver: FacebookMobileDriver = {
    openPost: async () => { calls.push("open"); },
    verifyAccountAndPost: async () => { calls.push("verify"); },
    readLikeState: async () => { calls.push("read-like"); return liked; },
    prepareLike: async () => { calls.push("prepare-like"); return "like-element"; },
    tapLike: async () => { calls.push("tap-like"); liked = true; },
    prepareShare: async () => { calls.push("prepare-share"); return "share-element"; },
    openShareMenu: async () => { calls.push("open-share-menu"); },
    prepareShareNow: async () => { calls.push("prepare-share-now"); return "share-now-element"; },
    submitShare: async () => { calls.push("submit-share"); },
    confirmShare: async () => { calls.push("confirm-share"); },
    assertCommentAbsent: async () => { calls.push("comment-absent"); },
    openCommentComposer: async () => { calls.push("open-comment"); },
    enterComment: async (_sessionId, text) => { calls.push("enter-comment"); draft = text; },
    readCommentDraft: async () => { calls.push("read-comment"); return draft; },
    prepareCommentSubmit: async () => { calls.push("prepare-submit"); return "submit-element"; },
    submitComment: async () => { calls.push("submit-comment"); },
    confirmCommentVisible: async () => { calls.push("confirm-comment"); },
    ...overrides,
  };
  return { calls, driver, setLiked(value: boolean) { liked = value; } };
}

function executionRequest(setup: Setup, idempotencyKey = randomUUID()) {
  const snapshot = getFacebookCampaignSnapshot(setup.database, setup.campaignId)!;
  const assignment = snapshot.assignments[0];
  const post = snapshot.posts[0];
  const comment = post.comments.find((item) => item.assignmentId === assignment.id);
  return {
    idempotencyKey,
    expectedRevision: snapshot.revision,
    expectedAccount: ACCOUNT,
    expectedAssignmentId: assignment.id,
    expectedPostId: post.id,
    expectedDeviceId: assignment.deviceId,
    expectedPostUrl: post.finalUrl ?? post.url,
    expectedActions: snapshot.actions,
    expectedComment: comment ? { id: comment.id, version: comment.version, textHash: comment.textHash } : null,
    expectedTargetText: TARGET_TEXT,
    confirmed: true,
    controlledAccount: true,
    controlledContent: true,
  };
}

function requestExecution(setup: Setup, idempotencyKey = randomUUID()) {
  return requestFacebookCampaignExecution(
    setup.database,
    setup.campaignId,
    executionRequest(setup, idempotencyKey),
    ACCOUNT,
    ACCOUNT_RESOURCE_ID,
    POST_CONTAINER_RESOURCE_ID,
    POST_URL_RESOURCE_ID,
    COMMENT_COMPOSER_RESOURCE_ID,
    COMMENT_EDITOR_RESOURCE_ID,
    COMMENT_SUBMIT_RESOURCE_ID,
    COMMENT_RESULT_CONTAINER_RESOURCE_ID,
  );
}

async function runClaimed(setup: Setup, mobile: FacebookMobileDriver) {
  const job = claimNextJob(setup.database, OWNER);
  assert.ok(job?.operationId);
  try {
    const result = await executeFacebookAssignment(setup.database, job.operationId, OWNER, {
      adb: setup.adb,
      appium: setup.appium,
      mobile,
      controlledAccount: ACCOUNT,
      controlledAccountResourceId: ACCOUNT_RESOURCE_ID,
      postContainerResourceId: POST_CONTAINER_RESOURCE_ID,
      postUrlResourceId: POST_URL_RESOURCE_ID,
      commentComposerResourceId: COMMENT_COMPOSER_RESOURCE_ID,
      commentEditorResourceId: COMMENT_EDITOR_RESOURCE_ID,
      commentSubmitResourceId: COMMENT_SUBMIT_RESOURCE_ID,
      commentResultContainerResourceId: COMMENT_RESULT_CONTAINER_RESOURCE_ID,
      artifactsPath: setup.directory,
    });
    completeJob(setup.database, job.id, OWNER, result);
    return { job: getJob(setup.database, job.id)!, error: null };
  } catch (error) {
    const failed = failJob(setup.database, job.id, OWNER, error, 0, false);
    return { job: failed, error };
  }
}

test("executes one controlled assignment with independent checkpoints and cleanup", async () => {
  const setup = await setupExecution();
  try {
    requestExecution(setup);
    assert.equal(claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000), true);
    const mobile = mobileDriver();
    const result = await runClaimed(setup, mobile.driver);

    assert.equal(result.error, null);
    assert.equal(result.job.status, "succeeded");
    assert.equal(getFacebookCampaignSnapshot(setup.database, setup.campaignId)!.assignments[0].status, "sent");
    assert.deepEqual(mobile.calls.filter((call) => call === "tap-like" || call === "submit-comment"), ["tap-like", "submit-comment"]);
    assert.equal((setup.database.prepare("SELECT COUNT(*) AS total FROM checkpoints").get() as { total: number }).total, 2);
    assert.deepEqual(
      (setup.database.prepare("SELECT action, status FROM assignment_action_results ORDER BY action").all() as Array<{ action: string; status: string }>),
      [{ action: "comment", status: "confirmed" }, { action: "like", status: "confirmed" }],
    );
    assert.equal((setup.database.prepare("SELECT cleanup_status FROM appium_sessions").get() as { cleanup_status: string }).cleanup_status, "home_confirmed");
  } finally {
    await setup.close();
  }
});

test("shares a controlled post only after resolving Compartir ahora", async () => {
  const setup = await setupExecution({ like: false, comment: false, share: true });
  try {
    requestExecution(setup);
    assert.equal(claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000), true);
    const mobile = mobileDriver();
    const result = await runClaimed(setup, mobile.driver);

    assert.equal(result.error, null);
    assert.deepEqual(mobile.calls.filter((call) => call.includes("share")), [
      "prepare-share",
      "open-share-menu",
      "prepare-share-now",
      "submit-share",
      "confirm-share",
    ]);
    assert.deepEqual(
      setup.database.prepare("SELECT action, status, result FROM assignment_action_results").all(),
      [{ action: "share", status: "confirmed", result: "sent" }],
    );
    assert.equal((setup.database.prepare("SELECT COUNT(*) AS total FROM checkpoints WHERE phase = 'before_share'").get() as { total: number }).total, 1);
  } finally {
    await setup.close();
  }
});

test("executes a complete multidispositivo plan once and in order per device", async () => {
  const directory = await mkdtemp(join(tmpdir(), "farm-facebook-matrix-"));
  const database = openDatabase(":memory:");
  try {
    const deviceIds = ["serial-1", "serial-2"];
    for (const [index, deviceId] of deviceIds.entries()) {
      const hardwareId = String(index + 1).repeat(64);
      database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(hardwareId, deviceId, `Equipo ${index + 1}`, index + 1, 8200 + index, 1, 1);
      database.prepare(`
        INSERT INTO device_observations (device_id, connection, hardware_id, packages_json, observed_at)
        VALUES (?, 'connected', ?, '["com.facebook.lite"]', 1)
      `).run(deviceId, hardwareId);
      const preparation = createOperation(database, {
        kind: "device.prepare",
        idempotencyKey: randomUUID(),
        request: { deviceId },
        deviceId,
      }).operation;
      database.prepare(`
        INSERT INTO device_preparations (
          id, device_id, operation_id, status, step, created_at, updated_at,
          completed_at, setup_revision
        ) VALUES (?, ?, ?, 'ready', 'Listo', 1, 1, 1, ?)
      `).run(randomUUID(), deviceId, preparation.id, CURRENT_SETUP_REVISION);
    }
    const campaignRequest = {
      urls: [
        "https://www.facebook.com/control/posts/1",
        "https://www.facebook.com/control/posts/2",
      ],
      deviceIds,
      actions: { like: true, comment: false },
      distribution: [],
    };
    const creation = createOperation(database, {
      kind: "campaign.create",
      idempotencyKey: randomUUID(),
      request: campaignRequest,
    }).operation;
    enqueueJob(database, "campaign.create", campaignRequest, { operationId: creation.id });
    const campaign = createFacebookCampaign(database, creation.id, campaignRequest)!;
    database.prepare("DELETE FROM jobs").run();
    const scheduled = requestFacebookCampaignSchedule(database, campaign.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: campaign.revision,
      scheduledAt: 0,
      expectedActions: campaign.actions,
      assignments: campaign.assignments.map((assignment) => {
        const post = campaign.posts.find((item) => item.id === assignment.postId)!;
        return {
          assignmentId: assignment.id,
          postId: post.id,
          deviceId: assignment.deviceId,
          expectedAccount: `Cuenta ${assignment.deviceId}`,
          expectedPostUrl: post.finalUrl ?? post.url,
          expectedTargetText: `Publicacion controlada ${post.position}`,
          expectedComment: null,
        };
      }),
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    }, ACCOUNT_RESOURCE_ID, POST_CONTAINER_RESOURCE_ID, POST_URL_RESOURCE_ID);
    assert.equal(scheduled.replayed, false);
    assert.equal(claimRuntimeOwnership(database, OWNER, 1, Date.now(), 60_000), true);

    let sessionCounter = 0;
    const appium = new AppiumClient({
      baseUrl: "http://127.0.0.1:4723",
      fetch: async (input, init) => {
        if (String(input).endsWith("/session") && init?.method === "POST") {
          sessionCounter += 1;
          return Response.json({ value: { sessionId: `matrix-session-${sessionCounter}`, capabilities: {} } });
        }
        if (String(input).endsWith("/source")) return Response.json({ value: "<hierarchy><node text=\"controlado\" /></hierarchy>" });
        return Response.json({ value: null });
      },
    });
    const adb = {
      inspectDevice: async (deviceId: string) => {
        const index = deviceIds.indexOf(deviceId);
        return {
          deviceId,
          state: "device",
          model: `Equipo ${index + 1}`,
          roSerialNo: `physical-${index + 1}`,
          androidId: `android-${index + 1}`,
          hardwareId: String(index + 1).repeat(64),
          packages: ["com.facebook.lite"],
          foreground: null,
          launcher: { packageName: "launcher", activityName: "Launcher", component: "launcher/Launcher" },
        } satisfies AdbDeviceInspection;
      },
      goHome: async () => ({ packageName: "launcher", activityName: "Launcher", component: "launcher/Launcher" }),
      getForeground: async () => ({ packageName: "com.facebook.lite", activityName: "Main", component: "com.facebook.lite/Main" }),
    } as unknown as AdbClient;

    const uncertainJob = claimNextJob(database, OWNER, Date.now());
    assert.ok(uncertainJob?.operationId && uncertainJob.assignmentId);
    let uncertainError: unknown;
    try {
      await executeFacebookAssignment(database, uncertainJob.operationId, OWNER, {
        adb,
        appium,
        mobile: mobileDriver({ tapLike: async () => { throw new Error("resultado Like perdido"); } }).driver,
        controlledAccountResourceId: ACCOUNT_RESOURCE_ID,
        postContainerResourceId: POST_CONTAINER_RESOURCE_ID,
        postUrlResourceId: POST_URL_RESOURCE_ID,
        artifactsPath: directory,
      });
    } catch (error) {
      uncertainError = error;
      failJob(database, uncertainJob.id, OWNER, error, 0, false);
    }
    assert.match(String(uncertainError), /resultado Like perdido/);
    reconcileFacebookAssignment(database, uncertainJob.assignmentId, {
      idempotencyKey: randomUUID(),
      operationId: uncertainJob.operationId,
      action: "like",
      resolution: "not_sent",
    });
    const reconciled = getFacebookCampaignSnapshot(database, campaign.id)!;
    const retryAssignment = reconciled.assignments.find((assignment) => assignment.id === uncertainJob.assignmentId)!;
    const retryPost = reconciled.posts.find((post) => post.id === retryAssignment.postId)!;
    requestFacebookCampaignExecution(database, campaign.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: reconciled.revision,
      expectedAccount: `Cuenta ${retryAssignment.deviceId}`,
      expectedAssignmentId: retryAssignment.id,
      expectedPostId: retryPost.id,
      expectedDeviceId: retryAssignment.deviceId,
      expectedPostUrl: retryPost.finalUrl ?? retryPost.url,
      expectedActions: reconciled.actions,
      expectedComment: null,
      expectedTargetText: `Publicacion controlada ${retryPost.position}`,
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    }, "", ACCOUNT_RESOURCE_ID, POST_CONTAINER_RESOURCE_ID, POST_URL_RESOURCE_ID);

    const executed: Array<{ deviceId: string; postId: string }> = [];
    for (let index = 0; index < 4; index += 1) {
      const job = claimNextJob(database, OWNER, Date.now());
      assert.ok(job?.operationId);
      const operation = database.prepare("SELECT device_id, post_id FROM operations WHERE id = ?")
        .get(job.operationId) as { device_id: string; post_id: string };
      executed.push({ deviceId: operation.device_id, postId: operation.post_id });
      const result = await executeFacebookAssignment(database, job.operationId, OWNER, {
        adb,
        appium,
        mobile: mobileDriver().driver,
        controlledAccountResourceId: ACCOUNT_RESOURCE_ID,
        postContainerResourceId: POST_CONTAINER_RESOURCE_ID,
        postUrlResourceId: POST_URL_RESOURCE_ID,
        artifactsPath: directory,
      });
      completeJob(database, job.id, OWNER, result);
    }
    assert.equal(claimNextJob(database, OWNER, Date.now()), null);
    for (const deviceId of deviceIds) {
      assert.deepEqual(
        executed.filter((item) => item.deviceId === deviceId).map((item) => campaign.posts.find((post) => post.id === item.postId)!.position),
        [1, 2],
      );
    }
    const completed = getFacebookCampaignSnapshot(database, campaign.id)!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.assignments.filter((assignment) => assignment.status === "sent").length, 4);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM assignment_action_results WHERE status = 'confirmed'").get() as { total: number }).total, 4);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("does not tap when Like is already active", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    const mobile = mobileDriver();
    mobile.setLiked(true);
    await runClaimed(setup, mobile.driver);

    assert.equal(mobile.calls.includes("tap-like"), false);
    assert.equal((setup.database.prepare("SELECT result FROM assignment_action_results").get() as { result: string }).result, "already_active");
  } finally {
    await setup.close();
  }
});

test("a safe failure before Like performs no effect and is not retried automatically", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    const mobile = mobileDriver({ verifyAccountAndPost: async () => { throw new Error("objetivo incorrecto"); } });
    const result = await runClaimed(setup, mobile.driver);

    assert.match(String(result.error), /objetivo incorrecto/);
    assert.equal(result.job.status, "failed");
    assert.equal(result.job.attempts, 1);
    assert.equal(mobile.calls.includes("tap-like"), false);
    assert.equal(getFacebookCampaignSnapshot(setup.database, setup.campaignId)!.assignments[0].status, "failed");
    assert.equal(claimNextJob(setup.database, OWNER), null);
  } finally {
    await setup.close();
  }
});

test("a confirmed Like is preserved when Comment fails and is never tapped again", async () => {
  const setup = await setupExecution();
  try {
    requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    const first = mobileDriver({ openCommentComposer: async () => { throw new Error("compositor ausente"); } });
    const failed = await runClaimed(setup, first.driver);
    assert.equal(failed.job.status, "failed");
    assert.equal(first.calls.filter((call) => call === "tap-like").length, 1);

    const secondRequest = requestExecution(setup);
    const preserved = setup.database.prepare(`
      SELECT status, result FROM assignment_action_results
      WHERE operation_id = ? AND action = 'like'
    `).get(secondRequest.operation.id) as { status: string; result: string };
    assert.deepEqual(preserved, { status: "confirmed", result: "preserved" });
    const second = mobileDriver();
    const completed = await runClaimed(setup, second.driver);
    assert.equal(completed.job.status, "succeeded");
    assert.equal(second.calls.includes("tap-like"), false);
    assert.equal(second.calls.includes("submit-comment"), true);
  } finally {
    await setup.close();
  }
});

test("a timeout after Comment submit becomes outcome_unknown with evidence and no retry", async () => {
  const setup = await setupExecution({ like: false, comment: true });
  try {
    requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    const mobile = mobileDriver({ confirmCommentVisible: async () => { throw new Error("timeout despues de enviar"); } });
    const result = await runClaimed(setup, mobile.driver);

    assert.equal(result.job.status, "outcome_unknown");
    const snapshot = getFacebookCampaignSnapshot(setup.database, setup.campaignId)!;
    assert.equal(snapshot.assignments[0].status, "outcome_unknown");
    assert.equal(snapshot.assignments[0].execution?.uncertainAction, "comment");
    assert.equal(claimNextJob(setup.database, OWNER), null);
    assert.throws(() => requestExecution(setup), /reconciliarse manualmente/);
    const evidence = setup.database.prepare("SELECT kind, checkpoint_id FROM evidence").all() as Array<{ kind: string; checkpoint_id: string | null }>;
    assert.deepEqual(new Set(evidence.map((item) => item.kind)), new Set(["metadata", "screenshot", "page_source"]));
    assert.ok(evidence.every((item) => item.checkpoint_id));
  } finally {
    await setup.close();
  }
});

test("worker recovery marks a crash after submit unknown without resending", async () => {
  const setup = await setupExecution({ like: false, comment: true });
  try {
    requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    const mobile = mobileDriver({
      confirmCommentVisible: async () => {
        setup.database.prepare("DELETE FROM runtime_ownership").run();
        claimRuntimeOwnership(setup.database, "worker-2", 2, Date.now(), 60_000);
      },
    });
    const job = claimNextJob(setup.database, OWNER)!;
    await assert.rejects(executeFacebookAssignment(setup.database, job.operationId!, OWNER, {
      adb: setup.adb,
      appium: setup.appium,
      mobile: mobile.driver,
      controlledAccount: ACCOUNT,
      controlledAccountResourceId: ACCOUNT_RESOURCE_ID,
      postContainerResourceId: POST_CONTAINER_RESOURCE_ID,
      postUrlResourceId: POST_URL_RESOURCE_ID,
      commentComposerResourceId: COMMENT_COMPOSER_RESOURCE_ID,
      commentEditorResourceId: COMMENT_EDITOR_RESOURCE_ID,
      commentSubmitResourceId: COMMENT_SUBMIT_RESOURCE_ID,
      commentResultContainerResourceId: COMMENT_RESULT_CONTAINER_RESOURCE_ID,
      artifactsPath: setup.directory,
    }), /nuevo owner debe ejecutar recovery/);

    await recoverOwnedSessions(setup.database, "worker-2", setup.adb, setup.appium, 100, setup.directory);
    recoverStaleJobs(setup.database, "worker-2");
    recoverFacebookExecutions(setup.database, "worker-2");
    assert.equal(getJob(setup.database, job.id)?.status, "outcome_unknown");
    assert.equal(getFacebookCampaignSnapshot(setup.database, setup.campaignId)!.assignments[0].status, "outcome_unknown");
    assert.equal(mobile.calls.filter((call) => call === "submit-comment").length, 1);
    assert.equal(claimNextJob(setup.database, "worker-2"), null);
    const evidence = setup.database.prepare("SELECT kind, metadata_json FROM evidence").all() as Array<{ kind: string; metadata_json: string }>;
    assert.ok(evidence.some((item) => item.kind === "screenshot"));
    assert.ok(evidence.some((item) => (JSON.parse(item.metadata_json) as { stage?: string }).stage === "recovery_before_cleanup"));
  } finally {
    await setup.close();
  }
});

test("manual reconciliation records sent or reopens not_sent without enqueueing", async () => {
  for (const resolution of ["sent", "not_sent"] as const) {
    const setup = await setupExecution({ like: false, comment: true });
    try {
      const requested = requestExecution(setup);
      claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
      await runClaimed(setup, mobileDriver({ confirmCommentVisible: async () => { throw new Error("confirmacion perdida"); } }).driver);
      const jobsBefore = (setup.database.prepare("SELECT COUNT(*) AS total FROM jobs").get() as { total: number }).total;
      const key = randomUUID();
      const reconciled = reconcileFacebookAssignment(setup.database, setup.assignmentId, {
        idempotencyKey: key,
        operationId: requested.operation.id,
        action: "comment",
        resolution,
      });
      assert.equal(reconciled.campaign?.assignments[0].status, resolution === "sent" ? "sent" : "approved");
      assert.equal((setup.database.prepare("SELECT COUNT(*) AS total FROM jobs").get() as { total: number }).total, jobsBefore);
      const replayed = reconcileFacebookAssignment(setup.database, setup.assignmentId, {
        idempotencyKey: key,
        operationId: requested.operation.id,
        action: "comment",
        resolution,
      });
      assert.equal(replayed.replayed, true);
    } finally {
      await setup.close();
    }
  }
});

test("stale reconciliation cannot resolve a newer uncertain execution", async () => {
  const setup = await setupExecution({ like: false, comment: true });
  try {
    const first = requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    await runClaimed(setup, mobileDriver({ confirmCommentVisible: async () => { throw new Error("primera confirmacion perdida"); } }).driver);
    reconcileFacebookAssignment(setup.database, setup.assignmentId, {
      idempotencyKey: randomUUID(),
      operationId: first.operation.id,
      action: "comment",
      resolution: "not_sent",
    });

    const second = requestExecution(setup);
    await runClaimed(setup, mobileDriver({ confirmCommentVisible: async () => { throw new Error("segunda confirmacion perdida"); } }).driver);
    assert.throws(() => reconcileFacebookAssignment(setup.database, setup.assignmentId, {
      idempotencyKey: randomUUID(),
      operationId: first.operation.id,
      action: "comment",
      resolution: "not_sent",
    }), /no tiene ese efecto incierto/i);
    const uncertain = setup.database.prepare(`
      SELECT status FROM assignment_action_results
      WHERE operation_id = ? AND action = 'comment'
    `).get(second.operation.id) as { status: string };
    assert.equal(uncertain.status, "outcome_unknown");
  } finally {
    await setup.close();
  }
});

test("an uncertain action terminalizes unexecuted siblings without corrupting later success", async () => {
  const setup = await setupExecution({ like: true, comment: true });
  try {
    const first = requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    await runClaimed(setup, mobileDriver({ tapLike: async () => { throw new Error("resultado Like perdido"); } }).driver);
    const firstActions = setup.database.prepare(`
      SELECT action, status FROM assignment_action_results WHERE operation_id = ? ORDER BY action
    `).all(first.operation.id) as Array<{ action: string; status: string }>;
    assert.deepEqual(firstActions, [
      { action: "comment", status: "cancelled" },
      { action: "like", status: "outcome_unknown" },
    ]);
    reconcileFacebookAssignment(setup.database, setup.assignmentId, {
      idempotencyKey: randomUUID(),
      operationId: first.operation.id,
      action: "like",
      resolution: "not_sent",
    });

    requestExecution(setup);
    assert.equal((await runClaimed(setup, mobileDriver().driver)).job.status, "succeeded");
    assert.equal(recoverFacebookExecutions(setup.database, OWNER), 0);
    const snapshot = getFacebookCampaignSnapshot(setup.database, setup.campaignId)!;
    assert.equal(snapshot.assignments[0].status, "sent");
    assert.equal(snapshot.posts[0].status, "completed");
    assert.equal(snapshot.status, "completed");
  } finally {
    await setup.close();
  }
});

test("manual reconciliation waits for the active worker to terminalize", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    const requested = requestExecution(setup);
    assert.throws(() => reconcileFacebookAssignment(setup.database, setup.assignmentId, {
      idempotencyKey: randomUUID(),
      operationId: requested.operation.id,
      action: "like",
      resolution: "not_sent",
    }), /worker termine/i);
    assert.equal((setup.database.prepare("SELECT COUNT(*) AS total FROM operations WHERE kind = 'operation.reconcile'").get() as { total: number }).total, 0);
  } finally {
    await setup.close();
  }
});

test("manual reconciliation requires the uncertain session closed with Home confirmed", async () => {
  const setup = await setupExecution({ like: false, comment: true });
  try {
    const requested = requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    await runClaimed(setup, mobileDriver({ confirmCommentVisible: async () => { throw new Error("confirmacion perdida"); } }).driver);
    setup.database.prepare(`
      UPDATE appium_sessions
      SET status = 'outcome_unknown', cleanup_status = 'outcome_unknown', closed_at = NULL
      WHERE operation_id = (
        SELECT operation_id FROM assignment_action_results
        WHERE assignment_id = ? AND action = 'comment' AND status = 'outcome_unknown'
      )
    `).run(setup.assignmentId);
    assert.throws(() => reconcileFacebookAssignment(setup.database, setup.assignmentId, {
      idempotencyKey: randomUUID(),
      operationId: requested.operation.id,
      action: "comment",
      resolution: "not_sent",
    }), /confirma Home/i);
  } finally {
    await setup.close();
  }
});

test("the Appium driver scopes target controls to the verified post container", async () => {
  const childCalls: Array<{ parent: string; using: string; value: string }> = [];
  let composerVisible = false;
  let commentSurfaceVisible = false;
  let commentSent = false;
  let shareMenuOpen = false;
  let shareConfirmed = false;
  let targetUrl = "https://www.facebook.com/control/posts/1";
  const appium = {
    findElements: async (_sessionId: string, using: string, value: string) => {
      if (using === "id" && value === ACCOUNT_RESOURCE_ID) return [{ elementId: "account" }];
      if (using === "id" && value === POST_CONTAINER_RESOURCE_ID) return [{ elementId: "other-post" }, { elementId: "target-post" }];
      if (using === "id" && value === COMMENT_COMPOSER_RESOURCE_ID) return composerVisible ? [{ elementId: "composer" }] : [];
      if (using === "id" && value === COMMENT_RESULT_CONTAINER_RESOURCE_ID) return commentSurfaceVisible ? [{ elementId: "comment-results" }] : [];
      if (using === "accessibility id" && value === "Compartir ahora" && shareMenuOpen) return [{ elementId: "share-now" }];
      if (using === "accessibility id" && value === "Publicación compartida" && shareConfirmed) return [{ elementId: "share-confirmation" }];
      return [];
    },
    findElementsFromElement: async (_sessionId: string, parent: string, using: string, value: string) => {
      childCalls.push({ parent, using, value });
      if (using === "xpath" && value.includes(TARGET_TEXT) && parent === "target-post") return [{ elementId: "target-text" }];
      if (using === "id" && value === POST_URL_RESOURCE_ID && parent === "target-post") return [{ elementId: "target-url" }];
      if (using === "accessibility id" && ["Me gusta", "Like"].includes(value) && parent === "target-post") return [{ elementId: "target-like" }];
      if (using === "accessibility id" && ["Comentar", "Comment"].includes(value) && parent === "target-post") return [{ elementId: "comment-trigger" }];
      if (using === "accessibility id" && ["Compartir", "Share"].includes(value) && parent === "target-post") return [{ elementId: "share-trigger" }];
      if (using === "id" && value === COMMENT_EDITOR_RESOURCE_ID && parent === "composer") return [{ elementId: "editor" }];
      if (using === "id" && value === COMMENT_SUBMIT_RESOURCE_ID && parent === "composer") return [{ elementId: "submit" }];
      if (using === "xpath" && value.includes(COMMENT) && parent === "comment-results" && commentSent) return [{ elementId: "sent-comment" }];
      return [];
    },
    getElementText: async (_sessionId: string, elementId: string) => {
      if (elementId === "editor") return COMMENT;
      if (elementId === "target-url") return targetUrl;
      return ACCOUNT;
    },
    getElementAttribute: async () => null,
    clickElement: async (_sessionId: string, elementId: string) => {
      if (elementId === "comment-trigger") {
        composerVisible = true;
        commentSurfaceVisible = true;
      }
      if (elementId === "submit") {
        composerVisible = false;
        commentSurfaceVisible = false;
        commentSent = true;
      }
      if (elementId === "share-trigger") shareMenuOpen = true;
      if (elementId === "share-now") shareConfirmed = true;
    },
    clearElement: async () => undefined,
    setElementValue: async () => undefined,
  } as unknown as AppiumClient;
  const mobile = new AppiumFacebookMobileDriver({} as AdbClient, appium, {
    composer: COMMENT_COMPOSER_RESOURCE_ID,
    editor: COMMENT_EDITOR_RESOURCE_ID,
    submit: COMMENT_SUBMIT_RESOURCE_ID,
    result: COMMENT_RESULT_CONTAINER_RESOURCE_ID,
  });

  await mobile.verifyAccountAndPost(
    "session",
    ACCOUNT,
    ACCOUNT_RESOURCE_ID,
    POST_CONTAINER_RESOURCE_ID,
    POST_URL_RESOURCE_ID,
    "https://www.facebook.com/control/posts/1",
    TARGET_TEXT,
  );
  assert.equal(await mobile.readLikeState("session"), false);
  assert.equal(await mobile.prepareLike("session"), "target-like");
  await mobile.openCommentComposer("session");
  await mobile.enterComment("session", COMMENT);
  assert.equal(await mobile.readCommentDraft("session"), COMMENT);
  const submit = await mobile.prepareCommentSubmit("session");
  assert.equal(submit, "submit");
  await mobile.submitComment("session", submit);
  await mobile.confirmCommentVisible("session", COMMENT);
  const share = await mobile.prepareShare("session");
  await mobile.openShareMenu("session", share);
  await mobile.submitShare("session", await mobile.prepareShareNow("session"));
  await mobile.confirmShare("session");
  assert.ok(childCalls.some((call) => call.parent === "target-post" && call.using === "accessibility id"));
  assert.ok(childCalls.some((call) => call.parent === "target-post" && call.value === "Compartir"));
  assert.ok(childCalls.some((call) => call.parent === "composer" && call.value === COMMENT_EDITOR_RESOURCE_ID));
  assert.ok(childCalls.some((call) => call.parent === "composer" && call.value === COMMENT_SUBMIT_RESOURCE_ID));
  assert.equal(childCalls.some((call) => call.parent === "other-post" && call.using === "accessibility id"), false);
  targetUrl = "https://www.facebook.com/control/posts/otro";
  await assert.rejects(mobile.prepareLike("session"), /URL efectiva autorizada/i);
});

test("the structural Facebook fallback verifies the active profile and scrolls the target post before reading Like state", async () => {
  let screen: "feed" | "profile" | "target" = "target";
  let postControlsVisible = false;
  const adb = {
    execute: async () => undefined,
    launchApp: async (_deviceId: string, packageName: string) => {
      assert.equal(packageName, "com.facebook.lite");
      screen = "feed";
      return { packageName, activityName: ".Main" };
    },
    getForeground: async () => ({ packageName: "com.facebook.lite", activityName: ".Main" }),
    waitForForeground: async () => ({ packageName: "com.facebook.lite", activityName: ".Main" }),
  } as unknown as AdbClient;
  const appium = {
    activateApp: async (_sessionId: string, packageName: string) => assert.equal(packageName, "com.facebook.lite"),
    executeScript: async (_sessionId: string, _script: string, args: Array<{ package: string }>) => {
      assert.equal(args[0].package, "com.facebook.lite");
      screen = "target";
    },
    findElements: async (_sessionId: string, using: string, value: string) => {
      if (using === "accessibility id" && value === "Ir al perfil" && screen === "feed") return [{ elementId: "profile-link" }];
      if (using === "xpath" && value.includes(ACCOUNT) && screen === "profile") return [{ elementId: "account" }];
      if (using === "xpath" && value.includes(TARGET_TEXT) && value.includes("ancestor::") && screen === "target") return [{ elementId: "target-post" }];
      if (using === "-android uiautomator") {
        postControlsVisible = true;
        return [];
      }
      return [];
    },
    findElementsFromElement: async (_sessionId: string, parent: string, using: string, value: string) => (
      postControlsVisible && parent === "target-post" && using === "xpath" && value === ".//android.widget.Button"
        ? [{ elementId: "like" }, { elementId: "comment" }]
        : []
    ),
    getElementText: async (_sessionId: string, elementId: string) => elementId === "comment" ? "Comentar" : "",
    getElementAttribute: async (_sessionId: string, elementId: string) => (
      elementId === "like" ? 'Botón "Me gusta" presionado. Toca dos veces para cambiar la reacción.' : null
    ),
    clickElement: async (_sessionId: string, elementId: string) => { if (elementId === "profile-link") screen = "profile"; },
  } as unknown as AppiumClient;
  const mobile = new AppiumFacebookMobileDriver(adb, appium, {
    composer: "@accessibility",
    editor: "@accessibility",
    submit: "@accessibility",
    result: "@accessibility",
  });

  await mobile.openPost("session", "device-1", "https://www.facebook.com/control/posts/1");
  await mobile.verifyAccountAndPost(
    "session",
    ACCOUNT,
    "@accessibility",
    "@accessibility",
    "@accessibility",
    "https://www.facebook.com/control/posts/1",
    TARGET_TEXT,
  );
  assert.equal(await mobile.readLikeState("session"), true);
  assert.equal(postControlsVisible, true);
});

test("the structural Facebook fallback accepts a dynamic Reel Compartir label only inside the verified Reel", async () => {
  let screen: "feed" | "profile" | "target" = "target";
  const adb = {
    execute: async () => undefined,
    launchApp: async (_deviceId: string, packageName: string) => {
      assert.equal(packageName, "com.facebook.lite");
      screen = "feed";
      return { packageName, activityName: ".Main" };
    },
    getForeground: async () => ({ packageName: "com.facebook.lite", activityName: ".Main" }),
    waitForForeground: async () => ({ packageName: "com.facebook.lite", activityName: ".Main" }),
  } as unknown as AdbClient;
  const appium = {
    activateApp: async () => undefined,
    executeScript: async () => { screen = "target"; },
    findElements: async (_sessionId: string, using: string, value: string) => {
      if (using === "accessibility id" && value === "Ir al perfil" && screen === "feed") return [{ elementId: "profile-link" }];
      if (using === "xpath" && value.includes(ACCOUNT) && screen === "profile") return [{ elementId: "account" }];
      if (using === "xpath" && value.includes(TARGET_TEXT) && screen === "target") return [{ elementId: "target-reel" }];
      return [];
    },
    findElementsFromElement: async (_sessionId: string, parent: string, using: string, value: string) => (
      parent === "target-reel" && using === "xpath" && value === ".//android.widget.Button"
        ? [{ elementId: "reel-share" }]
        : []
    ),
    getElementText: async () => "",
    getElementAttribute: async (_sessionId: string, elementId: string) => (
      elementId === "reel-share" ? "Compartir, 79 veces compartido" : null
    ),
    clickElement: async (_sessionId: string, elementId: string) => { if (elementId === "profile-link") screen = "profile"; },
  } as unknown as AppiumClient;
  const mobile = new AppiumFacebookMobileDriver(adb, appium, {
    composer: "@accessibility",
    editor: "@accessibility",
    submit: "@accessibility",
    result: "@accessibility",
  });

  await mobile.openPost("session", "device-1", "https://www.facebook.com/reel/canonical-id");
  await mobile.verifyAccountAndPost(
    "session",
    ACCOUNT,
    "@accessibility",
    "@accessibility",
    "@accessibility",
    "https://www.facebook.com/reel/canonical-id",
    TARGET_TEXT,
    undefined,
    "reel",
  );
  assert.equal(await mobile.prepareShare("session"), "reel-share");
});

test("a Home failure cannot make confirmed effects retryable", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    setup.setFailHome(true);
    const result = await runClaimed(setup, mobileDriver().driver);

    assert.ok(result.error instanceof Error);
    assert.equal(result.job.status, "failed");
    assert.equal(result.job.effectPhase, "effect_confirmed");
    assert.equal(getFacebookCampaignSnapshot(setup.database, setup.campaignId)!.assignments[0].status, "sent");
    assert.equal((setup.database.prepare("SELECT COUNT(*) AS total FROM device_locks").get() as { total: number }).total, 1);
    const evidence = setup.database.prepare("SELECT kind, checkpoint_id FROM evidence").all() as Array<{ kind: string; checkpoint_id: string | null }>;
    assert.deepEqual(new Set(evidence.map((item) => item.kind)), new Set(["metadata", "screenshot", "page_source"]));
    assert.ok(evidence.every((item) => item.checkpoint_id));
    assert.equal(claimNextJob(setup.database, OWNER), null);
  } finally {
    await setup.close();
  }
});

test("execution confirmation is idempotent and changed payloads conflict", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    const key = randomUUID();
    const first = requestExecution(setup, key);
    const confirmed = first.operation.request as {
      expectedRevision: number;
      expectedAccount: string;
      assignmentId: string;
      postId: string;
      deviceId: string;
      postUrl: string;
      actions: { like: boolean; comment: boolean };
      comment: null | { id: string; version: number; textHash: string };
    };
    const replay = requestFacebookCampaignExecution(setup.database, setup.campaignId, {
      idempotencyKey: key,
      expectedRevision: confirmed.expectedRevision,
      expectedAccount: confirmed.expectedAccount,
      expectedAssignmentId: confirmed.assignmentId,
      expectedPostId: confirmed.postId,
      expectedDeviceId: confirmed.deviceId,
      expectedPostUrl: confirmed.postUrl,
      expectedActions: confirmed.actions,
      expectedComment: confirmed.comment,
      expectedTargetText: TARGET_TEXT,
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    }, ACCOUNT, ACCOUNT_RESOURCE_ID, POST_CONTAINER_RESOURCE_ID, POST_URL_RESOURCE_ID, COMMENT_COMPOSER_RESOURCE_ID, COMMENT_EDITOR_RESOURCE_ID, COMMENT_SUBMIT_RESOURCE_ID, COMMENT_RESULT_CONTAINER_RESOURCE_ID);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation.id, first.operation.id);
    assert.throws(() => requestFacebookCampaignExecution(setup.database, setup.campaignId, {
      idempotencyKey: key,
      expectedRevision: confirmed.expectedRevision,
      expectedAccount: confirmed.expectedAccount,
      expectedAssignmentId: confirmed.assignmentId,
      expectedPostId: confirmed.postId,
      expectedDeviceId: confirmed.deviceId,
      expectedPostUrl: confirmed.postUrl,
      expectedActions: confirmed.actions,
      expectedComment: confirmed.comment,
      expectedTargetText: "Otro contenido controlado",
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    }, ACCOUNT, ACCOUNT_RESOURCE_ID, POST_CONTAINER_RESOURCE_ID, POST_URL_RESOURCE_ID, COMMENT_COMPOSER_RESOURCE_ID, COMMENT_EDITOR_RESOURCE_ID, COMMENT_SUBMIT_RESOURCE_ID, COMMENT_RESULT_CONTAINER_RESOURCE_ID), IdempotencyConflictError);
  } finally {
    await setup.close();
  }
});

test("execution confirmation rejects a comment different from the reviewed version", async () => {
  const setup = await setupExecution({ like: false, comment: true });
  try {
    const request = executionRequest(setup);
    request.expectedComment = { ...request.expectedComment!, textHash: "0".repeat(64) };
    assert.throws(() => requestFacebookCampaignExecution(
      setup.database,
      setup.campaignId,
      request,
      ACCOUNT,
      ACCOUNT_RESOURCE_ID,
      POST_CONTAINER_RESOURCE_ID,
      POST_URL_RESOURCE_ID,
      COMMENT_COMPOSER_RESOURCE_ID,
      COMMENT_EDITOR_RESOURCE_ID,
      COMMENT_SUBMIT_RESOURCE_ID,
      COMMENT_RESULT_CONTAINER_RESOURCE_ID,
    ), /comentario cambio/i);
    assert.equal((setup.database.prepare("SELECT COUNT(*) AS total FROM jobs").get() as { total: number }).total, 0);
  } finally {
    await setup.close();
  }
});

test("execution confirmation binds the displayed account and effective URL", async () => {
  for (const changed of ["account", "url"] as const) {
    const setup = await setupExecution({ like: true, comment: false });
    try {
      const request = executionRequest(setup);
      if (changed === "account") request.expectedAccount = "Otra cuenta";
      else request.expectedPostUrl = "https://www.facebook.com/control/posts/otro";
      assert.throws(() => requestFacebookCampaignExecution(
        setup.database,
        setup.campaignId,
        request,
        ACCOUNT,
        ACCOUNT_RESOURCE_ID,
        POST_CONTAINER_RESOURCE_ID,
        POST_URL_RESOURCE_ID,
        COMMENT_COMPOSER_RESOURCE_ID,
        COMMENT_EDITOR_RESOURCE_ID,
        COMMENT_SUBMIT_RESOURCE_ID,
        COMMENT_RESULT_CONTAINER_RESOURCE_ID,
      ), changed === "account" ? /cuenta controlada cambio/i : /URL efectiva cambio/i);
      assert.equal((setup.database.prepare("SELECT COUNT(*) AS total FROM jobs").get() as { total: number }).total, 0);
    } finally {
      await setup.close();
    }
  }
});

test("resolves public controls before arming the effect boundary", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    const requested = requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    const mobile = mobileDriver({
      prepareLike: async () => {
        const action = setup.database.prepare(`
          SELECT status, checkpoint_id FROM assignment_action_results
          WHERE operation_id = ? AND action = 'like'
        `).get(requested.operation.id) as { status: string; checkpoint_id: string | null };
        assert.deepEqual(action, { status: "pending", checkpoint_id: null });
        return "resolved-like";
      },
      tapLike: async (_sessionId, elementId) => {
        assert.equal(elementId, "resolved-like");
        const action = setup.database.prepare(`
          SELECT status, checkpoint_id FROM assignment_action_results
          WHERE operation_id = ? AND action = 'like'
        `).get(requested.operation.id) as { status: string; checkpoint_id: string | null };
        assert.equal(action.status, "effect_possible");
        assert.ok(action.checkpoint_id);
      },
      readLikeState: (() => {
        let reads = 0;
        return async () => reads++ > 0;
      })(),
    });
    assert.equal((await runClaimed(setup, mobile.driver)).job.status, "succeeded");
  } finally {
    await setup.close();
  }
});

test("recovery terminalizes interrupted execution state before and after confirmed effects", async () => {
  for (const effectConfirmed of [false, true]) {
    const setup = await setupExecution({ like: true, comment: false });
    try {
      const requested = requestExecution(setup);
      claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
      claimNextJob(setup.database, OWNER);
      setup.database.prepare("UPDATE assignments SET status = 'running' WHERE id = ?").run(setup.assignmentId);
      if (effectConfirmed) {
        setup.database.prepare("UPDATE assignment_action_results SET status = 'confirmed', result = 'activated' WHERE operation_id = ?").run(requested.operation.id);
        setup.database.prepare("UPDATE jobs SET effect_phase = 'effect_confirmed' WHERE id = ?").run(requested.job.id);
        setup.database.prepare("UPDATE operations SET effect_phase = 'effect_confirmed' WHERE id = ?").run(requested.operation.id);
      }
      setup.database.prepare("DELETE FROM runtime_ownership").run();
      claimRuntimeOwnership(setup.database, "worker-2", 2, Date.now(), 60_000);
      recoverStaleJobs(setup.database, "worker-2");
      assert.equal(recoverFacebookExecutions(setup.database, "worker-2"), 1);
      const snapshot = getFacebookCampaignSnapshot(setup.database, setup.campaignId)!;
      assert.equal(snapshot.assignments[0].status, effectConfirmed ? "sent" : "failed");
      assert.equal(snapshot.posts[0].status, effectConfirmed ? "completed" : "partial_failed");
      assert.equal(recoverFacebookExecutions(setup.database, "worker-2"), 0);
    } finally {
      await setup.close();
    }
  }
});

test("recovery safely reschedules an interrupted pre-effect assignment with attempts left", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    const requested = requestExecution(setup);
    setup.database.prepare("UPDATE jobs SET max_attempts = 2 WHERE id = ?").run(requested.job.id);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    claimNextJob(setup.database, OWNER);
    setup.database.prepare("UPDATE assignments SET status = 'running' WHERE id = ?").run(setup.assignmentId);
    setup.database.prepare("DELETE FROM runtime_ownership").run();
    claimRuntimeOwnership(setup.database, "worker-2", 2, Date.now(), 60_000);

    assert.equal(recoverStaleJobs(setup.database, "worker-2"), 1);
    assert.equal(getJob(setup.database, requested.job.id)?.status, "pending");
    assert.equal(recoverFacebookExecutions(setup.database, "worker-2"), 1);
    assert.equal(getFacebookCampaignSnapshot(setup.database, setup.campaignId)?.assignments[0].status, "scheduled");
    assert.equal(claimNextJob(setup.database, "worker-2")?.attempts, 2);
  } finally {
    await setup.close();
  }
});

test("a process shutdown before an effect remains resumable instead of becoming operator cancellation", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    const requested = requestExecution(setup);
    setup.database.prepare("UPDATE jobs SET max_attempts = 2 WHERE id = ?").run(requested.job.id);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    const claimed = claimNextJob(setup.database, OWNER)!;
    const controller = new AbortController();
    const mobile = mobileDriver({
      openPost: async () => {
        controller.abort(new Error("Worker detenido"));
        throw controller.signal.reason;
      },
    });
    await assert.rejects(executeFacebookAssignment(setup.database, claimed.operationId!, OWNER, {
      adb: setup.adb,
      appium: setup.appium,
      mobile: mobile.driver,
      controlledAccount: ACCOUNT,
      controlledAccountResourceId: ACCOUNT_RESOURCE_ID,
      postContainerResourceId: POST_CONTAINER_RESOURCE_ID,
      postUrlResourceId: POST_URL_RESOURCE_ID,
      signal: controller.signal,
      artifactsPath: setup.directory,
    }), /Worker detenido/);
    assert.equal(getJob(setup.database, requested.job.id)?.status, "running");
    assert.equal(getFacebookCampaignSnapshot(setup.database, setup.campaignId)?.assignments[0].status, "running");

    setup.database.prepare("DELETE FROM runtime_ownership").run();
    claimRuntimeOwnership(setup.database, "worker-2", 2, Date.now(), 60_000);
    recoverStaleJobs(setup.database, "worker-2");
    recoverFacebookExecutions(setup.database, "worker-2");
    assert.equal(getJob(setup.database, requested.job.id)?.status, "pending");
    assert.equal(getFacebookCampaignSnapshot(setup.database, setup.campaignId)?.assignments[0].status, "scheduled");
  } finally {
    await setup.close();
  }
});

test("cancellation before and during an effect preserves the correct boundary", async () => {
  const before = await setupExecution({ like: true, comment: false });
  try {
    const requested = requestExecution(before);
    requestJobCancellation(before.database, requested.job.id);
    claimRuntimeOwnership(before.database, OWNER, 1, Date.now(), 60_000);
    assert.equal(claimNextJob(before.database, OWNER), null);
    assert.equal(getJob(before.database, requested.job.id)?.status, "cancelled");
  } finally {
    await before.close();
  }

  const during = await setupExecution({ like: true, comment: false });
  try {
    requestExecution(during);
    claimRuntimeOwnership(during.database, OWNER, 1, Date.now(), 60_000);
    let jobId = "";
    const mobile = mobileDriver({
      tapLike: async () => {
        requestJobCancellation(during.database, jobId);
        throw new Error("cancelado durante Like");
      },
    });
    const claimed = claimNextJob(during.database, OWNER)!;
    jobId = claimed.id;
    await assert.rejects(executeFacebookAssignment(during.database, claimed.operationId!, OWNER, {
      adb: during.adb,
      appium: during.appium,
      mobile: mobile.driver,
      controlledAccount: ACCOUNT,
      controlledAccountResourceId: ACCOUNT_RESOURCE_ID,
      postContainerResourceId: POST_CONTAINER_RESOURCE_ID,
      postUrlResourceId: POST_URL_RESOURCE_ID,
      commentComposerResourceId: COMMENT_COMPOSER_RESOURCE_ID,
      commentEditorResourceId: COMMENT_EDITOR_RESOURCE_ID,
      commentSubmitResourceId: COMMENT_SUBMIT_RESOURCE_ID,
      commentResultContainerResourceId: COMMENT_RESULT_CONTAINER_RESOURCE_ID,
      artifactsPath: during.directory,
    }));
    const failed = failJob(during.database, claimed.id, OWNER, "cancelado durante Like", 0, false);
    assert.equal(failed.status, "outcome_unknown");
    assert.equal(getFacebookCampaignSnapshot(during.database, during.campaignId)!.assignments[0].status, "outcome_unknown");
  } finally {
    await during.close();
  }
});

test("cancellation immediately after claim terminalizes campaign domain state", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    const requested = requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    const claimed = claimNextJob(setup.database, OWNER)!;
    requestJobCancellation(setup.database, claimed.id);
    setup.database.prepare("UPDATE assignments SET status = 'cancellation_requested' WHERE id = ?").run(setup.assignmentId);
    setup.database.prepare("UPDATE campaigns SET status = 'cancellation_requested' WHERE id = ?").run(setup.campaignId);
    await assert.rejects(executeFacebookAssignment(setup.database, claimed.operationId!, OWNER, {
      adb: setup.adb,
      appium: setup.appium,
      mobile: mobileDriver().driver,
      controlledAccount: ACCOUNT,
      controlledAccountResourceId: ACCOUNT_RESOURCE_ID,
      postContainerResourceId: POST_CONTAINER_RESOURCE_ID,
      postUrlResourceId: POST_URL_RESOURCE_ID,
    }), /Cancelacion solicitada/);
    assert.equal(failJob(setup.database, requested.job.id, OWNER, "Cancelacion solicitada", 0, false).status, "cancelled");
    const snapshot = getFacebookCampaignSnapshot(setup.database, setup.campaignId)!;
    assert.equal(snapshot.assignments[0].status, "cancelled");
    assert.equal(snapshot.posts[0].status, "cancelled");
    assert.equal(snapshot.status, "cancelled");
  } finally {
    await setup.close();
  }
});

test("cancellation during cleanup never downgrades a sent assignment", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    const requested = requestExecution(setup);
    claimRuntimeOwnership(setup.database, OWNER, 1, Date.now(), 60_000);
    claimNextJob(setup.database, OWNER);
    setup.database.prepare("UPDATE assignment_action_results SET status = 'confirmed', result = 'activated' WHERE operation_id = ?")
      .run(requested.operation.id);
    setup.database.prepare("UPDATE jobs SET effect_phase = 'effect_confirmed', result_json = '{\"domainCommitted\":true}' WHERE id = ?")
      .run(requested.job.id);
    setup.database.prepare("UPDATE operations SET effect_phase = 'effect_confirmed' WHERE id = ?").run(requested.operation.id);
    setup.database.prepare("UPDATE assignments SET status = 'sent' WHERE id = ?").run(setup.assignmentId);

    requestFacebookExecutionCancellation(setup.database, requested.job.id);
    assert.equal(getFacebookCampaignSnapshot(setup.database, setup.campaignId)?.assignments[0].status, "sent");
    assert.equal(completeJob(setup.database, requested.job.id, OWNER, { domainCommitted: true }).status, "succeeded");
  } finally {
    await setup.close();
  }
});

test("cleanup uncertainty is reflected independently in the campaign aggregate", async () => {
  const setup = await setupExecution({ like: true, comment: false });
  try {
    const requested = requestExecution(setup);
    setup.database.prepare("UPDATE assignments SET status = 'sent' WHERE id = ?").run(setup.assignmentId);
    setup.database.prepare("UPDATE operations SET cleanup_status = 'outcome_unknown' WHERE id = ?").run(requested.operation.id);
    assert.equal(reduceFacebookCampaignExecution(setup.database, setup.campaignId).status, "completed_with_issues");

    setup.database.prepare("UPDATE assignments SET status = 'cancelled' WHERE id = ?").run(setup.assignmentId);
    assert.equal(reduceFacebookCampaignExecution(setup.database, setup.campaignId).status, "cancelled_with_cleanup_errors");
  } finally {
    await setup.close();
  }
});
