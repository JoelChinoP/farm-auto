import assert from "node:assert/strict";
import test from "node:test";

import type { CampaignDraft } from "../src/app/control-panel.types.ts";
import { buildAssignments, parseCampaignUrls, scheduleAssignments } from "../src/app/demo-state.ts";

function draft(urls: string[], devices: string[]): CampaignDraft {
  return {
    platform: "facebook",
    status: "draft",
    selectedDeviceIds: devices,
    urlInput: urls.join("\n"),
    urls,
    urlErrors: [],
    actions: { like: true, comment: true },
    distribution: [{ id: "intent", intention: "Afinidad", tone: "Cercano", count: devices.length }],
    posts: [],
    assignments: [],
    selectedPostId: null,
    scheduleStart: "now",
    scheduleDateTime: "",
    maxWaitMinutes: 30,
    scheduleStatus: "none",
    reviewGrouping: "post",
  };
}

test("validates URL count, host and duplicates", () => {
  assert.equal(parseCampaignUrls("", "facebook").urls.length, 0);
  assert.equal(parseCampaignUrls("https://facebook.com/post/1", "facebook").urls.length, 1);
  assert.equal(parseCampaignUrls(Array.from({ length: 10 }, (_, index) => `https://facebook.com/post/${index}`).join("\n"), "facebook").urls.length, 10);
  assert.match(parseCampaignUrls(Array.from({ length: 11 }, (_, index) => `https://facebook.com/post/${index}`).join("\n"), "facebook").errors[0].message, /Máximo 10/);
  assert.match(parseCampaignUrls("https://example.com/post", "facebook").errors[0].message, /Dominio/);
  assert.match(parseCampaignUrls("https://fb.watch/a\nhttps://fb.watch/a", "facebook").errors[0].message, /duplicada/);
});

test("builds the exact cartesian product and serializes each device schedule", () => {
  const source = draft(["https://facebook.com/post/1", "https://facebook.com/post/2", "https://facebook.com/post/3"], ["one", "two"]);
  const built = buildAssignments(source);
  assert.equal(built.assignments.length, 6);
  assert.equal(built.posts.flatMap((post) => post.comments).length, 6);

  const scheduled = scheduleAssignments({ ...source, ...built }, "2026-09-03T12:00:00.000Z");
  for (const deviceId of source.selectedDeviceIds) {
    const times = scheduled.filter((item) => item.deviceId === deviceId).map((item) => item.scheduledAt);
    assert.equal(new Set(times).size, source.urls.length);
  }
  assert.equal(scheduled[0].scheduledAt, scheduled[1].scheduledAt);
});
