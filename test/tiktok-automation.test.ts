import assert from "node:assert/strict";
import test from "node:test";

import {
  runTikTokLive,
  runTikTokPost,
  TIKTOK_PACKAGE,
} from "../src/lib/tiktok-automation.ts";
import type { AndroidDriver } from "../src/lib/appium.ts";

function tiktokDriver() {
  const commands: string[] = [];
  const checkpoints: string[] = [];
  let value = "";
  let sent = 0;
  let liked = false;
  const commentElement = {
    isExisting: async () => true,
    isDisplayed: async () => true,
    click: async () => undefined,
  };
  const composer = {
    ...commentElement,
    setValue: async (text: string) => {
      value = text;
    },
    getValue: async () => value,
  };
  const send = {
    ...commentElement,
    click: async () => {
      sent += 1;
      value = "";
    },
  };
  const driver = {
    execute: async (command: string) => {
      commands.push(command);
      if (command === "mobile: doubleClickGesture") liked = true;
    },
    activateApp: async () => undefined,
    terminateApp: async () => false,
    getCurrentPackage: async () => TIKTOK_PACKAGE,
    getWindowSize: async () => ({ width: 1080, height: 1920 }),
    getPageSource: async () =>
      `<hierarchy><node package="${TIKTOK_PACKAGE}" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]"><node package="${TIKTOK_PACKAGE}" class="android.view.ViewGroup" bounds="[0,50][1080,1850]">${
        sent
          ? `<node package="${TIKTOK_PACKAGE}" class="android.widget.TextView" text="Comentario exacto" bounds="[10,10][500,100]"></node>`
          : ""
      }<node package="${TIKTOK_PACKAGE}" class="android.widget.TextView" text="Cosecha sustentable de verano" bounds="[10,100][900,300]"></node><node package="${TIKTOK_PACKAGE}" class="android.widget.TextView" text="agrofarm LIVE" bounds="[10,300][900,400]"></node><node package="${TIKTOK_PACKAGE}" class="android.widget.Button" content-desc="${liked ? "Unlike" : "Like"}" selected="${liked}" bounds="[900,700][1050,850]"></node><node package="${TIKTOK_PACKAGE}" class="android.widget.Button" content-desc="Comments" bounds="[900,850][1050,1000]"></node><node package="${TIKTOK_PACKAGE}" class="android.widget.EditText" text="${value}" hint="Comment" bounds="[10,1700][900,1800]"></node></node></node></hierarchy>`,
    $: async (selector: string) =>
      selector.includes("EditText")
        ? composer
        : selector.includes("Post comment")
          ? send
          : commentElement,
  } as unknown as AndroidDriver;
  return { driver, commands, checkpoints, sent: () => sent };
}

test("executes exactly N abortable double taps", async () => {
  const { driver, commands } = tiktokDriver();
  await runTikTokLive(
    driver,
    { url: "https://tiktok.com/@agrofarm/live", tapRounds: 3, tapX: 500, tapY: 900 },
    new AbortController().signal,
  );
  assert.equal(commands.filter((command) => command === "mobile: doubleClickGesture").length, 3);
});

test("checks target UI, checkpoints effects and sends one verified comment", async () => {
  const { driver, checkpoints, sent } = tiktokDriver();
  await runTikTokPost(
    driver,
    {
      url: "https://tiktok.com/@x/video/1",
      commentText: "Comentario exacto",
      targetMarker: "cosecha sustentable de verano",
    },
    new AbortController().signal,
    (effect) => checkpoints.push(effect),
  );
  assert.deepEqual(checkpoints, ["like", "comment"]);
  assert.equal(sent(), 1);
});

test("does not tap or comment when TikTok shows different content", async () => {
  const { driver, commands, sent } = tiktokDriver();
  await assert.rejects(
    runTikTokPost(
      driver,
      {
        url: "https://tiktok.com/@x/video/2",
        commentText: "Comentario exacto",
        targetMarker: "contenido que no aparece",
      },
      new AbortController().signal,
      () => undefined,
    ),
    /contenido objetivo/,
  );
  assert.equal(commands.filter((command) => command === "mobile: doubleClickGesture").length, 0);
  assert.equal(sent(), 0);
});
