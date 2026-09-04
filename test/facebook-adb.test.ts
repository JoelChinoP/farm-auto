import assert from "node:assert/strict";
import test from "node:test";

import {
  facebookCloseAdbCommand,
  facebookLaunchAdbCommands,
} from "../src/lib/facebook-adb.ts";

test("builds the sequential ADB commands for Facebook", () => {
  assert.deepEqual(
    facebookLaunchAdbCommands("device-1", "https://m.facebook.com/share/v/example/"),
    [
      [
        "-s",
        "device-1",
        "shell",
        "monkey",
        "-p",
        "com.facebook.katana",
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
        "https://www.facebook.com/share/v/example/",
        "-p",
        "com.facebook.katana",
      ],
    ],
  );
  assert.deepEqual(facebookCloseAdbCommand("device-1"), [
    "-s",
    "device-1",
    "shell",
    "am",
    "force-stop",
    "com.facebook.katana",
  ]);
});
