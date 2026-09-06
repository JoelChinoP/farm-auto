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

test("accepts 1-10 TikTok posts and builds the exact 2-post by 5-device plan", () => {
  const urls = Array.from({ length: 11 }, (_, index) => `https://www.tiktok.com/@controlled/video/${index + 1}`);
  for (const count of [1, 2, 10]) {
    assert.deepEqual(parseCampaignUrls(urls.slice(0, count).join("\n"), "tiktok"), { urls: urls.slice(0, count), errors: [] });
  }
  const overflow = parseCampaignUrls(urls.join("\n"), "tiktok");
  assert.deepEqual(overflow.urls, urls.slice(0, 10));
  assert.equal(overflow.errors.length, 1);
  assert.equal(overflow.errors[0].line, 11);
  assert.match(overflow.errors[0].message, /10 publicaciones/);
  assert.match(parseCampaignUrls(`${urls[0]}\n${urls[0]}#duplicate`, "tiktok").errors[0].message, /duplicada/);
  assert.match(parseCampaignUrls("https://tiktok.com.example.com/@controlled/video/1", "tiktok").errors[0].message, /Dominio/);
  assert.match(parseCampaignUrls("http://www.tiktok.com/@controlled/video/1", "tiktok").errors[0].message, /HTTPS/);

  const parsed = parseCampaignUrls(urls.slice(0, 2).join("\n"), "tiktok");
  const source: CampaignDraft = { ...draft(parsed.urls, ["one", "two", "three", "four", "five"]), platform: "tiktok" };
  const built = buildAssignments(source);
  assert.equal(built.posts.length, 2);
  assert.equal(built.assignments.length, 10);
  assert.equal(new Set(built.assignments.map((assignment) => assignment.id)).size, 10);
  for (const post of built.posts) {
    assert.deepEqual(built.assignments.filter((assignment) => assignment.postId === post.id).map((assignment) => assignment.deviceId), source.selectedDeviceIds);
    assert.deepEqual(post.comments.map((comment) => comment.deviceId), source.selectedDeviceIds);
  }
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
