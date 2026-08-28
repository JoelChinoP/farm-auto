import assert from "node:assert/strict";
import test from "node:test";

import {
  expandFacebookAllocations,
  facebookBatchSchema,
  facebookDraftsSchema,
  facebookReconcileSchema,
  normalizeContentUrl,
  normalizeFacebookUrls,
  normalizePhone,
  parseGeneratedDraftContent,
  sendDraftSchema,
  tiktokLiveTapTapSchema,
} from "../src/lib/schemas.ts";
import {
  extractAccessibleFacebookContext,
  findStoredFacebookContext,
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

test("normalizes an international phone without persisting formatting", () => {
  assert.equal(normalizePhone("+51 987 654 321"), "51987654321");
  assert.throws(() => normalizePhone("0123"));
  assert.throws(() => normalizePhone("not-a-number"));
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
  }).urls;
  assert.deepEqual(normalizeFacebookUrls(urls), [
    "https://www.facebook.com/share/p/first",
    "https://fb.watch/second/",
  ]);
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

test("extracts useful accessible Facebook text without duplicated controls", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <hierarchy>
      <node text="Facebook" content-desc="" />
      <node package="com.android.systemui" text="Notificación del sistema" content-desc="" />
      <node text="Autor del post" content-desc="Autor del post" />
      <node text="Añádelo como amigo para que sea aún más fácil compartir contenido." content-desc="" />
      <node text="Una idea &amp; un detalle concreto" content-desc="" />
      <node text="" content-desc="Descripción accesible de la imagen" />
      <node text="Detalles del reel" content-desc="" />
      <node text="47 reacciones" content-desc="" />
      <node text="Me gusta" content-desc="Like" />
    </hierarchy>`;
  assert.equal(
    extractAccessibleFacebookContext(xml),
    "Autor del post\nUna idea & un detalle concreto\nDescripción accesible de la imagen",
  );
});

test("finds a bounded Facebook context in nested GenFarmer storage", () => {
  assert.equal(
    findStoredFacebookContext([
      {
        data: {
          runId: "run-1",
          data: {
            outputType: "facebook-context-v1",
            context: "  Texto de la publicacion  ",
          },
        },
      },
    ]),
    "Texto de la publicacion",
  );
  assert.equal(
    findStoredFacebookContext({
      outputType: "unrelated-output",
      context: "No debe aceptarse",
    }),
    null,
  );
  assert.equal(
    findStoredFacebookContext({
      outputType: "facebook-context-v1",
      context: "x".repeat(1201),
    }),
    null,
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
