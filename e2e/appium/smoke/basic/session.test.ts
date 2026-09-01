import assert from "node:assert/strict";
import test from "node:test";

import {
  activateAndOpenUrl,
  pressHome,
  waitForForegroundPackage,
} from "../../../../src/lib/android-actions.ts";
import { withAndroidSession } from "../../../../src/lib/appium.ts";

const enabled = process.env.RUN_APPIUM_E2E === "1";

function readTargets() {
  const deviceIds = (
    process.env.APPIUM_DEVICE_IDS ||
    process.env.APPIUM_DEVICE_ID ||
    ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const systemPorts = (
    process.env.APPIUM_SYSTEM_PORTS ||
    process.env.APPIUM_SYSTEM_PORT ||
    ""
  )
    .split(",")
    .map((value) => Number(value.trim()));
  assert.ok(deviceIds.length, "Falta APPIUM_DEVICE_IDS para el smoke test.");
  assert.equal(
    systemPorts.length,
    deviceIds.length,
    "APPIUM_SYSTEM_PORTS debe incluir un puerto por dispositivo.",
  );
  assert.equal(
    new Set(deviceIds).size,
    deviceIds.length,
    "APPIUM_DEVICE_IDS contiene dispositivos duplicados.",
  );
  assert.equal(
    new Set(systemPorts).size,
    systemPorts.length,
    "APPIUM_SYSTEM_PORTS contiene puertos duplicados.",
  );
  systemPorts.forEach((port) =>
    assert.ok(
      Number.isInteger(port) && port >= 8200 && port <= 8299,
      `systemPort inválido: ${port}`,
    ),
  );
  return deviceIds.map((deviceId, index) => ({
    deviceId,
    systemPort: systemPorts[index]!,
  }));
}

test(
  "creates sessions, reads source, presses Home and opens a harmless deep link",
  { skip: !enabled },
  async (context) => {
    const packageName = process.env.APPIUM_SMOKE_PACKAGE;
    const url = process.env.APPIUM_SMOKE_URL;
    assert.ok(packageName && url, "Faltan variables APPIUM_SMOKE_*.");
    for (const target of readTargets()) {
      await context.test(target.deviceId, async () => {
        await withAndroidSession(
          `smoke-${target.deviceId}-${Date.now()}`,
          {
            device_id: target.deviceId,
            alias: target.deviceId,
            system_port: target.systemPort,
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
      });
    }
  },
);
