import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type Database from "better-sqlite3";

import { appConfig } from "./config.ts";

export const SAFE_ADB_URL = "https://example.com/";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_HOME_TIMEOUT_MS = 5_000;
const DEFAULT_HOME_POLL_INTERVAL_MS = 250;
const execFileAsync = promisify(execFile);

export type AdbDeviceState = "device" | "offline" | "unauthorized";

export interface AdbInventoryDevice {
  serial: string;
  state: AdbDeviceState;
  model?: string;
}

export interface ForegroundActivity {
  packageName: string;
  activityName: string;
  component: string;
}

export interface AdbDeviceInspection {
  deviceId: string;
  state: "device";
  model: string;
  transportModel?: string;
  roSerialNo: string;
  androidId: string;
  hardwareId: string;
  packages: string[];
  foreground: ForegroundActivity | null;
  launcher: ForegroundActivity;
}

export interface AdbDeviceIdentity {
  deviceId: string;
  state: "device";
  roSerialNo: string;
  androidId: string;
  hardwareId: string;
}

export interface AdbExecutionOptions {
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export interface AdbExecutionResult {
  stdout: string;
  stderr: string;
}

export type AdbExecutor = (
  file: string,
  args: readonly string[],
  options: AdbExecutionOptions,
) => Promise<AdbExecutionResult>;

export type AdbSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface AdbCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AdbClientOptions {
  database: Database.Database;
  adbPath?: string;
  executor?: AdbExecutor;
  sleep?: AdbSleep;
  timeoutMs?: number;
  maxBuffer?: number;
  homeTimeoutMs?: number;
  homePollIntervalMs?: number;
}

interface DeviceProfileRow {
  hardwareId: string;
}

async function defaultExecutor(
  file: string,
  args: readonly string[],
  options: AdbExecutionOptions,
): Promise<AdbExecutionResult> {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
    shell: false,
    signal: options.signal,
    timeout: options.timeout,
    windowsHide: true,
  });
  return { stdout, stderr };
}

const defaultSleep: AdbSleep = async (milliseconds, signal) => {
  await delay(milliseconds, undefined, { signal });
};

function splitLines(output: string) {
  return output.split(/\r\n?|\n/);
}

function parseComponent(output: string): ForegroundActivity | null {
  const match = output.match(
    /(?:^|[\s{=])([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\/([A-Za-z0-9_.$]+)(?=$|[\s},])/, 
  );
  if (!match) return null;

  const packageName = match[1];
  const activityName = match[2].startsWith(".") ? `${packageName}${match[2]}` : match[2];
  return {
    packageName,
    activityName,
    component: `${packageName}/${activityName}`,
  };
}

export function parseAdbDevices(output: string): AdbInventoryDevice[] {
  const devices: AdbInventoryDevice[] = [];
  for (const line of splitLines(output)) {
    const match = line.trim().match(/^(\S+)\s+(device|offline|unauthorized)(?:\s+(.*))?$/);
    if (!match) continue;

    const model = match[3]?.match(/(?:^|\s)model:([^\s]+)/)?.[1];
    devices.push({
      serial: match[1],
      state: match[2] as AdbDeviceState,
      ...(model ? { model } : {}),
    });
  }
  return devices;
}

export function parseForeground(output: string): ForegroundActivity | null {
  const lines = splitLines(output);
  for (const marker of [
    "mCurrentFocus=",
    "mFocusedApp=",
    "mTopFullscreenOpaqueWindowState=",
    "mTopFullscreenOpaqueWindow=",
  ]) {
    for (const line of lines) {
      const markerIndex = line.indexOf(marker);
      if (markerIndex < 0) continue;
      const activity = parseComponent(line.slice(markerIndex + marker.length));
      if (activity) return activity;
    }
  }
  return null;
}

export function parseResolvedActivity(output: string): ForegroundActivity | null {
  for (const line of splitLines(output).reverse()) {
    const activity = parseComponent(line.trim());
    if (activity) return activity;
  }
  return null;
}

export function parsePackages(output: string): string[] {
  return splitLines(output)
    .map((line) => line.trim().match(/^package:([^\s]+)$/)?.[1])
    .filter((packageName): packageName is string => Boolean(packageName));
}

export function calculateHardwareId(roSerialNo: string, androidId: string) {
  return createHash("sha256")
    .update(JSON.stringify([roSerialNo.trim(), androidId.trim()]), "utf8")
    .digest("hex");
}

export class HardwareIdentityMismatchError extends Error {
  readonly serial: string;
  readonly expectedHardwareId: string;
  readonly actualHardwareId: string;

  constructor(serial: string, expectedHardwareId: string, actualHardwareId: string) {
    super(`La identidad fisica de ${serial} no coincide con su perfil.`);
    this.name = "HardwareIdentityMismatchError";
    this.serial = serial;
    this.expectedHardwareId = expectedHardwareId;
    this.actualHardwareId = actualHardwareId;
  }
}

export class AdbClient {
  private readonly database: Database.Database;
  private readonly adbPath: string;
  private readonly executor: AdbExecutor;
  private readonly sleep: AdbSleep;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly homeTimeoutMs: number;
  private readonly homePollIntervalMs: number;

  constructor(options: AdbClientOptions) {
    this.database = options.database;
    this.adbPath = options.adbPath ?? appConfig.adbPath;
    this.executor = options.executor ?? defaultExecutor;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.homeTimeoutMs = options.homeTimeoutMs ?? DEFAULT_HOME_TIMEOUT_MS;
    this.homePollIntervalMs = options.homePollIntervalMs ?? DEFAULT_HOME_POLL_INTERVAL_MS;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs debe ser positivo.");
    if (!Number.isInteger(this.maxBuffer) || this.maxBuffer <= 0) throw new Error("maxBuffer debe ser positivo.");
    if (!Number.isInteger(this.homeTimeoutMs) || this.homeTimeoutMs < 0) {
      throw new Error("homeTimeoutMs no puede ser negativo.");
    }
    if (!Number.isInteger(this.homePollIntervalMs) || this.homePollIntervalMs <= 0) {
      throw new Error("homePollIntervalMs debe ser positivo.");
    }
  }

  async listDevices(options: AdbCommandOptions = {}) {
    const result = await this.invoke(["devices", "-l"], options);
    return parseAdbDevices(`${result.stdout}\n${result.stderr}`);
  }

  async execute(serial: string, args: readonly string[], options: AdbCommandOptions = {}) {
    this.validateSerial(serial);
    if (args.length === 0) throw new Error("El comando ADB dirigido no puede estar vacio.");
    if (args.some((argument) => argument.trim().toLowerCase() === "kill-server")) {
      throw new Error("adb kill-server esta prohibido.");
    }
    if (args.some((argument) => argument === "-s" || argument === "--serial")) {
      throw new Error("El selector ADB lo controla AdbClient.");
    }
    this.requireProfile(serial);
    return this.invoke(["-s", serial, ...args], options);
  }

  async inspectDevice(serial: string, options: AdbCommandOptions = {}): Promise<AdbDeviceInspection> {
    this.validateSerial(serial);
    const profile = this.requireProfile(serial);
    const inspection = await this.inspectTarget(serial, options);
    if (inspection.hardwareId !== profile.hardwareId) {
      throw new HardwareIdentityMismatchError(serial, profile.hardwareId, inspection.hardwareId);
    }
    return inspection;
  }

  async verifyDeviceIdentity(serial: string, options: AdbCommandOptions = {}): Promise<AdbDeviceIdentity> {
    this.validateSerial(serial);
    const profile = this.requireProfile(serial);
    const inventoryDevice = (await this.listDevices(options)).find((device) => device.serial === serial);
    if (!inventoryDevice) throw new Error(`El dispositivo ${serial} no esta conectado por ADB.`);
    if (inventoryDevice.state !== "device") throw new Error(`El dispositivo ${serial} esta ${inventoryDevice.state}.`);

    const execute = (args: readonly string[]) => this.invoke(["-s", serial, ...args], options);
    const [roSerialNoResult, androidIdResult] = await Promise.all([
      execute(["shell", "getprop", "ro.serialno"]),
      execute(["shell", "settings", "get", "secure", "android_id"]),
    ]);
    const roSerialNo = this.requiredOutput(roSerialNoResult.stdout, "ro.serialno");
    const androidId = this.requiredOutput(androidIdResult.stdout, "android_id");
    const hardwareId = calculateHardwareId(roSerialNo, androidId);
    if (hardwareId !== profile.hardwareId) {
      throw new HardwareIdentityMismatchError(serial, profile.hardwareId, hardwareId);
    }
    return { deviceId: serial, state: "device", roSerialNo, androidId, hardwareId };
  }

  async inspectUnregisteredDevice(serial: string, options: AdbCommandOptions = {}): Promise<AdbDeviceInspection> {
    this.validateSerial(serial);
    return this.inspectTarget(serial, options);
  }

  private async inspectTarget(serial: string, options: AdbCommandOptions): Promise<AdbDeviceInspection> {
    const inventoryDevice = (await this.listDevices(options)).find((device) => device.serial === serial);
    if (!inventoryDevice) throw new Error(`El dispositivo ${serial} no esta conectado por ADB.`);
    if (inventoryDevice.state !== "device") {
      throw new Error(`El dispositivo ${serial} esta ${inventoryDevice.state}.`);
    }
    const execute = (args: readonly string[]) => this.invoke(["-s", serial, ...args], options);
    const model = this.requiredOutput(
      (await execute(["shell", "getprop", "ro.product.model"])).stdout,
      "ro.product.model",
    );
    const roSerialNo = this.requiredOutput(
      (await execute(["shell", "getprop", "ro.serialno"])).stdout,
      "ro.serialno",
    );
    const androidId = this.requiredOutput(
      (await execute(["shell", "settings", "get", "secure", "android_id"])).stdout,
      "android_id",
    );
    const packages = parsePackages(
      (await execute(["shell", "pm", "list", "packages"])).stdout,
    );
    const foreground = parseForeground(
      (await execute(["shell", "dumpsys", "window", "windows"])).stdout,
    );
    const launcher = parseResolvedActivity((await execute([
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.HOME",
    ])).stdout);
    if (!launcher) throw new Error(`No se pudo resolver el launcher de ${serial}.`);
    const hardwareId = calculateHardwareId(roSerialNo, androidId);
    return {
      deviceId: serial,
      state: "device",
      model,
      ...(inventoryDevice.model ? { transportModel: inventoryDevice.model } : {}),
      roSerialNo,
      androidId,
      hardwareId,
      packages,
      foreground,
      launcher,
    };
  }

  async getForeground(serial: string, options: AdbCommandOptions = {}) {
    const result = await this.execute(serial, ["shell", "dumpsys", "window", "windows"], options);
    return parseForeground(result.stdout);
  }

  async waitForForeground(serial: string, packageName: string, options: AdbCommandOptions = {}) {
    let elapsed = 0;
    while (true) {
      const foreground = await this.getForeground(serial, options);
      if (foreground?.packageName === packageName) return foreground;
      if (elapsed >= this.homeTimeoutMs) throw new Error(`Android no confirmo ${packageName} en foreground en ${serial}.`);
      const wait = Math.min(this.homePollIntervalMs, this.homeTimeoutMs - elapsed);
      await this.sleep(wait, options.signal);
      elapsed += wait;
    }
  }

  async resolveLauncher(serial: string, options: AdbCommandOptions = {}) {
    const result = await this.execute(serial, [
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.HOME",
    ], options);
    const launcher = parseResolvedActivity(result.stdout);
    if (!launcher) throw new Error(`No se pudo resolver el launcher de ${serial}.`);
    return launcher;
  }

  async goHome(serial: string, options: AdbCommandOptions = {}) {
    const launcher = await this.resolveLauncher(serial, options);
    await this.execute(serial, ["shell", "input", "keyevent", "KEYCODE_HOME"], options);
    return this.waitForForeground(serial, launcher.packageName, options);
  }

  async launchApp(serial: string, packageName: string, options: AdbCommandOptions = {}) {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(packageName)) {
      throw new Error("El paquete Android no es valido.");
    }
    const resolved = await this.execute(serial, [
      "shell", "cmd", "package", "resolve-activity", "--brief",
      "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", packageName,
    ], options);
    const activity = parseResolvedActivity(resolved.stdout);
    if (activity?.packageName !== packageName) throw new Error(`No se pudo resolver el launcher de ${packageName}.`);
    const result = await this.execute(serial, [
      "shell", "am", "start", "-W", "-a", "android.intent.action.MAIN",
      "-c", "android.intent.category.LAUNCHER", "-n", `'${activity.component}'`,
    ], options);
    options.signal?.throwIfAborted();
    if (!/^Status:\s*ok\s*$/mu.test(result.stdout)) {
      throw new Error(`ADB no pudo abrir ${packageName}: ${result.stdout} ${result.stderr}`);
    }
    return this.waitForForeground(serial, packageName, options);
  }

  async openSafeUrl(serial: string, url: string, options: AdbCommandOptions = {}) {
    if (url !== SAFE_ADB_URL) throw new Error(`ADB solo puede abrir ${SAFE_ADB_URL}.`);
    return this.execute(serial, [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      SAFE_ADB_URL,
    ], options);
  }

  async resolveSafeUrlHandler(serial: string, options: AdbCommandOptions = {}) {
    const result = await this.execute(serial, [
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      SAFE_ADB_URL,
    ], options);
    const handler = parseResolvedActivity(result.stdout);
    if (!handler) throw new Error(`No se pudo resolver un handler para ${SAFE_ADB_URL}.`);
    return handler;
  }

  private async invoke(args: readonly string[], options: AdbCommandOptions) {
    options.signal?.throwIfAborted();
    const timeout = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("timeoutMs debe ser positivo.");
    return this.executor(this.adbPath, args, {
      timeout,
      maxBuffer: this.maxBuffer,
      signal: options.signal,
    });
  }

  private validateSerial(serial: string) {
    if (!serial.trim() || /[\u0000-\u001f\u007f]/.test(serial)) {
      throw new Error("El serial ADB no puede estar vacio ni contener caracteres de control.");
    }
  }

  private requireProfile(serial: string) {
    const profile = this.database.prepare(
      "SELECT hardware_id AS hardwareId FROM device_profiles WHERE device_id = ?",
    ).get(serial) as DeviceProfileRow | undefined;
    if (!profile) throw new Error(`El dispositivo ${serial} no esta permitido en device_profiles.`);
    return profile;
  }

  private requiredOutput(output: string, property: string) {
    const value = output.trim();
    if (!value || value === "null") throw new Error(`ADB no devolvio ${property}.`);
    return value;
  }
}
