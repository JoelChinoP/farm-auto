import assert from "node:assert/strict";
import test from "node:test";

import { tiktokLaunchAdbCommands } from "../src/lib/tiktok-adb.ts";

test("builds the sequential ADB commands for TikTok", () => {
  assert.deepEqual(
    tiktokLaunchAdbCommands("device-1", "https://www.tiktok.com/@demo/video/123"),
    [
      [
        "-s",
        "device-1",
        "shell",
        "monkey",
        "-p",
        "com.zhiliaoapp.musically",
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ],
      [
        "-s",
        "device-1",
        "shell",
        "am",
        "start",
        "-W",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "https://www.tiktok.com/@demo/video/123",
        "-p",
        "com.zhiliaoapp.musically",
      ],
    ],
  );
});
