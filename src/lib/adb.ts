import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  facebookCloseAdbCommand,
  facebookLaunchAdbCommands,
} from "@/lib/facebook-adb";
import { tiktokLaunchAdbCommands } from "@/lib/tiktok-adb";

const execFileAsync = promisify(execFile);
export type AdbDevice = {
  id: string;
  state: string;
  model: string;
  product?: string;
};

export type AdbActivity = {
  packageName: string;
  activityName: string;
};

function adbPath() {
  return appConfig.adbPath || "adb";
}

async function adb(args: string[], timeout = 15_000) {
  try {
    const { stdout } = await execFileAsync(adbPath(), args, {
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(`ADB no respondió: ${message}`, 503, "ADB_ERROR");
  }
}

export async function listAdbDevices() {
  const output = await adb(["devices", "-l"]);
  return output
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line): AdbDevice => {
      const [id, state, ...attributes] = line.trim().split(/\s+/);
      const values = Object.fromEntries(
        attributes.map((item) => item.split(":", 2) as [string, string]),
      );
      return {
        id,
        state,
        model: values.model?.replaceAll("_", " ") || id,
        product: values.product,
      };
    });
}

async function assertConnected(deviceId: string) {
  const device = (await listAdbDevices()).find(
    (item) => item.id === deviceId && item.state === "device",
  );
  if (!device) {
    throw new AppError(
      "El dispositivo no está conectado o autorizado por ADB.",
      409,
      "DEVICE_NOT_CONNECTED",
    );
  }
  return device;
}

export async function isPackageInstalled(deviceId: string, packageName: string) {
  await assertConnected(deviceId);
  return isPackageInstalledUnchecked(deviceId, packageName);
}

export async function isPackageInstalledUnchecked(
  deviceId: string,
  packageName: string,
) {
  const output = await adb([
    "-s",
    deviceId,
    "shell",
    "pm",
    "list",
    "packages",
    packageName,
  ]);
  return output.split(/\r?\n/).includes(`package:${packageName}`);
}

export async function openFacebookUrl(deviceId: string, url: string) {
  await assertConnected(deviceId);
  for (const command of facebookLaunchAdbCommands(deviceId, url)) {
    await adb(command);
  }
}

export async function openTikTokUrl(deviceId: string, url: string) {
  await assertConnected(deviceId);
  for (const command of tiktokLaunchAdbCommands(deviceId, url)) {
    await adb(command);
  }
}

export async function closeFacebook(deviceId: string) {
  await assertConnected(deviceId);
  await adb(facebookCloseAdbCommand(deviceId));
}

export async function getFocusedPackage(deviceId: string) {
  await assertConnected(deviceId);
  return focusedPackageUnchecked(deviceId);
}

export async function getResumedActivity(deviceId: string) {
  await assertConnected(deviceId);
  return resumedActivityUnchecked(deviceId);
}

export async function waitForAdbForegroundPackage(
  deviceId: string,
  packageName: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  await assertConnected(deviceId);
  const deadline = Date.now() + timeoutMs;
  let actual: string | null = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    actual = (await resumedActivityUnchecked(deviceId))?.packageName ??
      (await focusedPackageUnchecked(deviceId));
    if (actual === packageName) return actual;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 250);
      const abort = () => {
        clearTimeout(timeout);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw new AppError(
    "Android no dejó la aplicación esperada en primer plano.",
    502,
    "UNEXPECTED_FOREGROUND_APP",
    { expected: packageName, actual },
  );
}

export async function getHomePackage(deviceId: string) {
  await assertConnected(deviceId);
  const output = await adb([
    "-s",
    deviceId,
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.HOME",
  ]);
  const component = output
    .split(/\r?\n/)
    .findLast((line) => /^[a-zA-Z0-9._]+\//.test(line.trim()));
  const packageName = component?.trim().split("/", 1)[0];
  if (!packageName) {
    throw new AppError(
      "ADB no pudo resolver la aplicación de inicio del dispositivo.",
      502,
      "HOME_PACKAGE_UNKNOWN",
    );
  }
  return packageName;
}

async function focusedPackageUnchecked(deviceId: string) {
  const output = await adb(["-s", deviceId, "shell", "dumpsys", "window"]);
  const focusLine = output
    .split(/\r?\n/)
    .find((line) => line.includes("mCurrentFocus=") && line.includes("/"));
  return focusLine?.match(/\s([a-zA-Z0-9._]+)\//)?.[1] ?? null;
}

async function resumedActivityUnchecked(deviceId: string) {
  const output = await adb(["-s", deviceId, "shell", "dumpsys", "activity", "activities"]);
  const line = output
    .split(/\r?\n/)
    .findLast((item) => /(?:ResumedActivity|mResumedActivity):/.test(item));
  const match = line?.match(
    /(?:ResumedActivity|mResumedActivity):.*?\s([a-zA-Z0-9._]+)\/([a-zA-Z0-9._$]+)/,
  );
  return match
    ? { packageName: match[1], activityName: match[2] }
    : null;
}

const capabilityCache = new Map<
  string,
  { checkedAt: number; tiktok: boolean; facebook: boolean; hardwareId: string }
>();

export async function getDeviceHardwareId(deviceId: string) {
  await assertConnected(deviceId);
  const [serialNumber, androidId] = await Promise.all([
    adb(["-s", deviceId, "shell", "getprop", "ro.serialno"]),
    adb(["-s", deviceId, "shell", "settings", "get", "secure", "android_id"]),
  ]);
  const parts = [serialNumber, androidId].filter(
    (value) => value && value.toLowerCase() !== "null",
  );
  if (!parts.length) {
    throw new AppError(
      "ADB no pudo identificar el hardware del dispositivo.",
      409,
      "DEVICE_IDENTITY_UNAVAILABLE",
    );
  }
  return parts.join(":");
}

export async function getDeviceCapabilities(deviceId: string) {
  await assertConnected(deviceId);
  let installed = capabilityCache.get(deviceId);
  if (!installed || Date.now() - installed.checkedAt > 30_000) {
    const [tiktok, facebook, hardwareId] = await Promise.all([
      isPackageInstalledUnchecked(deviceId, "com.zhiliaoapp.musically").catch(
        () => false,
      ),
      isPackageInstalledUnchecked(deviceId, "com.facebook.katana").catch(
        () => false,
      ),
      getDeviceHardwareId(deviceId),
    ]);
    installed = { checkedAt: Date.now(), tiktok, facebook, hardwareId };
    capabilityCache.set(deviceId, installed);
  }
  const focusedPackage = await focusedPackageUnchecked(deviceId).catch(() => null);
  return {
    tiktok: installed.tiktok,
    facebook: installed.facebook,
    hardwareId: installed.hardwareId,
    focusedPackage,
  };
}

export { assertConnected };
