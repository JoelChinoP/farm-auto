import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeContentUrl,
  normalizePhone,
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

test("normalizes an international phone without persisting formatting", () => {
  assert.equal(normalizePhone("+51 987 654 321"), "51987654321");
  assert.throws(() => normalizePhone("0123"));
  assert.throws(() => normalizePhone("not-a-number"));
});
