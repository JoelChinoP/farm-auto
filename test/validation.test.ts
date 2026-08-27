import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeContentUrl,
  normalizePhone,
  parseGeneratedDraftContent,
  sendDraftSchema,
  tiktokLiveTapTapSchema,
} from "../src/lib/schemas.ts";

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
