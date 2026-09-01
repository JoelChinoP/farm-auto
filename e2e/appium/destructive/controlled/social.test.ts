import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { pressHome } from "../../../../src/lib/android-actions.ts";
import { withAndroidSession } from "../../../../src/lib/appium.ts";
import {
  facebookCloseAdbCommand,
  facebookLaunchAdbCommands,
} from "../../../../src/lib/facebook-adb.ts";
import { runFacebookPost } from "../../../../src/lib/facebook-automation.ts";
import { runTikTokLive, runTikTokPost } from "../../../../src/lib/tiktok-automation.ts";

const enabled = process.env.RUN_APPIUM_DESTRUCTIVE === "1";
const execFileAsync = promisify(execFile);

async function runAdb(command: string[]) {
  await execFileAsync(process.env.ADB_PATH || "adb", command, { windowsHide: true });
}

async function openFacebookForE2E(deviceId: string, url: string) {
  for (const command of facebookLaunchAdbCommands(deviceId, url)) {
    await runAdb(command);
  }
}
const profile = () => {
  const deviceId = process.env.APPIUM_DEVICE_ID;
  assert.ok(deviceId, "Falta APPIUM_DEVICE_ID.");
  return {
    device_id: deviceId,
    alias: process.env.APPIUM_DEVICE_ALIAS || deviceId,
    system_port: Number(process.env.APPIUM_SYSTEM_PORT || 8200),
  };
};

test("runs controlled TikTok Live taps", { skip: !enabled }, async () => {
  assert.ok(process.env.APPIUM_TIKTOK_LIVE_URL, "Falta APPIUM_TIKTOK_LIVE_URL.");
  await withAndroidSession(`destructive-live-${Date.now()}`, profile(), async (driver, signal) => {
    await runTikTokLive(
      driver,
      {
        url: process.env.APPIUM_TIKTOK_LIVE_URL!,
        tapRounds: Number(process.env.APPIUM_TAP_ROUNDS || 1),
        tapX: Number(process.env.APPIUM_TAP_X || 540),
        tapY: Number(process.env.APPIUM_TAP_Y || 960),
      },
      signal,
    );
    await pressHome(driver);
  });
});

test("publishes one controlled TikTok comment", { skip: !enabled }, async () => {
  for (const variable of [
    "APPIUM_TIKTOK_POST_URL",
    "APPIUM_TIKTOK_COMMENT",
    "APPIUM_TIKTOK_TARGET_MARKER",
  ]) {
    assert.ok(process.env[variable], `Falta ${variable}.`);
  }
  await withAndroidSession(`destructive-tiktok-${Date.now()}`, profile(), async (driver, signal) => {
    await runTikTokPost(
      driver,
      {
        url: process.env.APPIUM_TIKTOK_POST_URL!,
        commentText: process.env.APPIUM_TIKTOK_COMMENT!,
        targetMarker: process.env.APPIUM_TIKTOK_TARGET_MARKER!,
      },
      signal,
      () => undefined,
    );
    await pressHome(driver);
  });
});

test("publishes one controlled Facebook comment", { skip: !enabled }, async () => {
  for (const variable of [
    "APPIUM_FACEBOOK_POST_URL",
    "APPIUM_FACEBOOK_COMMENT",
    "APPIUM_FACEBOOK_TARGET_MARKER",
  ]) {
    assert.ok(process.env[variable], `Falta ${variable}.`);
  }
  const facebookProfile = profile();
  try {
    await withAndroidSession(
      `destructive-facebook-${Date.now()}`,
      facebookProfile,
      async (driver, signal) => {
        await runFacebookPost(
          driver,
          {
            url: process.env.APPIUM_FACEBOOK_POST_URL!,
            commentText: process.env.APPIUM_FACEBOOK_COMMENT!,
            targetMarker: process.env.APPIUM_FACEBOOK_TARGET_MARKER!,
          },
          signal,
          () => undefined,
          (url) => openFacebookForE2E(facebookProfile.device_id, url),
        );
        await pressHome(driver);
      },
    );
  } finally {
    await runAdb(facebookCloseAdbCommand(facebookProfile.device_id));
  }
});
