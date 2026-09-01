import assert from "node:assert/strict";
import test from "node:test";

import {
  approveDraftSchema,
  distributeFacebookDevices,
  draftInputSchema,
  expandFacebookAllocations,
  facebookBatchExecuteSchema,
  facebookBatchSchema,
  facebookDraftsSchema,
  facebookExecuteSchema,
  facebookExtractSchema,
  facebookReconcileSchema,
  normalizeContentUrl,
  normalizeFacebookUrls,
  parseGeneratedDraftContent,
  sendDraftSchema,
  tiktokLiveTapTapSchema,
} from "../src/lib/schemas.ts";
import {
  buildFacebookRotationPlan,
  getFacebookRoundDisposition,
  runFacebookRound,
} from "../src/lib/facebook-rotation.ts";
import {
  buildFacebookPostDescription,
  buildFacebookTargetMarker,
} from "../src/lib/facebook-context.ts";

test("accepts TikTok and Facebook HTTPS links", () => {
  assert.equal(
    normalizeContentUrl("tiktok", "https://www.tiktok.com/@demo/live#chat"),
    "https://www.tiktok.com/@demo/live",
  );
  assert.equal(
    normalizeContentUrl("facebook", "https://fb.watch/example/"),
    "https://fb.watch/example/",
  );
});

test("rejects mismatched, insecure, and unrelated links", () => {
  assert.throws(() =>
    normalizeContentUrl("tiktok", "https://www.facebook.com/video"),
  );
  assert.throws(() =>
    normalizeContentUrl("facebook", "http://www.facebook.com/video"),
  );
  assert.throws(() =>
    normalizeContentUrl("facebook", "https://facebook.com.example.test/video"),
  );
  assert.throws(() =>
    normalizeContentUrl("facebook", "https://user@facebook.com/video"),
  );
  assert.throws(() =>
    normalizeContentUrl("facebook", "https://facebook.com:444/video"),
  );
  assert.throws(() =>
    normalizeContentUrl(
      "facebook",
      "https://www.facebook.com/';input keyevent 26;'",
    ),
  );
});

test("validates strict TikTok Live tap-tap bounds", () => {
  const valid = {
    deviceId: "device-1",
    idempotencyKey: "00000000-0000-4000-8000-000000000000",
    url: "https://www.tiktok.com/@demo/live",
    tapRounds: 1,
    tapX: 0,
    tapY: 5000,
  };

  assert.deepEqual(tiktokLiveTapTapSchema.parse(valid), valid);
  assert.equal(
    tiktokLiveTapTapSchema.safeParse({ ...valid, tapRounds: 50 }).success,
    true,
  );
  for (const invalid of [
    { tapRounds: 0 },
    { tapRounds: 51 },
    { tapRounds: 1.5 },
    { tapX: -1 },
    { tapX: 5001 },
    { tapY: -1 },
    { tapY: 5001 },
    { tapY: 1.5 },
    { tapRounds: "1" },
    { unexpected: true },
  ]) {
    assert.equal(
      tiktokLiveTapTapSchema.safeParse({ ...valid, ...invalid }).success,
      false,
    );
  }
});

test("accepts only social drafts for TikTok and Facebook", () => {
  const valid = {
    kind: "social_comment",
    platform: "tiktok",
    context: "Contexto real de la publicación",
    intent: "Comentar el detalle principal",
    tone: "amable",
  };

  assert.equal(draftInputSchema.safeParse(valid).success, true);
  assert.equal(
    draftInputSchema.safeParse({ ...valid, kind: "message" }).success,
    false,
  );
  assert.equal(
    draftInputSchema.safeParse({ ...valid, platform: "unsupported" }).success,
    false,
  );
});

test("draft approval accepts only edited text", () => {
  assert.deepEqual(approveDraftSchema.parse({ text: "Comentario aprobado" }), {
    text: "Comentario aprobado",
  });
  assert.equal(
    approveDraftSchema.safeParse({
      text: "Comentario aprobado",
      unexpected: true,
    }).success,
    false,
  );
});

test("accepts an optional content URL when sending an approved draft", () => {
  assert.deepEqual(
    sendDraftSchema.parse({
      deviceId: "device-1",
      contentUrl: "https://www.tiktok.com/@demo/video/123",
    }),
    {
      deviceId: "device-1",
      contentUrl: "https://www.tiktok.com/@demo/video/123",
    },
  );
  assert.deepEqual(sendDraftSchema.parse({ deviceId: "device-1" }), {
    deviceId: "device-1",
  });
});

test("parses supported DeepSeek draft response formats", () => {
  assert.deepEqual(parseGeneratedDraftContent('{"text":"Comentario directo"}'), {
    text: "Comentario directo",
  });
  assert.deepEqual(
    parseGeneratedDraftContent('```json\n{"text":"Comentario cercado"}\n```'),
    { text: "Comentario cercado" },
  );
  assert.deepEqual(
    parseGeneratedDraftContent(
      'Resultado:\n{"text":"Comentario dentro de una explicación"}',
    ),
    { text: "Comentario dentro de una explicación" },
  );
  assert.deepEqual(parseGeneratedDraftContent("Comentario breve sin JSON"), {
    text: "Comentario breve sin JSON",
  });
});

test("rejects malformed or oversized DeepSeek draft responses", () => {
  assert.equal(parseGeneratedDraftContent("```json\n{invalid}\n```"), null);
  assert.equal(parseGeneratedDraftContent("x"), null);
  assert.equal(parseGeneratedDraftContent("x".repeat(501)), null);
});

test("normalizes and deduplicates an ordered Facebook URL batch", () => {
  const urls = facebookBatchSchema.parse({
    urls: [
      "https://www.facebook.com/share/p/first#comments",
      "https://www.facebook.com/share/p/first",
      "https://fb.watch/second/",
    ],
    deviceIds: ["device-a", "device-b"],
  }).urls;
  assert.deepEqual(normalizeFacebookUrls(urls), [
    "https://www.facebook.com/share/p/first",
    "https://fb.watch/second/",
  ]);
});

test("distributes every Facebook device once across balanced link groups", () => {
  const deviceIds = Array.from({ length: 10 }, (_, index) => `device-${index + 1}`);
  const groups = distributeFacebookDevices(deviceIds, 3);
  assert.deepEqual(groups.map((group) => group.length), [4, 3, 3]);
  assert.deepEqual(groups.flat(), deviceIds);
  assert.throws(() => distributeFacebookDevices(["device-a", "device-a"], 1));
  assert.deepEqual(distributeFacebookDevices(["device-a"], 2), [["device-a"], []]);
  assert.throws(() => distributeFacebookDevices([], 2));
});

test("rotates one Facebook device through every link", () => {
  const plan = buildFacebookRotationPlan(
    distributeFacebookDevices(["device-a"], 2),
  );
  assert.deepEqual(plan, [
    { postPosition: 0, deviceId: "device-a", roundIndex: 0, sequenceIndex: 0 },
    { postPosition: 1, deviceId: "device-a", roundIndex: 1, sequenceIndex: 0 },
  ]);
});

test("builds a complete Facebook rotation without device conflicts", () => {
  const deviceIds = ["device-a", "device-b", "device-c", "device-d"];
  const plan = buildFacebookRotationPlan(
    distributeFacebookDevices(deviceIds, 3),
  );

  assert.equal(plan.length, 12);
  assert.equal(
    new Set(plan.map((slot) => `${slot.postPosition}:${slot.deviceId}`)).size,
    12,
  );
  for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
    const round = plan.filter((slot) => slot.roundIndex === roundIndex);
    assert.deepEqual(
      new Set(round.map((slot) => slot.deviceId)),
      new Set(deviceIds),
    );
  }
  assert.deepEqual(
    plan.filter((slot) => slot.roundIndex === 1).map((slot) => ({
      post: slot.postPosition,
      device: slot.deviceId,
    })),
    [
      { post: 0, device: "device-d" },
      { post: 1, device: "device-a" },
      { post: 1, device: "device-b" },
      { post: 2, device: "device-c" },
    ],
  );
});

test("runs Facebook links in parallel and devices sequentially per link", async () => {
  let releaseFirstLane!: () => void;
  const firstLaneGate = new Promise<void>((resolve) => {
    releaseFirstLane = resolve;
  });
  const events: string[] = [];

  await runFacebookRound(
    [["link-a-1", "link-a-2"], ["link-b-1"]],
    async (item) => {
      events.push(`start:${item}`);
      if (item === "link-a-1") await firstLaneGate;
      if (item === "link-b-1") releaseFirstLane();
      events.push(`end:${item}`);
    },
    async () => {
      events.push("pause");
    },
  );

  assert.ok(events.indexOf("start:link-b-1") < events.indexOf("end:link-a-1"));
  assert.ok(events.indexOf("end:link-a-1") < events.indexOf("start:link-a-2"));
  assert.equal(events.filter((event) => event === "pause").length, 1);
});

test("blocks a Facebook round for retries or uncertain outcomes", () => {
  assert.equal(getFacebookRoundDisposition(["sent", "sent"]), "complete");
  assert.equal(getFacebookRoundDisposition(["sent", "failed"]), "failed");
  assert.equal(getFacebookRoundDisposition(["sent", "approved"]), "retryable");
  assert.equal(
    getFacebookRoundDisposition(["approved", "outcome_unknown"]),
    "outcome_unknown",
  );
  assert.throws(() => getFacebookRoundDisposition([]));
});

test("validates the random delay range for Facebook comments", () => {
  assert.equal(
    facebookExecuteSchema.safeParse({ minDelaySeconds: 15, maxDelaySeconds: 45 })
      .success,
    true,
  );
  assert.equal(
    facebookExecuteSchema.safeParse({ minDelaySeconds: 60, maxDelaySeconds: 10 })
      .success,
    false,
  );
  assert.equal(
    facebookExecuteSchema.safeParse({ minDelaySeconds: 0, maxDelaySeconds: 10 })
      .success,
    false,
  );
  assert.equal(
    facebookBatchExecuteSchema.safeParse({
      minDelaySeconds: 15,
      maxDelaySeconds: 45,
      minRoundDelaySeconds: 60,
      maxRoundDelaySeconds: 120,
    }).success,
    true,
  );
  assert.equal(
    facebookBatchExecuteSchema.safeParse({
      minDelaySeconds: 15,
      maxDelaySeconds: 45,
      minRoundDelaySeconds: 120,
      maxRoundDelaySeconds: 60,
    }).success,
    false,
  );
});

test("requires an exact, unique Facebook device allocation", () => {
  const valid = {
    context: "Una publicación sobre agricultura sostenible.",
    deviceIds: ["device-a", "device-b", "device-c"],
    allocations: [
      { intent: "Opinar sobre la propuesta", tone: "casual" as const, count: 2 },
      { intent: "Hacer una pregunta concreta", tone: "curioso" as const, count: 1 },
    ],
  };
  assert.equal(facebookDraftsSchema.safeParse(valid).success, true);
  assert.equal(
    facebookDraftsSchema.safeParse({
      context: valid.context,
      deviceIds: ["device-a"],
      allocations: [
        {
          intent: "Desinformación o Error Factual",
          tone: "frio-cortante",
          count: 1,
        },
      ],
    }).success,
    true,
  );
  assert.equal(
    facebookDraftsSchema.safeParse({
      ...valid,
      deviceIds: ["device-a", "device-a", "device-c"],
    }).success,
    false,
  );
  assert.equal(
    facebookDraftsSchema.safeParse({
      ...valid,
      allocations: [{ ...valid.allocations[0], count: 1 }],
    }).success,
    false,
  );
  assert.deepEqual(expandFacebookAllocations(valid.deviceIds, valid.allocations), [
    { deviceId: "device-a", intent: "Opinar sobre la propuesta", tone: "casual" },
    { deviceId: "device-b", intent: "Opinar sobre la propuesta", tone: "casual" },
    { deviceId: "device-c", intent: "Hacer una pregunta concreta", tone: "curioso" },
  ]);
});

test("keeps only the Facebook post description", () => {
  assert.equal(
    buildFacebookPostDescription({
      messages: [
        "Hoy cosechamos las primeras fresas.",
        "Hoy cosechamos las primeras fresas.",
      ],
      metadata: "Log into Facebook to start sharing and connecting.",
    }),
    "Hoy cosechamos las primeras fresas.",
  );
  assert.equal(
    buildFacebookPostDescription({
      messages: [],
      metadata: "Descripción pública disponible en los metadatos.",
    }),
    "Descripción pública disponible en los metadatos.",
  );
  assert.equal(
    buildFacebookPostDescription({
      messages: [],
      metadata: "Log into Facebook to start sharing and connecting.",
    }),
    "",
  );
});

test("builds a normalized marker for fail-closed Facebook targeting", () => {
  assert.equal(
    buildFacebookTargetMarker("¡Cosecha de verano sostenible para toda la comunidad!"),
    "cosecha de verano sostenible para toda",
  );
  assert.equal(
    buildFacebookTargetMarker(
      "Fredy Apaza Zarate, candidato · Ver más\n🔥 GRAN MITIN Y APERTURA DE CAMPAÑA",
    ),
    "gran mitin apertura de campana",
  );
  assert.equal(buildFacebookTargetMarker("Muy bien"), null);
});

test("accepts only an empty request for server-side Facebook extraction", () => {
  assert.deepEqual(facebookExtractSchema.parse({}), {});
  assert.equal(
    facebookExtractSchema.safeParse({ deviceId: "device-a" }).success,
    false,
  );
});

test("requires one manual outcome per uncertain assignment", () => {
  const assignmentId = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    facebookReconcileSchema.safeParse({
      outcomes: [{ assignmentId, outcome: "sent" }],
    }).success,
    true,
  );
  assert.equal(
    facebookReconcileSchema.safeParse({
      outcomes: [
        { assignmentId, outcome: "sent" },
        { assignmentId, outcome: "not_sent" },
      ],
    }).success,
    false,
  );
});
