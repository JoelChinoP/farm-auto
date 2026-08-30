import assert from "node:assert/strict";
import test from "node:test";

import {
  activateAndOpenUrl,
  pressHome,
  waitForForegroundPackage,
} from "../../../../src/lib/android-actions.ts";
import { withAndroidSession } from "../../../../src/lib/appium.ts";

const enabled = process.env.RUN_APPIUM_E2E === "1";

test(
  "creates a session, reads source, presses Home and opens a harmless deep link",
  { skip: !enabled },
  async () => {
    const deviceId = process.env.APPIUM_DEVICE_ID;
    const packageName = process.env.APPIUM_SMOKE_PACKAGE;
    const url = process.env.APPIUM_SMOKE_URL;
    assert.ok(deviceId && packageName && url, "Faltan variables APPIUM_* del smoke test.");
    await withAndroidSession(
      `smoke-${Date.now()}`,
      {
        device_id: deviceId,
        alias: process.env.APPIUM_DEVICE_ALIAS || deviceId,
        system_port: Number(process.env.APPIUM_SYSTEM_PORT || 8200),
      },
      async (driver, signal) => {
        assert.match(await driver.getPageSource(), /<hierarchy/);
        await pressHome(driver);
        await activateAndOpenUrl(driver, packageName, url);
        assert.equal(
          await waitForForegroundPackage(driver, packageName, 15_000, signal),
          packageName,
        );
        await pressHome(driver);
      },
    );
  },
);
