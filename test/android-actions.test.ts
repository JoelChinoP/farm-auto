import assert from "node:assert/strict";
import test from "node:test";

import {
  activateAndOpenUrl,
  clickBounds,
  doubleTap,
  pressHome,
  swipeUp,
  waitForElement,
  waitForForegroundPackage,
} from "../src/lib/android-actions.ts";
import type { AndroidDriver } from "../src/lib/appium.ts";

test("uses UiAutomator2 commands for Home, deep links and gestures", async () => {
  const commands: Array<[string, unknown[]]> = [];
  const calls: string[] = [];
  const driver = {
    execute: async (command: string, args: unknown[]) => commands.push([command, args]),
    terminateApp: async (name: string) => calls.push(`terminate:${name}`),
    activateApp: async (name: string) => calls.push(`activate:${name}`),
    getWindowSize: async () => ({ width: 1080, height: 1920 }),
  } as unknown as AndroidDriver;

  await pressHome(driver);
  await activateAndOpenUrl(driver, "com.test", "https://example.test/post", true);
  await doubleTap(driver, 100, 200);
  await swipeUp(driver);
  await clickBounds(driver, { left: 10, top: 20, right: 30, bottom: 60 });

  assert.deepEqual(calls, ["terminate:com.test", "activate:com.test"]);
  assert.deepEqual(commands.map(([command]) => command), [
    "mobile: pressKey",
    "mobile: deepLink",
    "mobile: doubleClickGesture",
    "mobile: swipeGesture",
    "mobile: clickGesture",
  ]);
  assert.deepEqual(commands.at(-1)?.[1], [{ x: 20, y: 40 }]);
});

test("waits for foreground and elements, then honors abort", async () => {
  let packageReads = 0;
  let elementReads = 0;
  const element = {
    isExisting: async () => ++elementReads > 1,
    isDisplayed: async () => true,
  };
  const driver = {
    getCurrentPackage: async () => (++packageReads > 1 ? "com.target" : "launcher"),
    $: async () => element,
  } as unknown as AndroidDriver;
  assert.equal(
    await waitForForegroundPackage(driver, "com.target", 1_000),
    "com.target",
  );
  assert.equal(await waitForElement(driver, "//*[@text='ok']", 1_000), element);

  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(
    waitForForegroundPackage(driver, "never", 1_000, controller.signal),
    /stop/,
  );
});
