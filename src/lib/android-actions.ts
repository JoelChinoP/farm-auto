import type { AndroidDriver } from "./appium.ts";
import type { Bounds } from "./android-ui.ts";
import { AppError } from "./errors.ts";

export async function wait(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pressHome(driver: AndroidDriver) {
  await driver.execute("mobile: pressKey", { keycode: 3 });
}

export async function activateAndOpenUrl(
  driver: AndroidDriver,
  packageName: string,
  url: string,
  restart = false,
) {
  if (restart) await driver.terminateApp(packageName).catch(() => false);
  await driver.activateApp(packageName);
  await driver.execute("mobile: deepLink", { url, package: packageName });
}

export async function waitForForegroundPackage(
  driver: AndroidDriver,
  packageName: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  let actual: string | null = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    actual = await driver.getCurrentPackage();
    if (actual === packageName) return actual;
    await wait(250, signal);
  }
  throw new AppError(
    "Android no dejó la aplicación esperada en primer plano.",
    502,
    "UNEXPECTED_FOREGROUND_APP",
    { expected: packageName, actual },
  );
}

export async function waitForElement(
  driver: AndroidDriver,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const element = await driver.$(selector);
    if ((await element.isExisting()) && (await element.isDisplayed())) return element;
    await wait(250, signal);
  }
  throw new AppError(
    `No apareció el elemento esperado: ${selector}`,
    504,
    "ELEMENT_TIMEOUT",
  );
}

export async function doubleTap(driver: AndroidDriver, x: number, y: number) {
  await driver.execute("mobile: doubleClickGesture", { x, y });
}

export async function swipeUp(driver: AndroidDriver, bounds?: Bounds) {
  const area = bounds ?? (() => null)();
  const size = area ? null : await driver.getWindowSize();
  await driver.execute("mobile: swipeGesture", {
    left: area?.left ?? 0,
    top: area?.top ?? 0,
    width: area ? area.right - area.left : size!.width,
    height: area ? area.bottom - area.top : size!.height,
    direction: "up",
    percent: 0.7,
  });
}

export async function clickBounds(driver: AndroidDriver, bounds: Bounds) {
  await driver.execute("mobile: clickGesture", {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2),
  });
}
