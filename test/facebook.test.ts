import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type Database from "better-sqlite3";

import { isAllowedFacebookTargetRedirect, reelCaptionFromLines } from "../src/lib/facebook-browser.ts";
import { openDatabase } from "../src/lib/database.ts";
import {
  claimRuntimeOwnership,
  CURRENT_SETUP_REVISION,
  requestDeviceRetirement,
} from "../src/lib/device-runtime.ts";
import {
  assertFacebookCampaignDevicesEligible,
  createFacebookCampaign,
  editFacebookComment,
  editFacebookPostContext,
  extractFacebookPost,
  facebookContentKind,
  FacebookError,
  freezeFacebookCampaignManifest,
  generateFacebookComments,
  getFacebookCampaignSnapshot,
  normalizeFacebookUrl,
  parseGeneratedFacebookComments,
  recordFacebookDeviceIdentity,
  reduceFacebookCampaignExecution,
  requestFacebookCampaignSchedule,
  requestFacebookExecutionCancellation,
  requestFacebookPostOperation,
  restoreFacebookExtractedContext,
  validateFacebookCampaignRequest,
} from "../src/lib/facebook.ts";
import { createOperation, IdempotencyConflictError } from "../src/lib/operations.ts";
import { claimNextJob, completeJob, enqueueJob } from "../src/lib/queue.ts";

function addEligibleDevice(database: Database.Database, index: number) {
  const deviceId = `serial-${index}`;
  const hardwareId = index.toString(16).padStart(64, "0");
  database.prepare("INSERT INTO device_profiles VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(hardwareId, deviceId, `Equipo ${index}`, index, 8199 + index, 1, 1);
  database.prepare(`
    INSERT INTO device_observations (
      device_id, connection, hardware_id, packages_json, observed_at
    ) VALUES (?, 'connected', ?, '["com.facebook.katana"]', 1)
  `).run(deviceId, hardwareId);
  const operation = createOperation(database, {
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
  `).run(randomUUID(), deviceId, operation.id, CURRENT_SETUP_REVISION);
  return deviceId;
}

function campaignRequest(deviceIds: string[], comment = true) {
  return {
    urls: [
      "https://m.facebook.com/demo/posts/one?fbclid=tracking#comments",
      "https://fb.watch/two/",
    ],
    deviceIds,
    actions: { like: true, comment },
    distribution: comment
      ? [{ intention: "Afinidad con la publicacion", tone: "Cercano", count: deviceIds.length }]
      : [],
  };
}

function createCampaign(database: Database.Database, request: ReturnType<typeof campaignRequest>) {
  const operation = createOperation(database, {
    kind: "campaign.create",
    idempotencyKey: randomUUID(),
    request,
  }).operation;
  enqueueJob(database, "campaign.create", request, { operationId: operation.id, maxAttempts: 2 });
  return { operation, snapshot: createFacebookCampaign(database, operation.id, request) };
}

test("normalizes only safe Facebook URLs and detects canonical duplicates", () => {
  assert.deepEqual(normalizeFacebookUrl("https://m.facebook.com/post/1/?fbclid=x#comments"), {
    sourceUrl: "https://m.facebook.com/post/1/?fbclid=x",
    normalizedUrl: "https://www.facebook.com/post/1",
  });
  assert.equal(normalizeFacebookUrl("https://fb.watch/example/").normalizedUrl, "https://fb.watch/example");
  for (const invalid of [
    "http://facebook.com/post/1",
    "https://user@facebook.com/post/1",
    "https://facebook.com:444/post/1",
    "https://facebook.com.example.test/post/1",
    "https://sub.fb.watch/post/1",
    "https://facebook.com/'bad'",
    "https://facebook.com/\u0001bad",
  ]) {
    assert.throws(() => normalizeFacebookUrl(invalid), FacebookError);
  }
  assert.throws(() => validateFacebookCampaignRequest({
    ...campaignRequest(["device-1"]),
    urls: ["https://facebook.com/post/1", "https://www.facebook.com/post/1/"],
  }), (error) => error instanceof FacebookError && error.code === "DUPLICATE_FACEBOOK_URL");
});

test("allows official Facebook share links to resolve to identifiable canonical posts", () => {
  assert.equal(isAllowedFacebookTargetRedirect(
    "https://www.facebook.com/share/p/short-id/",
    "https://www.facebook.com/example/posts/canonical-id",
  ), true);
  assert.equal(isAllowedFacebookTargetRedirect(
    "https://www.facebook.com/share/r/short-id/",
    "https://www.facebook.com/reel/canonical-id",
  ), true);
  assert.equal(isAllowedFacebookTargetRedirect(
    "https://www.facebook.com/example/posts/one",
    "https://www.facebook.com/example/posts/two",
  ), false);
  assert.equal(facebookContentKind("https://www.facebook.com/reel/canonical-id"), "reel");
  assert.equal(facebookContentKind("https://www.facebook.com/example/posts/canonical-id"), "post");
  assert.equal(isAllowedFacebookTargetRedirect(
    "https://www.facebook.com/permalink.php?story_fbid=pfbidX&id=123",
    "https://www.facebook.com/share/p/canonical-id/",
  ), true);
  assert.equal(isAllowedFacebookTargetRedirect(
    "https://www.facebook.com/story.php?story_fbid=pfbidX&id=123",
    "https://www.facebook.com/example/posts/canonical-id",
  ), true);
  assert.equal(isAllowedFacebookTargetRedirect(
    "https://www.facebook.com/permalink.php?story_fbid=pfbidX&id=123",
    "https://www.facebook.com/",
  ), false);
});

test("extracts the caption from a reel player container", () => {
  const expanded = "Yoel Paya\n\uFEFFYoel Paya · Audio original\nLa delincuencia en el Perú ya no puede tratarse como un problema secundario. Extorsiones, robos y amenazas afectan diariamente a trabajadores, transportistas y pequeños negocios. La población necesita resultados concretos Ver menos";
  assert.equal(
    reelCaptionFromLines(expanded),
    "La delincuencia en el Perú ya no puede tratarse como un problema secundario. Extorsiones, robos y amenazas afectan diariamente a trabajadores, transportistas y pequeños negocios. La población necesita resultados concretos",
  );
  assert.equal(
    reelCaptionFromLines("Autor\nAutor · Audio original\nTexto corto… Ver más"),
    "Texto corto",
  );
  assert.equal(
    reelCaptionFromLines("Author\nAuthor · Original audio\nA short caption See less"),
    "A short caption",
  );
  assert.equal(reelCaptionFromLines("Sin cabecera de reel\nOtro texto"), "");
});

test("creates one stable post per URL and the exact post by device product", () => {
  const database = openDatabase(":memory:");
  try {
    const deviceIds = [addEligibleDevice(database, 1), addEligibleDevice(database, 2)];
    const { operation, snapshot } = createCampaign(database, campaignRequest(deviceIds));
    assert.ok(snapshot);
    assert.deepEqual(snapshot.posts.map((post) => post.position), [1, 2]);
    assert.equal(snapshot.assignments.length, 4);
    assert.equal(new Set(snapshot.assignments.map((item) => `${item.postId}:${item.deviceId}`)).size, 4);
    assert.equal(snapshot.posts.flatMap((post) => post.comments).length, 4);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM jobs WHERE kind = 'post.extract'").get() as { total: number }).total, 2);
    const creationJob = database.prepare("SELECT campaign_id, result_json FROM jobs WHERE operation_id = ?")
      .get(operation.id) as { campaign_id: string; result_json: string };
    assert.equal(creationJob.campaign_id, snapshot.id);
    assert.equal((JSON.parse(creationJob.result_json) as { domainCommitted: boolean }).domainCommitted, true);

    const replayed = createFacebookCampaign(database, operation.id, campaignRequest(deviceIds));
    assert.equal(replayed?.id, snapshot.id);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM campaigns").get() as { total: number }).total, 1);
  } finally {
    database.close();
  }
});

test("freezes an exact schedule and blocks duplicate Facebook accounts by default", () => {
  const database = openDatabase(":memory:");
  try {
    const deviceIds = [addEligibleDevice(database, 1), addEligibleDevice(database, 2)];
    const { snapshot } = createCampaign(database, campaignRequest(deviceIds, false));
    recordFacebookDeviceIdentity(database, deviceIds[0], "Cuenta Controlada", 10);
    recordFacebookDeviceIdentity(database, deviceIds[1], " cuenta   controlada ", 10);
    assert.throws(
      () => freezeFacebookCampaignManifest(database, snapshot!.id, 1_000),
      (error) => error instanceof FacebookError && error.code === "FACEBOOK_ACCOUNT_COLLISION",
    );

    recordFacebookDeviceIdentity(database, deviceIds[1], "Segunda cuenta", 20);
    const manifest = freezeFacebookCampaignManifest(database, snapshot!.id, 1_000);
    assert.equal(JSON.parse(String(manifest.posts_json)).length, 2);
    assert.equal(JSON.parse(String(manifest.devices_json)).length, 2);
    assert.equal(JSON.parse(String(manifest.assignments_json)).length, 4);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM schedules").get() as { total: number }).total, 4);
    assert.equal(getFacebookCampaignSnapshot(database, snapshot!.id)?.status, "scheduled");
    assert.ok(getFacebookCampaignSnapshot(database, snapshot!.id)?.assignments.every((assignment) => assignment.status === "scheduled"));
    assert.throws(
      () => database.prepare("UPDATE facebook_campaign_manifests SET scheduled_at = 2 WHERE campaign_id = ?").run(snapshot!.id),
      /inmutable/,
    );
  } finally {
    database.close();
  }
});

test("blocks the same Facebook account across active campaigns without an explicit decision", () => {
  const database = openDatabase(":memory:");
  try {
    const first = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)], false)).snapshot!;
    const second = createCampaign(database, campaignRequest([addEligibleDevice(database, 2)], false)).snapshot!;
    const schedule = (snapshot: NonNullable<typeof first>, allowSharedAccounts = false) => ({
      idempotencyKey: randomUUID(),
      expectedRevision: snapshot.revision,
      scheduledAt: Date.now(),
      expectedActions: snapshot.actions,
      assignments: snapshot.assignments.map((assignment) => {
        const post = snapshot.posts.find((item) => item.id === assignment.postId)!;
        return {
          assignmentId: assignment.id,
          postId: post.id,
          deviceId: assignment.deviceId,
          expectedAccount: "Cuenta compartida",
          expectedPostUrl: post.finalUrl ?? post.url,
          expectedTargetText: `Contenido controlado ${post.position}`,
          expectedComment: null,
        };
      }),
      allowSharedAccounts,
      sharedAccountsConfirmed: allowSharedAccounts,
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    });
    requestFacebookCampaignSchedule(database, first.id, schedule(first), "account-id", "post-id", "post-url-id");
    assert.throws(
      () => requestFacebookCampaignSchedule(database, second.id, schedule(second), "account-id", "post-id", "post-url-id"),
      (error) => error instanceof FacebookError && error.code === "FACEBOOK_ACCOUNT_COLLISION",
    );
    assert.doesNotThrow(() => requestFacebookCampaignSchedule(database, second.id, schedule(second, true), "account-id", "post-id", "post-url-id"));
  } finally {
    database.close();
  }
});

test("reduces post and campaign execution state across every assignment", () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([
      addEligibleDevice(database, 1),
      addEligibleDevice(database, 2),
    ], false));
    const assignments = snapshot!.assignments;
    database.prepare("UPDATE assignments SET status = 'running' WHERE id = ?").run(assignments[0].id);
    let reduced = reduceFacebookCampaignExecution(database, snapshot!.id, 100);
    assert.equal(reduced.status, "running");
    assert.deepEqual(reduced.posts.map((post) => post.status), ["running", "ready"]);

    database.prepare("UPDATE assignments SET status = 'sent' WHERE id IN (?, ?)")
      .run(assignments[0].id, assignments[1].id);
    reduced = reduceFacebookCampaignExecution(database, snapshot!.id, 200);
    assert.equal(reduced.status, "running");
    assert.deepEqual(reduced.posts.map((post) => post.status), ["completed", "ready"]);

    database.prepare("UPDATE assignments SET status = 'failed' WHERE id = ?").run(assignments[2].id);
    reduced = reduceFacebookCampaignExecution(database, snapshot!.id, 300);
    assert.equal(reduced.status, "running");
    assert.equal(reduced.posts[1].status, "running");

    database.prepare("UPDATE assignments SET status = 'cancelled' WHERE id = ?").run(assignments[3].id);
    reduced = reduceFacebookCampaignExecution(database, snapshot!.id, 400);
    assert.equal(reduced.status, "completed_with_issues");
    assert.equal(reduced.posts[1].status, "partial_failed");
  } finally {
    database.close();
  }
});

test("schedules one job per assignment and claims posts in order on each device", () => {
  const database = openDatabase(":memory:");
  try {
    const deviceIds = [addEligibleDevice(database, 1), addEligibleDevice(database, 2)];
    const { snapshot } = createCampaign(database, campaignRequest(deviceIds, false));
    const now = Date.now();
    const request = {
      idempotencyKey: randomUUID(),
      expectedRevision: snapshot!.revision,
      scheduledAt: now,
      expectedActions: snapshot!.actions,
      assignments: snapshot!.assignments.map((assignment) => {
        const post = snapshot!.posts.find((item) => item.id === assignment.postId)!;
        return {
          assignmentId: assignment.id,
          postId: post.id,
          deviceId: assignment.deviceId,
          expectedAccount: `Cuenta ${assignment.deviceId}`,
          expectedPostUrl: post.finalUrl ?? post.url,
          expectedTargetText: `Contenido controlado ${post.position}`,
          expectedComment: null,
        };
      }),
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    };
    const scheduled = requestFacebookCampaignSchedule(
      database,
      snapshot!.id,
      request,
      "account-id",
      "post-id",
      "post-url-id",
    );
    assert.equal(scheduled.replayed, false);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM jobs WHERE kind = 'assignment.execute'").get() as { total: number }).total, 4);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM schedules WHERE status = 'pending'").get() as { total: number }).total, 4);
    assert.deepEqual(
      database.prepare("SELECT DISTINCT max_attempts FROM jobs WHERE kind = 'assignment.execute'").all(),
      [{ max_attempts: 2 }],
    );
    assert.equal(requestFacebookCampaignSchedule(
      database,
      snapshot!.id,
      request,
      "account-id",
      "post-id",
      "post-url-id",
    ).replayed, true);
    const changedRequest = structuredClone(request);
    changedRequest.assignments[1].expectedTargetText = "Otro contenido controlado";
    assert.throws(() => requestFacebookCampaignSchedule(
      database,
      snapshot!.id,
      changedRequest,
      "account-id",
      "post-id",
      "post-url-id",
    ), IdempotencyConflictError);
    database.prepare("DELETE FROM jobs WHERE kind != 'assignment.execute'").run();

    claimRuntimeOwnership(database, "worker", 1, now, 60_000);
    const first = claimNextJob(database, "worker", now + 1)!;
    const second = claimNextJob(database, "worker", now + 1)!;
    assert.equal(first.postId, snapshot!.posts[0].id);
    assert.equal(second.postId, snapshot!.posts[0].id);
    assert.notEqual(first.payload && (first.payload as { deviceId: string }).deviceId, (second.payload as { deviceId: string }).deviceId);
    assert.equal(claimNextJob(database, "worker", now + 1), null);

    completeJob(database, first.id, "worker", {});
    const third = claimNextJob(database, "worker", now + 2)!;
    assert.equal((third.payload as { deviceId: string }).deviceId, (first.payload as { deviceId: string }).deviceId);
    assert.equal(third.postId, snapshot!.posts[1].id);
  } finally {
    database.close();
  }
});

test("persists the maximum 10-post cartesian plan without dropping assignments", () => {
  const database = openDatabase(":memory:");
  try {
    const deviceIds = [addEligibleDevice(database, 1), addEligibleDevice(database, 2), addEligibleDevice(database, 3)];
    const request = campaignRequest(deviceIds, false);
    request.urls = Array.from({ length: 10 }, (_, index) => `https://www.facebook.com/control/posts/${index + 1}`);
    const { snapshot } = createCampaign(database, request);
    const scheduledAt = Date.now();
    requestFacebookCampaignSchedule(database, snapshot!.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: snapshot!.revision,
      scheduledAt,
      expectedActions: snapshot!.actions,
      assignments: snapshot!.assignments.map((assignment) => {
        const post = snapshot!.posts.find((item) => item.id === assignment.postId)!;
        return {
          assignmentId: assignment.id,
          postId: post.id,
          deviceId: assignment.deviceId,
          expectedAccount: `Cuenta ${assignment.deviceId}`,
          expectedPostUrl: post.finalUrl ?? post.url,
          expectedTargetText: `Contenido controlado ${post.position}`,
          expectedComment: null,
        };
      }),
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    }, "account-id", "post-id", "post-url-id");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM assignments WHERE campaign_id = ?").get(snapshot!.id) as { total: number }).total, 30);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM schedules").get() as { total: number }).total, 30);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM jobs WHERE kind = 'assignment.execute'").get() as { total: number }).total, 30);
  } finally {
    database.close();
  }
});

test("individual cancellation preserves other work while global cancellation blocks new claims", () => {
  const database = openDatabase(":memory:");
  try {
    const now = Date.now();
    const deviceIds = [addEligibleDevice(database, 1), addEligibleDevice(database, 2)];
    const { snapshot } = createCampaign(database, campaignRequest(deviceIds, false));
    requestFacebookCampaignSchedule(database, snapshot!.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: snapshot!.revision,
      scheduledAt: now,
      expectedActions: snapshot!.actions,
      assignments: snapshot!.assignments.map((assignment) => {
        const post = snapshot!.posts.find((item) => item.id === assignment.postId)!;
        return {
          assignmentId: assignment.id,
          postId: post.id,
          deviceId: assignment.deviceId,
          expectedAccount: `Cuenta ${assignment.deviceId}`,
          expectedPostUrl: post.finalUrl ?? post.url,
          expectedTargetText: `Contenido controlado ${post.position}`,
          expectedComment: null,
        };
      }),
      confirmed: true,
      controlledAccount: true,
      controlledContent: true,
    }, "account-id", "post-id", "post-url-id");
    database.prepare("DELETE FROM jobs WHERE kind != 'assignment.execute'").run();
    const jobs = database.prepare(`
      SELECT j.id FROM jobs j JOIN assignments a ON a.id = j.assignment_id
      JOIN posts p ON p.id = a.post_id ORDER BY p.position, a.device_id
    `).all() as Array<{ id: string }>;

    requestFacebookExecutionCancellation(database, jobs[0].id, { now: now + 1 });
    assert.equal(getFacebookCampaignSnapshot(database, snapshot!.id)?.status, "running");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM jobs WHERE status = 'pending'").get() as { total: number }).total, 3);

    requestFacebookExecutionCancellation(database, jobs[1].id, { global: true, now: now + 2 });
    claimRuntimeOwnership(database, "worker", 1, now + 2, 60_000);
    assert.equal(claimNextJob(database, "worker", now + 3), null);
    assert.equal(getFacebookCampaignSnapshot(database, snapshot!.id)?.status, "cancellation_requested");
  } finally {
    database.close();
  }
});

test("retires an idle device immediately and an occupied device after its queued work", () => {
  const database = openDatabase(":memory:");
  try {
    const idleDevice = addEligibleDevice(database, 1);
    assert.equal(requestDeviceRetirement(database, idleDevice, 10).status, "completed");
    assert.throws(
      () => assertFacebookCampaignDevicesEligible(database, [idleDevice]),
      (error) => error instanceof FacebookError && error.code === "DEVICE_RETIRED",
    );

    const busyDevice = addEligibleDevice(database, 2);
    const operation = createOperation(database, {
      kind: "device.prepare",
      idempotencyKey: randomUUID(),
      request: { deviceId: busyDevice },
      deviceId: busyDevice,
    }).operation;
    const job = enqueueJob(database, "device.prepare", { deviceId: busyDevice }, { operationId: operation.id });
    assert.equal(requestDeviceRetirement(database, busyDevice, 20).status, "pending");
    const now = Date.now();
    claimRuntimeOwnership(database, "worker", 1, now, 60_000);
    claimNextJob(database, "worker", now);
    completeJob(database, job.id, "worker", {});
    assert.equal((database.prepare("SELECT status FROM device_retirements WHERE device_id = ?").get(busyDevice) as { status: string }).status, "completed");
  } finally {
    database.close();
  }
});

test("does not create context, comments, or extraction work when comments are disabled", () => {
  const database = openDatabase(":memory:");
  try {
    const request = campaignRequest([addEligibleDevice(database, 1)], false);
    const { snapshot } = createCampaign(database, request);
    assert.equal(snapshot?.status, "ready");
    assert.equal(snapshot?.posts[0].context, "");
    assert.equal(snapshot?.posts.flatMap((post) => post.comments).length, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM jobs WHERE kind = 'post.extract'").get() as { total: number }).total, 0);
  } finally {
    database.close();
  }
});

test("prepares a share-only campaign with resolved targets and no comments", async () => {
  const database = openDatabase(":memory:");
  try {
    const request = {
      ...campaignRequest([addEligibleDevice(database, 1)], false),
      actions: { like: false, comment: false, share: true },
    };
    const { snapshot } = createCampaign(database, request);
    assert.deepEqual(snapshot?.actions, { like: false, comment: false, share: true });
    assert.equal(snapshot?.status, "preparing");
    assert.equal(snapshot?.posts[0].context, "");
    assert.equal(snapshot?.posts.flatMap((post) => post.comments).length, 0);
    assert.equal((database.prepare("SELECT share_enabled FROM campaigns").get() as { share_enabled: number }).share_enabled, 1);
    const extractions = database.prepare(`
      SELECT o.id, o.post_id
      FROM operations o JOIN posts p ON p.id = o.post_id
      WHERE o.kind = 'post.extract'
      ORDER BY p.position
    `)
      .all() as Array<{ id: string; post_id: string }>;
    assert.equal(extractions.length, 2);
    for (const [index, extraction] of extractions.entries()) {
      await extractFacebookPost(database, extraction.id, {
        extract: async () => ({
          context: `Contenido verificado ${index + 1} para compartir de forma controlada.`,
          finalUrl: index === 0
            ? "https://www.facebook.com/reel/canonical-id"
            : "https://www.facebook.com/example/posts/canonical-id",
          contentKind: index === 0 ? "reel" : "post",
          extractorVersion: "test-v1",
        }),
      });
    }
    const prepared = getFacebookCampaignSnapshot(database, snapshot!.id)!;
    assert.equal(prepared.status, "ready");
    assert.deepEqual(prepared.posts.map((post) => post.contentKind), ["reel", "post"]);
    assert.ok(prepared.posts.every((post) => post.finalUrl && post.context.length >= 5));
    assert.ok(prepared.assignments.every((assignment) => assignment.status === "draft"));
    assert.equal(prepared.posts.flatMap((post) => post.comments).length, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM jobs WHERE kind = 'comments.generate'").get() as { total: number }).total, 0);
  } finally {
    database.close();
  }
});

test("persists extracted context, final URL, history, and queues one generation per post", async () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)]));
    const post = snapshot!.posts[0];
    const extraction = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'post.extract'")
      .get(post.id) as { id: string };
    let extractionCalls = 0;
    const updated = await extractFacebookPost(database, extraction.id, {
      extract: async () => {
        extractionCalls++;
        return {
        context: "Una publicacion completa sobre una cosecha sostenible.",
        finalUrl: "https://www.facebook.com/demo/posts/one",
        extractorVersion: "test-v1",
        };
      },
    });
    assert.equal(updated.posts[0].contextStatus, "ready");
    assert.equal(updated.posts[0].finalUrl, "https://www.facebook.com/demo/posts/one");
    assert.equal(updated.posts[0].contextVersion, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM post_context_versions").get() as { total: number }).total, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM operations WHERE post_id = ? AND kind = 'comments.generate'").get(post.id) as { total: number }).total, 1);
    database.prepare("UPDATE operations SET result_json = NULL WHERE id = ?").run(extraction.id);
    await extractFacebookPost(database, extraction.id, {
      extract: async () => { throw new Error("no debe repetirse"); },
    });
    assert.equal(extractionCalls, 1);
  } finally {
    database.close();
  }
});

test("distinguishes a missing Facebook session from a technical extraction failure", async () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)]));
    const post = snapshot!.posts[0];
    const extraction = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'post.extract'")
      .get(post.id) as { id: string };
    await assert.rejects(extractFacebookPost(database, extraction.id, {
      extract: async () => { throw new FacebookError("FACEBOOK_SESSION_REQUIRED", "Login manual requerido", 409); },
    }));
    assert.equal(getFacebookCampaignSnapshot(database, snapshot!.id)?.posts[0].contextStatus, "session_required");
  } finally {
    database.close();
  }
});

test("validates assignment-tagged DeepSeek JSON before persisting the complete response", async () => {
  assert.throws(() => parseGeneratedFacebookComments(
    '{"comments":[{"assignmentId":"a","text":"un texto valido con cinco palabras"}]}',
    ["a", "b"],
    5,
    15,
  ), FacebookError);

  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1), addEligibleDevice(database, 2)]));
    const post = snapshot!.posts[0];
    const extraction = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'post.extract'")
      .get(post.id) as { id: string };
    const extracted = await extractFacebookPost(database, extraction.id, {
      extract: async () => ({ context: "Contexto suficiente para generar respuestas relacionadas.", finalUrl: post.url, extractorVersion: "test" }),
    });
    const generation = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'comments.generate'")
      .get(post.id) as { id: string };
    const assignmentIds = extracted.posts[0].comments.map((comment) => comment.assignmentId);
    let requests = 0;
    const generated = await generateFacebookComments(database, generation.id, async () => {
      requests++;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ comments: [
        { assignmentId: assignmentIds[1], text: "Esta segunda respuesta comenta claramente la publicacion" },
        { assignmentId: assignmentIds[0], text: "Esta primera respuesta aporta una opinion relacionada" },
      ] }) } }] });
    }, undefined, "test-key");
    assert.equal(requests, 1);
    assert.equal(generated.posts[0].status, "ready");
    assert.deepEqual(new Set(generated.posts[0].comments.map((comment) => comment.assignmentId)), new Set(assignmentIds));
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM comments").get() as { total: number }).total, 6);
    database.prepare("UPDATE operations SET result_json = NULL WHERE id = ?").run(generation.id);
    await generateFacebookComments(database, generation.id, async () => {
      requests++;
      throw new Error("no debe repetirse");
    }, undefined, "test-key");
    assert.equal(requests, 1);
  } finally {
    database.close();
  }
});

test("discards a DeepSeek response when cancellation arrives before persistence", async () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)]));
    const post = snapshot!.posts[0];
    const extraction = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'post.extract'")
      .get(post.id) as { id: string };
    const extracted = await extractFacebookPost(database, extraction.id, {
      extract: async () => ({ context: "Contexto valido antes de cancelar la respuesta.", finalUrl: post.url, extractorVersion: "test" }),
    });
    const generation = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'comments.generate'")
      .get(post.id) as { id: string };
    const assignmentId = extracted.posts[0].comments[0].assignmentId;
    const before = (database.prepare("SELECT COUNT(*) AS total FROM comments").get() as { total: number }).total;
    await assert.rejects(generateFacebookComments(database, generation.id, async () => {
      database.prepare("UPDATE jobs SET cancellation_requested_at = ? WHERE operation_id = ?")
        .run(Date.now(), generation.id);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ comments: [
        { assignmentId, text: "Esta respuesta valida nunca debe quedar persistida" },
      ] }) } }] });
    }, undefined, "test-key"), (error) => error instanceof DOMException && error.name === "AbortError");
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM comments").get() as { total: number }).total, before);
    const cancelled = getFacebookCampaignSnapshot(database, snapshot!.id)!.posts[0];
    assert.equal(cancelled.status, "context_ready");
    assert.equal(cancelled.comments[0].status, "failed");
    assert.equal(cancelled.comments[0].stale, true);
  } finally {
    database.close();
  }
});

test("manual context changes are versioned and make generated comments stale", async () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)]));
    const post = snapshot!.posts[0];
    const extraction = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'post.extract'")
      .get(post.id) as { id: string };
    await extractFacebookPost(database, extraction.id, {
      extract: async () => ({ context: "Contexto original completo para esta publicacion.", finalUrl: post.url, extractorVersion: "test" }),
    });
    const edited = editFacebookPostContext(database, snapshot!.id, post.id, "Contexto manual corregido por el operador.");
    assert.equal(edited.posts[0].contextSource, "manual");
    assert.equal(edited.posts[0].contextVersion, 2);
    assert.ok(edited.posts[0].comments.every((comment) => comment.stale));
    assert.equal((database.prepare("SELECT COUNT(*) AS total FROM post_context_versions WHERE post_id = ?").get(post.id) as { total: number }).total, 2);
  } finally {
    database.close();
  }
});

test("manual comments require explicit overwrite confirmation", async () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)]));
    const post = snapshot!.posts[0];
    const extraction = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'post.extract'")
      .get(post.id) as { id: string };
    const extracted = await extractFacebookPost(database, extraction.id, {
      extract: async () => ({ context: "Contexto completo para editar un comentario.", finalUrl: post.url, extractorVersion: "test" }),
    });
    const pendingComment = extracted.posts[0].comments[0];
    const edited = editFacebookComment(database, pendingComment.id, {
      text: "Este comentario manual tiene suficientes palabras ahora",
      intention: pendingComment.intention,
      tone: pendingComment.tone,
    });
    assert.equal(edited.posts[0].comments[0].source, "manual");
    assert.equal(edited.posts[0].comments[0].status, "edited");
    assert.throws(() => requestFacebookPostOperation(database, {
      postId: post.id,
      kind: "comments.generate",
      idempotencyKey: randomUUID(),
    }), (error) => error instanceof FacebookError && error.code === "MANUAL_COMMENTS_PRESENT");
    assert.doesNotThrow(() => requestFacebookPostOperation(database, {
      postId: post.id,
      kind: "comments.generate",
      idempotencyKey: randomUUID(),
      overwriteManual: true,
    }));
  } finally {
    database.close();
  }
});

test("persists intention and tone changes before the first generated text", () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)]));
    const comment = snapshot!.posts[0].comments[0];
    const edited = editFacebookComment(database, comment.id, {
      text: "",
      intention: "Hacer una pregunta concreta",
      tone: "Informativo",
    }).posts[0].comments[0];
    assert.equal(edited.text, "");
    assert.equal(edited.intention, "Hacer una pregunta concreta");
    assert.equal(edited.tone, "Informativo");
    assert.equal(edited.stale, true);
  } finally {
    database.close();
  }
});

test("a failed extraction preserves context saved while the browser was running", async () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)]));
    const post = snapshot!.posts[0];
    const extraction = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'post.extract'")
      .get(post.id) as { id: string };
    let rejectExtraction!: (error: Error) => void;
    const running = extractFacebookPost(database, extraction.id, {
      extract: () => new Promise((_resolve, reject) => { rejectExtraction = reject; }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    editFacebookPostContext(database, snapshot!.id, post.id, "Contexto manual guardado durante la extraccion.");
    rejectExtraction(new Error("fallo tecnico"));
    await assert.rejects(running);
    const preserved = getFacebookCampaignSnapshot(database, snapshot!.id)!.posts[0];
    assert.equal(preserved.context, "Contexto manual guardado durante la extraccion.");
    assert.equal(preserved.contextStatus, "edited");
    assert.equal(preserved.status, "context_ready");
  } finally {
    database.close();
  }
});

test("restoring extracted context creates a new version and invalidates old comments", async () => {
  const database = openDatabase(":memory:");
  try {
    const { snapshot } = createCampaign(database, campaignRequest([addEligibleDevice(database, 1)]));
    const post = snapshot!.posts[0];
    const extraction = database.prepare("SELECT id FROM operations WHERE post_id = ? AND kind = 'post.extract'")
      .get(post.id) as { id: string };
    await extractFacebookPost(database, extraction.id, {
      extract: async () => ({ context: "Contexto extraido que luego sera restaurado.", finalUrl: post.url, extractorVersion: "test" }),
    });
    editFacebookPostContext(database, snapshot!.id, post.id, "Contexto manual temporal para la publicacion.");
    const restored = restoreFacebookExtractedContext(database, snapshot!.id, post.id).posts[0];
    assert.equal(restored.context, "Contexto extraido que luego sera restaurado.");
    assert.equal(restored.contextSource, "extracted");
    assert.equal(restored.contextVersion, 3);
    assert.ok(restored.comments.every((comment) => comment.stale));
  } finally {
    database.close();
  }
});
