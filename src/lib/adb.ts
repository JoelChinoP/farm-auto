import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";

const execFileAsync = promisify(execFile);
const defaultAdbPath =
  "C:\\Users\\Joel\\.genfarmer\\image-search\\static\\adb\\windows\\adb.exe";

export type AdbDevice = {
  id: string;
  state: string;
  model: string;
  product?: string;
};

function adbPath() {
  return appConfig.adbPath || defaultAdbPath;
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
  return packageInstalledUnchecked(deviceId, packageName);
}

async function packageInstalledUnchecked(deviceId: string, packageName: string) {
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

export async function getFocusedPackage(deviceId: string) {
  await assertConnected(deviceId);
  return focusedPackageUnchecked(deviceId);
}

async function focusedPackageUnchecked(deviceId: string) {
  const output = await adb(["-s", deviceId, "shell", "dumpsys", "window"]);
  const focusLine = output
    .split(/\r?\n/)
    .find((line) => line.includes("mCurrentFocus=") && line.includes("/"));
  return focusLine?.match(/\s([a-zA-Z0-9._]+)\//)?.[1] ?? null;
}

const capabilityCache = new Map<
  string,
  { checkedAt: number; tiktok: boolean; facebook: boolean; whatsapp: boolean }
>();

export async function getDeviceCapabilities(deviceId: string) {
  await assertConnected(deviceId);
  let installed = capabilityCache.get(deviceId);
  if (!installed || Date.now() - installed.checkedAt > 30_000) {
    const [tiktok, facebook, whatsapp] = await Promise.all([
      packageInstalledUnchecked(deviceId, "com.zhiliaoapp.musically").catch(
        () => false,
      ),
      packageInstalledUnchecked(deviceId, "com.facebook.katana").catch(
        () => false,
      ),
      packageInstalledUnchecked(deviceId, "com.whatsapp").catch(() => false),
    ]);
    installed = { checkedAt: Date.now(), tiktok, facebook, whatsapp };
    capabilityCache.set(deviceId, installed);
  }
  const focusedPackage = await focusedPackageUnchecked(deviceId).catch(() => null);
  return {
    tiktok: installed.tiktok,
    facebook: installed.facebook,
    whatsapp: installed.whatsapp,
    focusedPackage,
  };
}

export { assertConnected };
