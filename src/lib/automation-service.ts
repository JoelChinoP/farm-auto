import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertConnected,
  dumpWindowHierarchy,
  getFocusedPackage,
  isPackageInstalled,
} from "@/lib/adb";
import {
  acquireDeviceLock,
  createOperation,
  getDeviceLock,
  getDevicePreparation,
  getOperation,
  getRegistry,
  listRegistry,
  releaseDeviceLock,
  setDevicePreparation,
  updateOperation,
  upsertRegistry,
} from "@/lib/db";
import { AppError } from "@/lib/errors";
import {
  extractAccessibleFacebookContext,
  findStoredFacebookContext,
} from "@/lib/facebook-context";
import {
  addTaskDevice,
  assertGenFarmerAuthenticated,
  createRun,
  createTask,
  GenFarmerApp,
  GenFarmerRun,
  GenFarmerTask,
  getApp,
  getApps,
  getDevices,
  getRun,
  getRunLogs,
  getRunStorages,
  getTask,
  getTasks,
  importApp,
  stopRun,
  TaskVariable,
  updateTask,
} from "@/lib/genfarmer";
import { appConfig } from "@/lib/config";

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
    slug: "facebook-post-like-comment",
    file: "facebook-post-like-comment.genfarm",
    appName: "Control Panel - Facebook like y comentario",
    taskName: "Facebook like y comentario",
  },
  {
    slug: "facebook-context-extract",
    file: "facebook-context-extract.genfarm",
    appName: "Control Panel - Extraer contexto de Facebook",
    taskName: "Extraer contexto de Facebook",
  },
  {
    slug: "tiktok-live-tap-tap",
    file: "tiktok-live-tap-tap.genfarm",
    appName: "Control Panel - TikTok Live tap tap",
    taskName: "TikTok Live tap tap",
  },
  {
    slug: "tiktok-post-like-comment",
    file: "tiktok-post-like-comment.genfarm",
    appName: "Control Panel - TikTok like y comentario",
    taskName: "TikTok like y comentario",
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

async function stopAndConfirmRun(runId: string) {
  try {
    await stopRun(runId);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const run = await getRun(runId);
      if ([2, 3, 4].includes(run.status)) return true;
      await sleep(500);
    }
  } catch {
    return false;
  }
  return false;
}

async function reconcileDeviceLock(deviceId: string) {
  const lock = getDeviceLock(deviceId);
  if (!lock) return;
  const operation = getOperation(lock.operation_id);
  if (!operation) {
    releaseDeviceLock(deviceId, lock.operation_id);
    return;
  }
  if (["starting", "running"].includes(operation.status)) {
    throw new AppError(
      "El dispositivo ya está ejecutando otra acción.",
      409,
      "DEVICE_BUSY",
    );
  }
  if (!operation.run_id) {
    releaseDeviceLock(deviceId, operation.id);
    return;
  }

  let run: GenFarmerRun;
  try {
    run = await getRun(operation.run_id);
  } catch {
    throw new AppError(
      "No se pudo verificar la ejecución anterior; el dispositivo permanece bloqueado.",
      409,
      "DEVICE_OUTCOME_UNKNOWN",
    );
  }
  if (
    [2, 3, 4].includes(run.status) ||
    (await stopAndConfirmRun(operation.run_id))
  ) {
    releaseDeviceLock(deviceId, operation.id);
    return;
  }
  throw new AppError(
    "La ejecución anterior sigue activa y el dispositivo permanece bloqueado.",
    409,
    "DEVICE_OUTCOME_UNKNOWN",
  );
}

export function assertDevicePrepared(deviceId: string) {
  const preparation = getDevicePreparation(deviceId);
  const missing = automationSpecs.filter((spec) => !getRegistry(spec.slug, deviceId));
  if (preparation?.status !== "ready" || missing.length) {
    throw new AppError(
      preparation?.problem ||
        `Prepara los ${automationSpecs.length} paquetes de este dispositivo.`,
      409,
      "SETUP_REQUIRED",
      { missingSlugs: missing.map((spec) => spec.slug) },
    );
  }
}

export function ensureAutomationDeviceReady(deviceId: string) {
  assertDevicePrepared(deviceId);
  return reconcileDeviceLock(deviceId);
}

async function findApp(apps: GenFarmerApp[], appId: string) {
  const listed = apps.find((item) => item.id === appId);
  if (listed) return listed;

  const app = await getApp(appId).catch(() => undefined);
  if (app) apps.push(app);
  return app;
}

async function findTask(tasks: GenFarmerTask[], taskId: string) {
  const listed = tasks.find((item) => item.id === taskId);
  if (listed) return listed;

  const task = await getTask(taskId).catch(() => undefined);
  if (task) tasks.push(task);
  return task;
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
  let started = false;
  try {
    const execution = await executeOperation(
      "setup",
      randomUUID(),
      deviceId,
      (setRunId) => {
        started = true;
        setDevicePreparation(deviceId, "running", null);
        return setupAutomationsUnlocked(deviceId, setRunId);
      },
    );
    setDevicePreparation(deviceId, "ready", null);
    return execution.result;
  } catch (error) {
    if (started) {
      const message = error instanceof Error ? error.message : String(error);
      const problem =
        error instanceof AppError && error.code ? `${message} [${error.code}]` : message;
      setDevicePreparation(deviceId, "not_ready", problem);
    }
    throw error;
  }
}

async function setupAutomationsUnlocked(
  deviceId: string,
  setRunId: (runId: string) => void,
) {
  const { adbDevice, genFarmerDevice } = await resolveDevice(deviceId);
  await assertGenFarmerAuthenticated();
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
    let app: GenFarmerApp | undefined;
    let imported = false;

    if (registered && registered.package_hash === source.hash) {
      app = await findApp(apps, registered.app_id);
    }

    if (!app) {
      const anyRegisteredWithHash = listRegistry().find(
        (item) => item.slug === spec.slug && item.package_hash === source.hash
      );
      if (anyRegisteredWithHash) {
        app = await findApp(apps, anyRegisteredWithHash.app_id);
      }
    }

    if (!app && !registered) {
      app = apps.find((item) => item.name === spec.appName);
    }

    if (!app) {
      app = await importApp(source.text);
      apps.push(app);
      imported = true;
    }

    const taskName = `${spec.taskName} - ${genFarmerDevice.serialNo}`;
    const registeredTask =
      registered && registered.app_id === app.id
        ? await findTask(tasks, registered.task_id)
        : undefined;
    let task =
      registeredTask?.userId === appConfig.genFarmerUserId
        ? registeredTask
        : undefined;
    if (!task) {
      task = tasks.find(
        (item) =>
          item.userId === appConfig.genFarmerUserId &&
          item.appId === app.id &&
          item.name === taskName,
      );
    }
    if (!task) {
      task = await createTask({
        appId: app.id,
        name: taskName,
        taskInput: app.input ?? [],
      });
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

  await runAutomation("device-home", deviceId, undefined, setRunId);
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

function replaceTaskInput(input: unknown[], values: Record<string, string>) {
  return input.map((item) => {
    if (!item || typeof item !== "object") return item;

    const field = item as Record<string, unknown>;
    if (!field.options || typeof field.options !== "object") return item;

    const options = { ...(field.options as Record<string, unknown>) };
    const variable = options.variable;
    if (variable && typeof variable === "object") {
      const name = (variable as Record<string, unknown>).name;
      if (typeof name === "string" && name in values) {
        options.value = values[name];
      }
    }
    if (Array.isArray(options.data)) {
      options.data = replaceTaskInput(options.data, values);
    }
    if (Array.isArray(options.cols)) {
      options.cols = options.cols.map((column) =>
        Array.isArray(column) ? replaceTaskInput(column, values) : column,
      );
    }
    return { ...field, options };
  });
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
  const deadline = Date.now() + 120_000;
  let run: GenFarmerRun | undefined;
  while (Date.now() < deadline) {
    run = await getRun(runId);
    if ([2, 3, 4].includes(run.status)) break;
    await sleep(400);
  }
  if (!run || ![2, 3, 4].includes(run.status)) {
    const stopConfirmed = await stopAndConfirmRun(runId);
    throw new AppError(
      "La automatización excedió el tiempo de espera.",
      504,
      "RUN_TIMEOUT",
      { runId, stopConfirmed },
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

async function waitForFacebookContext(runId: string) {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const storage = await getRunStorages(runId);
      const context = findStoredFacebookContext(storage.items);
      if (context) return context;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new AppError(
    "GenFarmer termino la lectura sin devolver el contexto.",
    502,
    "FACEBOOK_CONTEXT_OUTPUT_MISSING",
    {
      runId,
      storageError:
        lastError instanceof Error ? lastError.message : String(lastError ?? ""),
    },
  );
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
    const taskInput = replaceTaskInput(task.input ?? [], variables);
    await updateTask({
      ...task,
      input: taskInput,
      variables: replaceTaskVariables(task.variables ?? [], variables),
      enableInput: taskInput.length > 0,
    });
  }
  const run = await createRun(registry.app_id, registry.task_id);
  onStarted?.(run.id);
  return waitForRun(run.id, deviceId);
}

async function runCleanupHome(
  deviceId: string,
  setRunId: (runId: string) => void,
  originalError?: unknown,
) {
  if (originalError instanceof AppError) {
    const details =
      originalError.details && typeof originalError.details === "object"
        ? (originalError.details as Record<string, unknown>)
        : null;
    if (
      [
        "GENFARMER_UNAVAILABLE",
        "GENFARMER_ERROR",
        "DEVICE_CLEANUP_UNKNOWN",
      ].includes(originalError.code) ||
      (originalError.code === "RUN_TIMEOUT" && details?.stopConfirmed !== true)
    ) {
      throw originalError;
    }
  }
  try {
    await runAutomation("device-home", deviceId, undefined, setRunId);
  } catch (cleanupError) {
    throw new AppError(
      "No se pudo confirmar que el dispositivo volvió a inicio.",
      502,
      "DEVICE_CLEANUP_UNKNOWN",
      {
        originalError:
          originalError instanceof Error ? originalError.message : originalError,
        cleanupError:
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
      },
    );
  }
}

async function executeOperation<T>(
  kind: string,
  idempotencyKey: string,
  deviceId: string,
  action: (setRunId: (runId: string) => void) => Promise<T>,
) {
  await reconcileDeviceLock(deviceId);
  const reserved = createOperation(kind, idempotencyKey, deviceId);
  if (!reserved.created) {
    if (
      reserved.operation.kind !== kind ||
      reserved.operation.device_id !== deviceId
    ) {
      throw new AppError(
        "La clave de idempotencia pertenece a otra operación.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    if (reserved.operation.status === "failed") {
      throw new AppError(
        "Esta operación ya falló y no se repetirá automáticamente.",
        409,
        "IDEMPOTENT_OPERATION_FAILED",
      );
    }
    if (["starting", "running"].includes(reserved.operation.status)) {
      throw new AppError(
        "Esta operación todavía está en curso.",
        409,
        "OPERATION_IN_PROGRESS",
      );
    }
    if (!reserved.operation.result_json) {
      throw new AppError(
        "La operación previa no tiene un resultado verificable.",
        409,
        "OPERATION_RESULT_MISSING",
      );
    }
    return {
      operation: reserved.operation,
      result: JSON.parse(reserved.operation.result_json) as T,
      replayed: true,
    };
  }

  let locked = false;
  let retainLock = false;
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
    const operation = getOperation(reserved.operation.id);
    const details =
      error instanceof AppError &&
      error.details &&
      typeof error.details === "object"
        ? (error.details as Record<string, unknown>)
        : null;
    retainLock = Boolean(operation?.run_id) && (
      !(error instanceof AppError) ||
      [
        "GENFARMER_UNAVAILABLE",
        "GENFARMER_ERROR",
        "DEVICE_CLEANUP_UNKNOWN",
      ].includes(error.code) ||
      (error.code === "RUN_TIMEOUT" && details?.stopConfirmed !== true)
    );
    updateOperation(reserved.operation.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (locked && !retainLock) {
      releaseDeviceLock(deviceId, reserved.operation.id);
    }
  }
}

export function goHome(deviceId: string, idempotencyKey: string) {
  assertDevicePrepared(deviceId);
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
  assertDevicePrepared(input.deviceId);
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
        await runAutomation("device-home", input.deviceId, undefined, setRunId);
        const run = await runAutomation(
          "open-social-content",
          input.deviceId,
          { contentUrl: input.url, packageName },
          setRunId,
        );
        let focusedPackage: string | null = null;
        for (let i = 0; i < 5; i++) {
          await sleep(1000);
          focusedPackage = await getFocusedPackage(input.deviceId);
          if (focusedPackage === packageName) {
            break;
          }
        }
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
        await runCleanupHome(input.deviceId, setRunId, error);
        throw error;
      }
    },
  );
}

export function extractFacebookPostContext(input: {
  deviceId: string;
  idempotencyKey: string;
  url: string;
}) {
  assertDevicePrepared(input.deviceId);
  return executeOperation(
    "facebook-context-extract",
    input.idempotencyKey,
    input.deviceId,
    async (setRunId) => {
      const packageName = socialPackages.facebook;
      if (!(await isPackageInstalled(input.deviceId, packageName))) {
        throw new AppError(
          "Facebook no está instalado en el dispositivo seleccionado.",
          409,
          "FACEBOOK_NOT_INSTALLED",
        );
      }

      try {
        await runAutomation("device-home", input.deviceId, undefined, setRunId);
        const openRun = await runAutomation(
          "open-social-content",
          input.deviceId,
          { contentUrl: input.url, packageName },
          setRunId,
        );
        let focusedPackage: string | null = null;
        for (let attempt = 0; attempt < 7; attempt++) {
          await sleep(1000);
          focusedPackage = await getFocusedPackage(input.deviceId);
          if (focusedPackage === packageName) break;
        }
        if (focusedPackage !== packageName) {
          throw new AppError(
            "Android no dejó Facebook en primer plano para leer la publicación.",
            502,
            "UNEXPECTED_FOREGROUND_APP",
          );
        }
        await sleep(1500);
        let contextRun: GenFarmerRun | undefined;
        let context: string;
        try {
          contextRun = await runAutomation(
            "facebook-context-extract",
            input.deviceId,
            undefined,
            setRunId,
          );
          context = await waitForFacebookContext(contextRun.id);
        } catch (genFarmerError) {
          try {
            context = extractAccessibleFacebookContext(
              await dumpWindowHierarchy(input.deviceId),
            );
          } catch (adbError) {
            throw new AppError(
              "No se pudo leer el texto accesible de Facebook. Escribe el contexto manualmente.",
              502,
              "FACEBOOK_CONTEXT_UNAVAILABLE",
              {
                genFarmerError:
                  genFarmerError instanceof Error
                    ? genFarmerError.message
                    : String(genFarmerError),
                adbError:
                  adbError instanceof Error ? adbError.message : String(adbError),
              },
            );
          }
        }
        if (context.length < 5) {
          throw new AppError(
            "No se encontró texto accesible. Escribe el contexto manualmente.",
            422,
            "FACEBOOK_CONTEXT_EMPTY",
          );
        }
        const result = { runId: contextRun?.id ?? openRun.id, context };
        await runCleanupHome(input.deviceId, setRunId);
        return result;
      } catch (error) {
        await runCleanupHome(input.deviceId, setRunId, error);
        throw error;
      }
    },
  );
}

export function runTikTokLiveTapTap(input: {
  deviceId: string;
  idempotencyKey: string;
  url: string;
  tapRounds: number;
  tapX: number;
  tapY: number;
}) {
  assertDevicePrepared(input.deviceId);
  return executeOperation(
    "tiktok-live-tap-tap",
    input.idempotencyKey,
    input.deviceId,
    async (setRunId) => {
      if (!(await isPackageInstalled(input.deviceId, socialPackages.tiktok))) {
        throw new AppError(
          "TikTok no está instalado en el dispositivo seleccionado.",
          409,
          "TIKTOK_NOT_INSTALLED",
        );
      }

      try {
        await runAutomation("device-home", input.deviceId, undefined, setRunId);
        const run = await runAutomation(
          "tiktok-live-tap-tap",
          input.deviceId,
          {
            liveUrl: input.url,
            tapRounds: String(input.tapRounds),
            tapX: String(input.tapX),
            tapY: String(input.tapY),
          },
          setRunId,
        );
        const result = {
          runId: run.id,
          tapRounds: input.tapRounds,
          platform: "tiktok" as const,
        };
        await runCleanupHome(input.deviceId, setRunId);
        return result;
      } catch (error) {
        await runCleanupHome(input.deviceId, setRunId, error);
        throw error;
      }
    },
  );
}

export async function likeAndCommentTikTokPost(input: {
  deviceId: string;
  idempotencyKey: string;
  url: string;
  commentText: string;
}) {
  assertDevicePrepared(input.deviceId);
  const packageName = socialPackages.tiktok;
  if (!(await isPackageInstalled(input.deviceId, packageName))) {
    throw new AppError(
      "TikTok no está instalado en el dispositivo seleccionado.",
      409,
      "TIKTOK_NOT_INSTALLED",
    );
  }

  return executeOperation(
    "tiktok-post-like-comment",
    input.idempotencyKey,
    input.deviceId,
    async (setRunId) => {
      await runAutomation("device-home", input.deviceId, undefined, setRunId);
      try {
        const run = await runAutomation(
          "tiktok-post-like-comment",
          input.deviceId,
          { contentUrl: input.url, commentText: input.commentText },
          setRunId,
        );
        return { runId: run.id, platform: "tiktok" as const };
      } catch (error) {
        await runCleanupHome(input.deviceId, setRunId, error);
        throw error;
      }
    },
  );
}

export async function likeAndCommentFacebookPost(input: {
  deviceId: string;
  idempotencyKey: string;
  url: string;
  commentText: string;
}) {
  assertDevicePrepared(input.deviceId);
  const packageName = socialPackages.facebook;
  if (!(await isPackageInstalled(input.deviceId, packageName))) {
    throw new AppError(
      "Facebook no está instalado en el dispositivo seleccionado.",
      409,
      "FACEBOOK_NOT_INSTALLED",
    );
  }

  return executeOperation(
    "facebook-post-like-comment",
    input.idempotencyKey,
    input.deviceId,
    async (setRunId) => {
      await runAutomation("device-home", input.deviceId, undefined, setRunId);
      try {
        const run = await runAutomation(
          "facebook-post-like-comment",
          input.deviceId,
          { contentUrl: input.url, commentText: input.commentText },
          setRunId,
        );
        return { runId: run.id, platform: "facebook" as const };
      } catch (error) {
        await runCleanupHome(input.deviceId, setRunId, error);
        throw error;
      }
    },
  );
}
