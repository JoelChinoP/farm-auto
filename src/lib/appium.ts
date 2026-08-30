import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { remote } from "webdriverio";

import { appConfig } from "./config.ts";
import type { DeviceProfileRow } from "./db.ts";
import { AppError } from "./errors.ts";

export type AndroidDriver = WebdriverIO.Browser;
export type AndroidProfile = Pick<
  DeviceProfileRow,
  "device_id" | "alias" | "system_port"
>;

type ActiveOperation = {
  controller: AbortController;
  connecting?: Promise<AndroidDriver>;
  driver?: AndroidDriver;
  closing?: Promise<void>;
  profile?: AndroidProfile;
  persistent?: boolean;
  finished?: Promise<void>;
  resolveFinished?: () => void;
  sessionCreationUnknown?: boolean;
};

const globalAppium = globalThis as typeof globalThis & {
  appiumOperations?: Map<string, ActiveOperation>;
};
const activeOperations = globalAppium.appiumOperations ??=
  new Map<string, ActiveOperation>();

export function startAndroidOperation(operationId: string) {
  if (activeOperations.has(operationId)) {
    throw new AppError(
      "La operación ya está activa.",
      409,
      "OPERATION_IN_PROGRESS",
    );
  }
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  activeOperations.set(operationId, {
    controller: new AbortController(),
    persistent: true,
    finished,
    resolveFinished,
  });
}

export async function finishAndroidOperation(operationId: string) {
  const operation = activeOperations.get(operationId);
  if (!operation) return;
  let closed = false;
  try {
    await closeSession(operation);
    closed = true;
  } finally {
    operation.resolveFinished?.();
    if (closed && activeOperations.get(operationId) === operation) {
      activeOperations.delete(operationId);
    }
  }
}

export function getAndroidOperationCompletion(operationId: string) {
  return activeOperations.get(operationId)?.finished ?? null;
}

export async function closeLingeringAndroidSessions(
  profile: AndroidProfile,
  terminalOperationId?: string,
) {
  for (const [operationId, operation] of activeOperations) {
    if (
      (operation.persistent && operationId !== terminalOperationId) ||
      operation.profile?.device_id !== profile.device_id ||
      operation.profile.system_port !== profile.system_port
    ) {
      continue;
    }
    const connecting = operation.connecting;
    if (connecting) operation.driver ??= await connecting;
    await closeSession(operation);
    if (!operation.driver && activeOperations.get(operationId) === operation) {
      activeOperations.delete(operationId);
    }
  }
}

function appiumEndpoint(pathname: string) {
  const url = new URL(appConfig.appiumUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  return url;
}

export function buildAndroidCapabilities(profile: AndroidProfile) {
  return {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:udid": profile.device_id,
    "appium:deviceName": profile.alias,
    "appium:systemPort": profile.system_port,
    "appium:noReset": true,
    "appium:fullReset": false,
    "appium:autoLaunch": false,
    "appium:newCommandTimeout": 180,
    "appium:adbExecTimeout": 30_000,
    "appium:uiautomator2ServerInstallTimeout": 90_000,
    "appium:uiautomator2ServerLaunchTimeout": 90_000,
    "appium:suppressKillServer": true,
    "wdio:enforceWebDriverClassic": true,
  };
}

export async function getAppiumHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(appiumEndpoint("/status"), {
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json()) as {
      value?: { ready?: boolean; message?: string; build?: { version?: string } };
    };
    return {
      ok: response.ok && payload.value?.ready === true,
      version: payload.value?.build?.version ?? null,
      message: payload.value?.message ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      version: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function closeSession(operation: ActiveOperation) {
  if (!operation.driver) {
    if (operation.sessionCreationUnknown) {
      throw new AppError(
        "Appium no confirmó si la sesión llegó a crearse.",
        502,
        "DEVICE_CLEANUP_UNKNOWN",
      );
    }
    return;
  }
  const driver = operation.driver;
  operation.closing ??= driver.deleteSession();
  try {
    await operation.closing;
    if (operation.driver === driver) operation.driver = undefined;
  } catch (error) {
    throw new AppError(
      "Appium no confirmó el cierre de la sesión.",
      502,
      "DEVICE_CLEANUP_UNKNOWN",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  } finally {
    operation.closing = undefined;
  }
}

async function saveFailureArtifacts(
  operationId: string,
  profile: AndroidProfile,
  driver: AndroidDriver,
) {
  const directory = join(
    appConfig.appiumArtifactsPath,
    operationId.replace(/[^a-zA-Z0-9._-]/g, "_"),
  );
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString();
  const [screenshot, source, focusedPackage] = await Promise.all([
    driver.takeScreenshot().catch(() => null),
    driver.getPageSource().catch(() => null),
    driver.getCurrentPackage().catch(() => null),
  ]);
  await Promise.all([
    screenshot
      ? writeFile(join(directory, "screenshot.png"), screenshot, "base64")
      : undefined,
    source ? writeFile(join(directory, "page-source.xml"), source, "utf8") : undefined,
    writeFile(
      join(directory, "metadata.json"),
      JSON.stringify(
        {
          operationId,
          deviceId: profile.device_id,
          focusedPackage,
          timestamp,
        },
        null,
        2,
      ),
      "utf8",
    ),
  ]);
}

function sessionWasDefinitelyNotCreated(error: unknown) {
  const message = error instanceof Error ? `${error.message} ${error.cause ?? ""}` : String(error);
  return /\b(?:ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)\b/.test(message);
}

export async function withAndroidSession<T>(
  operationId: string,
  profile: AndroidProfile,
  action: (driver: AndroidDriver, signal: AbortSignal) => Promise<T>,
) {
  let operation = activeOperations.get(operationId);
  if (operation?.connecting || operation?.driver || operation?.closing) {
    throw new AppError(
      "La operación ya tiene una sesión Appium activa.",
      409,
      "OPERATION_IN_PROGRESS",
    );
  }
  if (
    [...activeOperations.values()].some(
      (other) =>
        other !== operation &&
        (other.sessionCreationUnknown ||
          other.connecting ||
          other.driver ||
          other.closing) &&
        (other.profile?.device_id === profile.device_id ||
          other.profile?.system_port === profile.system_port),
    )
  ) {
    throw new AppError(
      "Existe otra sesión Appium sin cierre confirmado para este dispositivo o puerto.",
      502,
      "DEVICE_CLEANUP_UNKNOWN",
    );
  }
  operation ??= { controller: new AbortController() };
  operation.profile = profile;
  activeOperations.set(operationId, operation);
  let result: T | undefined;
  let failure: unknown;
  try {
    operation.controller.signal.throwIfAborted();
    const url = new URL(appConfig.appiumUrl);
    const connecting = remote({
      protocol: url.protocol.replace(":", "") as "http" | "https",
      hostname: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      path: url.pathname,
      connectionRetryTimeout: 120_000,
      capabilities: buildAndroidCapabilities(profile),
    });
    operation.connecting = connecting;
    try {
      operation.driver = await connecting;
    } finally {
      if (operation.connecting === connecting) operation.connecting = undefined;
    }
    operation.controller.signal.throwIfAborted();
    result = await action(operation.driver, operation.controller.signal);
  } catch (error) {
    if (operation.controller.signal.aborted) {
      failure = new AppError("La operación fue cancelada.", 409, "OPERATION_CANCELLED");
    } else if (!operation.driver) {
      const definitelyUnavailable = sessionWasDefinitelyNotCreated(error);
      operation.sessionCreationUnknown = !definitelyUnavailable;
      failure = new AppError(
        definitelyUnavailable
          ? "No se pudo conectar con Appium."
          : "Appium no confirmó si la sesión llegó a crearse; el dispositivo permanece bloqueado.",
        503,
        definitelyUnavailable ? "APPIUM_UNAVAILABLE" : "DEVICE_CLEANUP_UNKNOWN",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    } else {
      await saveFailureArtifacts(operationId, profile, operation.driver).catch(
        () => undefined,
      );
      failure = error;
    }
  }
  try {
    await closeSession(operation);
  } catch (error) {
    failure = new AppError(
      "Appium no confirmó el cierre de la sesión; el dispositivo permanece bloqueado.",
      502,
      "DEVICE_CLEANUP_UNKNOWN",
      {
        originalError: failure instanceof Error ? failure.message : failure,
        cleanupError: error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    if (
      !operation.persistent &&
      !operation.driver &&
      !operation.sessionCreationUnknown &&
      activeOperations.get(operationId) === operation
    ) {
      activeOperations.delete(operationId);
    }
  }
  if (failure) throw failure;
  return result as T;
}

export async function cancelAndroidOperation(operationId: string) {
  const operation = activeOperations.get(operationId);
  if (!operation) return false;
  operation.controller.abort();
  const connecting = operation.connecting;
  if (connecting) {
    try {
      operation.driver ??= await connecting;
    } catch {
      // The operation worker reports connection failures with its normal error shape.
    }
  }
  await closeSession(operation);
  return true;
}
