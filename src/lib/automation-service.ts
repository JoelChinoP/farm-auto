import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertConnected,
  getFocusedPackage,
  isPackageInstalled,
} from "@/lib/adb";
import {
  acquireDeviceLock,
  createOperation,
  getRegistry,
  releaseDeviceLock,
  updateOperation,
  upsertRegistry,
} from "@/lib/db";
import { AppError } from "@/lib/errors";
import {
  addTaskDevice,
  createRun,
  createTask,
  GenFarmerRun,
  getApps,
  getDevices,
  getRun,
  getRunLogs,
  getTask,
  getTasks,
  importApp,
  TaskVariable,
  updateTask,
} from "@/lib/genfarmer";

export const automationSpecs = [
  {
    slug: "device-home",
    file: "device-home.genfarm",
    appName: "Control Panel - Pantalla de inicio",
    taskName: "Pantalla de inicio",
  },
  {
    slug: "open-social-content",
    file: "open-social-content.genfarm",
    appName: "Control Panel - Abrir contenido social",
    taskName: "Abrir contenido social",
  },
  {
    slug: "whatsapp-consented",
    file: "whatsapp-send-consented.genfarm",
    appName: "Control Panel - WhatsApp consentido",
    taskName: "WhatsApp consentido",
  },
] as const;

type AutomationSlug = (typeof automationSpecs)[number]["slug"];

const socialPackages = {
  tiktok: "com.zhiliaoapp.musically",
  facebook: "com.facebook.katana",
} as const;

function sleep(milliseconds: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function packageData(file: string) {
  const text = await readFile(resolve(process.cwd(), "automations", file), "utf8");
  JSON.parse(text);
  return {
    text,
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

async function resolveDevice(deviceId: string) {
  const adbDevice = await assertConnected(deviceId);
  const genFarmerDevice = (await getDevices()).find(
    (item) => item.currentDeviceId === deviceId,
  );
  if (!genFarmerDevice) {
    throw new AppError(
      "GenFarmer todavía no reconoce este dispositivo ADB.",
      409,
      "DEVICE_NOT_IN_GENFARMER",
    );
  }
  return { adbDevice, genFarmerDevice };
}

export async function setupAutomations(deviceId: string) {
  const { adbDevice, genFarmerDevice } = await resolveDevice(deviceId);
  const apps = (await getApps()).items;
  const tasks = (await getTasks()).items;
  const results: Array<{
    slug: AutomationSlug;
    appId: string;
    taskId: string;
    imported: boolean;
  }> = [];

  for (const spec of automationSpecs) {
    const source = await packageData(spec.file);
    const registered = getRegistry(spec.slug, deviceId);
    let app =
      registered?.package_hash === source.hash
        ? apps.find((item) => item.id === registered.app_id)
        : undefined;
    let imported = false;

    if (!app && !registered) {
      app = apps.find((item) => item.name === spec.appName);
    }
    if (!app) {
      app = await importApp(source.text);
      apps.push(app);
      imported = true;
    }

    const taskName = `${spec.taskName} - ${genFarmerDevice.serialNo}`;
    let task =
      registered && registered.app_id === app.id
        ? tasks.find((item) => item.id === registered.task_id)
        : undefined;
    if (!task) {
      task = tasks.find(
        (item) => item.appId === app.id && item.name === taskName,
      );
    }
    if (!task) {
      task = await createTask({ appId: app.id, name: taskName });
      tasks.push(task);
    }

    const fullTask = await getTask(task.id);
    if (
      !fullTask.devices?.list?.some(
        (item) => item.serialNo === genFarmerDevice.serialNo,
      )
    ) {
      await addTaskDevice(task.id, {
        id: deviceId,
        serialNo: genFarmerDevice.serialNo,
        name: genFarmerDevice.name || adbDevice.model,
      });
    }

    upsertRegistry({
      slug: spec.slug,
      device_id: deviceId,
      app_id: app.id,
      task_id: task.id,
      package_hash: source.hash,
    });
    results.push({
      slug: spec.slug,
      appId: app.id,
      taskId: task.id,
      imported,
    });
  }

  await runAutomation("device-home", deviceId);
  return results;
}

function replaceTaskVariables(
  variables: TaskVariable[],
  values: Record<string, string>,
) {
  const known = new Set(variables.map((item) => item.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) {
      throw new AppError(
        `La automatización no declara la variable ${name}.`,
        500,
        "AUTOMATION_VARIABLE_MISSING",
      );
    }
  }
  return variables.map((item) =>
    item.name in values ? { ...item, value: values[item.name] } : item,
  );
}

function findFailureLog(value: unknown): string | null {
  if (typeof value === "string") {
    return value.includes("[Failed]") ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = findFailureLog(item);
      if (failure) return failure;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.logType === "Failed") {
    return typeof record.logText === "string" ? record.logText : "Failed";
  }
  for (const item of Object.values(record)) {
    const failure = findFailureLog(item);
    if (failure) return failure;
  }
  return null;
}

async function waitForRun(runId: string, deviceId: string) {
  const deadline = Date.now() + 60_000;
  let run: GenFarmerRun | undefined;
  while (Date.now() < deadline) {
    run = await getRun(runId);
    if ([2, 3, 4].includes(run.status)) break;
    await sleep(400);
  }
  if (!run || ![2, 3, 4].includes(run.status)) {
    throw new AppError(
      "La automatización excedió el tiempo de espera.",
      504,
      "RUN_TIMEOUT",
    );
  }

  const logs = await getRunLogs(run.id, deviceId).catch(() => null);
  const failureLog = findFailureLog(logs?.content);
  const deviceFailed = run.deviceStatuses?.some((item) => item.status !== 2);
  if (failureLog?.includes("Automation feature is expired")) {
    throw new AppError(
      "La licencia de GenFarmer no habilita automatizaciones para este dispositivo.",
      409,
      "GENFARMER_AUTOMATION_EXPIRED",
      { runId: run.id },
    );
  }
  if (run.status !== 4 || deviceFailed || failureLog) {
    throw new AppError(
      "GenFarmer no pudo completar la automatización.",
      502,
      "RUN_FAILED",
      {
        runId: run.id,
        status: run.status,
        deviceStatuses: run.deviceStatuses,
        failureLog,
      },
    );
  }
  return run;
}

async function runAutomation(
  slug: AutomationSlug,
  deviceId: string,
  variables?: Record<string, string>,
  onStarted?: (runId: string) => void,
) {
  const registry = getRegistry(slug, deviceId);
  if (!registry) {
    throw new AppError(
      "Primero configura las automatizaciones para este dispositivo.",
      409,
      "SETUP_REQUIRED",
    );
  }
  const task = await getTask(registry.task_id);
  if (variables) {
    await updateTask({
      ...task,
      variables: replaceTaskVariables(task.variables ?? [], variables),
    });
  }
  const run = await createRun(registry.app_id, registry.task_id);
  onStarted?.(run.id);
  return waitForRun(run.id, deviceId);
}

async function executeOperation<T>(
  kind: string,
  idempotencyKey: string,
  deviceId: string,
  action: (setRunId: (runId: string) => void) => Promise<T>,
) {
  const reserved = createOperation(kind, idempotencyKey, deviceId);
  if (!reserved.created) {
    if (reserved.operation.status === "failed") {
      throw new AppError(
        "Esta operación ya falló y no se repetirá automáticamente.",
        409,
        "IDEMPOTENT_OPERATION_FAILED",
      );
    }
    return {
      operation: reserved.operation,
      result: reserved.operation.result_json
        ? (JSON.parse(reserved.operation.result_json) as T)
        : null,
      replayed: true,
    };
  }

  let locked = false;
  try {
    acquireDeviceLock(deviceId, reserved.operation.id);
    locked = true;
    updateOperation(reserved.operation.id, { status: "running" });
    const result = await action((runId) => {
      updateOperation(reserved.operation.id, { run_id: runId });
    });
    const operation = updateOperation(reserved.operation.id, {
      status: "succeeded",
      result_json: JSON.stringify(result),
    });
    return { operation, result, replayed: false };
  } catch (error) {
    updateOperation(reserved.operation.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (locked) releaseDeviceLock(deviceId, reserved.operation.id);
  }
}

export function goHome(deviceId: string, idempotencyKey: string) {
  return executeOperation("device-home", idempotencyKey, deviceId, async (setRunId) => {
    const run = await runAutomation("device-home", deviceId, undefined, setRunId);
    return { runId: run.id };
  });
}

export function openSocialContent(input: {
  deviceId: string;
  idempotencyKey: string;
  platform: keyof typeof socialPackages;
  url: string;
}) {
  return executeOperation(
    "open-social-content",
    input.idempotencyKey,
    input.deviceId,
    async (setRunId) => {
      const packageName = socialPackages[input.platform];
      if (!(await isPackageInstalled(input.deviceId, packageName))) {
        throw new AppError(
          `La aplicación ${input.platform} no está instalada.`,
          409,
          "APP_NOT_INSTALLED",
        );
      }

      try {
        await runAutomation("device-home", input.deviceId);
        const run = await runAutomation(
          "open-social-content",
          input.deviceId,
          { contentUrl: input.url, packageName },
          setRunId,
        );
        await sleep(700);
        const focusedPackage = await getFocusedPackage(input.deviceId);
        if (focusedPackage !== packageName) {
          throw new AppError(
            "Android no dejó la aplicación esperada en primer plano.",
            502,
            "UNEXPECTED_FOREGROUND_APP",
            { expected: packageName, actual: focusedPackage },
          );
        }
        return { runId: run.id, focusedPackage, platform: input.platform };
      } catch (error) {
        await runAutomation("device-home", input.deviceId).catch(() => undefined);
        throw error;
      }
    },
  );
}

export async function sendWhatsAppMessage(input: {
  deviceId: string;
  idempotencyKey: string;
  phoneNumber: string;
  messageText: string;
}) {
  if (!(await isPackageInstalled(input.deviceId, "com.whatsapp"))) {
    throw new AppError(
      "WhatsApp no está instalado en el dispositivo seleccionado.",
      409,
      "WHATSAPP_NOT_INSTALLED",
    );
  }
  return executeOperation(
    "whatsapp-consented",
    input.idempotencyKey,
    input.deviceId,
    async (setRunId) => {
      await runAutomation("device-home", input.deviceId);
      try {
        const run = await runAutomation(
          "whatsapp-consented",
          input.deviceId,
          {
            phoneNumber: input.phoneNumber,
            messageText: input.messageText,
          },
          setRunId,
        );
        return { runId: run.id };
      } catch (error) {
        await runAutomation("device-home", input.deviceId).catch(() => undefined);
        throw error;
      }
    },
  );
}
