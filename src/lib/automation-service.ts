import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  assertConnected,
  getDeviceHardwareId,
  getHomePackage,
  isPackageInstalled,
} from "@/lib/adb";
import { isAutomationRetrySafe } from "@/lib/automation-errors";
export { isAutomationRetrySafe } from "@/lib/automation-errors";
import {
  activateAndOpenUrl,
  pressHome,
  wait,
  waitForForegroundPackage,
} from "@/lib/android-actions";
import {
  cancelAndroidOperation,
  closeLingeringAndroidSessions,
  finishAndroidOperation,
  getAndroidOperationCompletion,
  getAppiumHealth,
  startAndroidOperation,
  withAndroidSession,
} from "@/lib/appium";
import type { AndroidDriver, AndroidProfile } from "@/lib/appium";
import type { DeviceProfileRow } from "@/lib/db";
import {
  acquireDeviceLock,
  completeOperation,
  createOperation,
  getDeviceLock,
  getDevicePreparation,
  getDeviceProfile,
  getOperation,
  getOperationByIdempotencyKey,
  releaseDeviceLock,
  setDevicePreparation,
  updateOperation,
} from "@/lib/db";
import { AppError } from "@/lib/errors";
import {
  FACEBOOK_PACKAGE,
  readFacebookPostDescription,
  runFacebookPost,
} from "@/lib/facebook-automation";
import {
  runTikTokLive,
  runTikTokPost,
  TIKTOK_PACKAGE,
} from "@/lib/tiktok-automation";

export const SETUP_REVISION = 1;

type PublicCheckpoint = "engagement" | "like" | "comment";

const globalAutomation = globalThis as typeof globalThis & {
  operationCheckpoints?: Map<string, PublicCheckpoint>;
  deviceReconciliations?: Map<string, Promise<void>>;
};
const operationCheckpoints = globalAutomation.operationCheckpoints ??=
  new Map<string, PublicCheckpoint>();
const deviceReconciliations = globalAutomation.deviceReconciliations ??=
  new Map<string, Promise<void>>();

const socialPackages = {
  tiktok: TIKTOK_PACKAGE,
  facebook: FACEBOOK_PACKAGE,
} as const;

function requireProfile(deviceId: string) {
  const profile = getDeviceProfile(deviceId);
  if (!profile) {
    throw new AppError(
      "El dispositivo todavía no tiene un perfil local.",
      409,
      "DEVICE_PROFILE_REQUIRED",
    );
  }
  return profile;
}

function assertProfileUnchanged(
  deviceId: string,
  profile: AndroidProfile & { hardware_id?: string },
) {
  const current = getDeviceProfile(deviceId);
  if (
    !current ||
    current.device_id !== profile.device_id ||
    (profile.hardware_id !== undefined &&
      current.hardware_id !== profile.hardware_id) ||
    current.system_port !== profile.system_port
  ) {
    throw new AppError(
      "El perfil cambió durante la operación; repite la preparación Appium.",
      409,
      "DEVICE_PROFILE_CHANGED",
    );
  }
}

async function assertProfileIdentity(profile: DeviceProfileRow) {
  const hardwareId = await getDeviceHardwareId(profile.device_id);
  if (hardwareId === profile.hardware_id) return;
  setDevicePreparation(
    profile.device_id,
    "not_ready",
    "El transporte ADB apunta a otro dispositivo físico; revisa el perfil.",
    0,
  );
  throw new AppError(
    "El dispositivo conectado no coincide con la identidad física del perfil.",
    409,
    "DEVICE_IDENTITY_MISMATCH",
  );
}

export function assertDevicePrepared(deviceId: string) {
  requireProfile(deviceId);
  const preparation = getDevicePreparation(deviceId);
  if (
    preparation?.status !== "ready" ||
    preparation.setup_revision !== SETUP_REVISION
  ) {
    throw new AppError(
      preparation?.problem || "Prepara este dispositivo con Appium.",
      409,
      "SETUP_REQUIRED",
    );
  }
}

async function confirmHome(
  driver: AndroidDriver,
  expectedPackage: string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + 10_000;
  let focusedPackage: string | null = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    focusedPackage = await driver.getCurrentPackage();
    if (focusedPackage === expectedPackage) {
      return focusedPackage;
    }
    await wait(250, signal);
  }
  throw new AppError(
    "No se pudo confirmar que el dispositivo volvió a inicio.",
    502,
    "DEVICE_CLEANUP_UNKNOWN",
    { expectedPackage, focusedPackage },
  );
}

async function goHomeInSession(
  driver: AndroidDriver,
  expectedPackage: string,
  signal?: AbortSignal,
) {
  await pressHome(driver);
  return confirmHome(driver, expectedPackage, signal);
}

async function cleanupDevice(
  operationId: string,
  profile: DeviceProfileRow,
  recoverTerminalSession = false,
) {
  await assertProfileIdentity(profile);
  await closeLingeringAndroidSessions(
    profile,
    recoverTerminalSession ? operationId : undefined,
  );
  const homePackage = await getHomePackage(profile.device_id);
  return withAndroidSession(
    `${operationId}-cleanup-${randomUUID()}`,
    profile,
    (driver, signal) => goHomeInSession(driver, homePackage, signal),
  );
}

async function reconcileDeviceLock(deviceId: string) {
  const pending = deviceReconciliations.get(deviceId);
  if (pending) return pending;
  const reconciliation = (async () => {
    const lock = getDeviceLock(deviceId);
    if (!lock) return;
    const operation = getOperation(lock.operation_id);
    if (operation && ["starting", "running"].includes(operation.status)) {
      throw new AppError(
        "El dispositivo ya está ejecutando otra acción.",
        409,
        "DEVICE_BUSY",
      );
    }
    const profile = requireProfile(deviceId);
    try {
      await cleanupDevice(lock.operation_id, profile, true);
      releaseDeviceLock(deviceId, lock.operation_id);
    } catch (error) {
      throw new AppError(
        "No se pudo reconciliar la ejecución anterior; el dispositivo permanece bloqueado.",
        409,
        "DEVICE_OUTCOME_UNKNOWN",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  })();
  deviceReconciliations.set(deviceId, reconciliation);
  try {
    await reconciliation;
  } finally {
    if (deviceReconciliations.get(deviceId) === reconciliation) {
      deviceReconciliations.delete(deviceId);
    }
  }
}

export async function ensureAutomationDeviceReady(deviceId: string) {
  assertDevicePrepared(deviceId);
  await assertProfileIdentity(requireProfile(deviceId));
  await reconcileDeviceLock(deviceId);
}

async function executeOperation<T>(
  kind: string,
  idempotencyKey: string,
  deviceId: string,
  request: unknown,
  action: (operationId: string, profile: DeviceProfileRow) => Promise<T>,
) {
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify({ kind, deviceId, request }))
    .digest("hex");
  const replay = (operation: NonNullable<ReturnType<typeof getOperation>>) => {
    if (operation.kind !== kind || operation.device_id !== deviceId) {
      throw new AppError(
        "La clave de idempotencia pertenece a otra operación.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    if (
      operation.request_fingerprint &&
      operation.request_fingerprint !== requestFingerprint
    ) {
      throw new AppError(
        "La clave de idempotencia pertenece a una solicitud con otros parámetros.",
        409,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    if (["failed", "cancelled"].includes(operation.status)) {
      throw new AppError(
        "Esta operación ya terminó sin éxito y no se repetirá automáticamente.",
        409,
        "IDEMPOTENT_OPERATION_FAILED",
      );
    }
    if (["starting", "running"].includes(operation.status)) {
      throw new AppError(
        "Esta operación todavía está en curso.",
        409,
        "OPERATION_IN_PROGRESS",
      );
    }
    if (!operation.result_json) {
      throw new AppError(
        "La operación previa no tiene un resultado verificable.",
        409,
        "OPERATION_RESULT_MISSING",
      );
    }
    return {
      operation,
      result: JSON.parse(operation.result_json) as T,
      replayed: true,
    };
  };

  const existing = getOperationByIdempotencyKey(idempotencyKey);
  if (existing) return replay(existing);
  const profile = requireProfile(deviceId);
  await assertProfileIdentity(profile);
  await reconcileDeviceLock(deviceId);
  const reserved = createOperation(
    kind,
    idempotencyKey,
    requestFingerprint,
    deviceId,
  );
  if (!reserved.created) return replay(reserved.operation);

  let locked = false;
  let active = false;
  let cleanupUnknown = false;
  let executionProfile = profile;
  try {
    acquireDeviceLock(deviceId, reserved.operation.id);
    locked = true;
    executionProfile = requireProfile(deviceId);
    startAndroidOperation(reserved.operation.id);
    active = true;
    updateOperation(reserved.operation.id, { status: "running" });
    await assertProfileIdentity(executionProfile);
    const result = await action(reserved.operation.id, executionProfile);
    const completion = completeOperation(reserved.operation.id, result);
    if (!completion.completed) {
      const cancellation = new AppError(
        "La operación fue cancelada.",
        409,
        "OPERATION_CANCELLED",
      );
      throw completion.operation.status === "cancelled"
        ? outcomeUnknown(
            cancellation,
            operationCheckpoints.get(reserved.operation.id) ?? null,
          )
        : new AppError(
            "La operación cambió de estado antes de guardar su resultado.",
            409,
            "OPERATION_STATE_CONFLICT",
          );
    }
    return { operation: completion.operation, result, replayed: false };
  } catch (error) {
    cleanupUnknown = error instanceof AppError && error.code === "DEVICE_CLEANUP_UNKNOWN";
    const current = getOperation(reserved.operation.id);
    if (current?.status !== "cancelled") {
      updateOperation(reserved.operation.id, {
        status: "failed",
        error: `${error instanceof Error ? error.message : String(error)}${
          error instanceof AppError ? ` [${error.code}]` : ""
        }`,
      });
    }
    throw error;
  } finally {
    if (active) {
      try {
        await finishAndroidOperation(reserved.operation.id);
      } catch {
        cleanupUnknown = true;
      }
    }
    const cancelled = getOperation(reserved.operation.id)?.status === "cancelled";
    if (locked && !cleanupUnknown && !cancelled) {
      releaseDeviceLock(deviceId, reserved.operation.id);
    }
    operationCheckpoints.delete(reserved.operation.id);
  }
}

async function runWithCleanup<T>(
  operationId: string,
  profile: DeviceProfileRow,
  action: (driver: AndroidDriver, signal: AbortSignal) => Promise<T>,
) {
  let result: T | undefined;
  let actionCompleted = false;
  const homePackage = await getHomePackage(profile.device_id);
  try {
    return await withAndroidSession(operationId, profile, async (driver, signal) => {
      result = await action(driver, signal);
      actionCompleted = true;
      await goHomeInSession(driver, homePackage, signal);
      return result;
    });
  } catch (error) {
    if (getOperation(operationId)?.status === "cancelled") throw error;
    if (error instanceof AppError && error.code === "DEVICE_CLEANUP_UNKNOWN") {
      throw error;
    }
    try {
      await cleanupDevice(operationId, profile);
    } catch (cleanupError) {
      throw new AppError(
        "No se pudo confirmar que el dispositivo volvió a inicio.",
        502,
        "DEVICE_CLEANUP_UNKNOWN",
        {
          originalError: error instanceof Error ? error.message : String(error),
          cleanupError:
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
      );
    }
    if (actionCompleted) return result as T;
    throw error;
  }
}

function outcomeUnknown(error: unknown, checkpoint: PublicCheckpoint | null) {
  if (error instanceof AppError && error.code === "DEVICE_CLEANUP_UNKNOWN") {
    return error;
  }
  if (error instanceof AppError && error.code === "COMMENT_ALREADY_PRESENT") {
    return new AppError(
      "El comentario ya estaba visible y su origen debe verificarse manualmente.",
      502,
      "AUTOMATION_OUTCOME_UNKNOWN",
      { checkpoint: "comment", cause: error.message },
    );
  }
  if (!checkpoint) {
    if (isAutomationRetrySafe(error)) return error;
    return new AppError(
      "La automatización falló antes de intentar un efecto público.",
      502,
      "AUTOMATION_PREFLIGHT_FAILED",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return new AppError(
    checkpoint === "comment"
      ? "Se intentó enviar el comentario y el resultado debe verificarse manualmente."
      : checkpoint === "like"
        ? "Se intentó aplicar el like y el resultado debe verificarse manualmente."
        : "Se intentó interactuar con el contenido y el resultado debe verificarse manualmente.",
    502,
    "AUTOMATION_OUTCOME_UNKNOWN",
    {
      checkpoint,
      cause: error instanceof Error ? error.message : String(error),
    },
  );
}

export async function setupAutomations(deviceId: string) {
  let validatedProfile: DeviceProfileRow | null = null;
  let started = false;
  try {
    const execution = await executeOperation(
      "setup",
      randomUUID(),
      deviceId,
      {},
      async (operationId, profile) => {
        validatedProfile = profile;
        started = true;
        setDevicePreparation(deviceId, "running", null, 0);
        await assertConnected(deviceId);
        const health = await getAppiumHealth();
        if (!health.ok) {
          throw new AppError(
            "El servidor Appium no está disponible.",
            503,
            "APPIUM_UNAVAILABLE",
            health,
          );
        }
        const homePackage = await getHomePackage(deviceId);
        const focusedPackage = await withAndroidSession(
          operationId,
          profile,
          async (driver, signal) => {
            const source = await driver.getPageSource();
            if (!source.includes("<hierarchy")) {
              throw new AppError(
                "Appium no devolvió una jerarquía Android válida.",
                502,
                "INVALID_PAGE_SOURCE",
              );
            }
            return goHomeInSession(driver, homePackage, signal);
          },
        );
        assertProfileUnchanged(deviceId, profile);
        return { setupRevision: SETUP_REVISION, focusedPackage };
      },
    );
    assertProfileUnchanged(deviceId, validatedProfile!);
    setDevicePreparation(deviceId, "ready", null, SETUP_REVISION);
    return execution.result;
  } catch (error) {
    if (started) {
      const problem = `${error instanceof Error ? error.message : String(error)}${
        error instanceof AppError ? ` [${error.code}]` : ""
      }`;
      setDevicePreparation(deviceId, "not_ready", problem, 0);
    }
    throw error;
  }
}

export function goHome(deviceId: string, idempotencyKey: string) {
  return executeOperation(
    "device-home",
    idempotencyKey,
    deviceId,
    {},
    async (operationId, profile) => {
      assertDevicePrepared(deviceId);
      await assertProfileIdentity(profile);
      const homePackage = await getHomePackage(deviceId);
      return withAndroidSession(operationId, profile, async (driver, signal) => ({
        operationId,
        focusedPackage: await goHomeInSession(driver, homePackage, signal),
      }));
    },
  );
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
    { platform: input.platform, url: input.url },
    async (operationId, profile) => {
      assertDevicePrepared(input.deviceId);
      await assertProfileIdentity(profile);
      const packageName = socialPackages[input.platform];
      if (!(await isPackageInstalled(input.deviceId, packageName))) {
        throw new AppError(
          `La aplicación ${input.platform} no está instalada.`,
          409,
          "APP_NOT_INSTALLED",
        );
      }
      const homePackage = await getHomePackage(input.deviceId);
      return withAndroidSession(operationId, profile, async (driver, signal) => {
        await goHomeInSession(driver, homePackage, signal);
        await activateAndOpenUrl(driver, packageName, input.url);
        const focusedPackage = await waitForForegroundPackage(
          driver,
          packageName,
          15_000,
          signal,
        );
        return { operationId, focusedPackage, platform: input.platform };
      });
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
  return executeOperation(
    "tiktok-live-tap-tap",
    input.idempotencyKey,
    input.deviceId,
    {
      url: input.url,
      tapRounds: input.tapRounds,
      tapX: input.tapX,
      tapY: input.tapY,
    },
    async (operationId, profile) => {
      assertDevicePrepared(input.deviceId);
      await assertProfileIdentity(profile);
      if (!(await isPackageInstalled(input.deviceId, TIKTOK_PACKAGE))) {
        throw new AppError(
          "TikTok no está instalado en el dispositivo seleccionado.",
          409,
          "TIKTOK_NOT_INSTALLED",
        );
      }
      try {
        await runWithCleanup(operationId, profile, (driver, signal) =>
          runTikTokLive(driver, input, signal, () => {
            operationCheckpoints.set(operationId, "engagement");
          }),
        );
      } catch (error) {
        throw outcomeUnknown(
          error,
          operationCheckpoints.get(operationId) ?? null,
        );
      }
      return { operationId, tapRounds: input.tapRounds, platform: "tiktok" as const };
    },
  );
}

export async function likeAndCommentTikTokPost(input: {
  deviceId: string;
  idempotencyKey: string;
  url: string;
  commentText: string;
  targetMarker: string;
}) {
  return executeOperation(
    "tiktok-post-like-comment",
    input.idempotencyKey,
    input.deviceId,
    {
      url: input.url,
      commentText: input.commentText,
      targetMarker: input.targetMarker,
    },
    async (operationId, profile) => {
      assertDevicePrepared(input.deviceId);
      await assertProfileIdentity(profile);
      if (!(await isPackageInstalled(input.deviceId, TIKTOK_PACKAGE))) {
        throw new AppError(
          "TikTok no está instalado en el dispositivo seleccionado.",
          409,
          "TIKTOK_NOT_INSTALLED",
        );
      }
      try {
        await runWithCleanup(operationId, profile, (driver, signal) =>
          runTikTokPost(driver, input, signal, (effect) => {
            operationCheckpoints.set(operationId, effect);
          }),
        );
      } catch (error) {
        throw outcomeUnknown(
          error,
          operationCheckpoints.get(operationId) ?? null,
        );
      }
      return { operationId, platform: "tiktok" as const };
    },
  );
}

export function extractFacebookPostContext(input: {
  deviceId: string;
  idempotencyKey: string;
  url: string;
}) {
  return executeOperation(
    "facebook-context-extract",
    input.idempotencyKey,
    input.deviceId,
    { url: input.url },
    async (operationId, profile) => {
      assertDevicePrepared(input.deviceId);
      await assertProfileIdentity(profile);
      if (!(await isPackageInstalled(input.deviceId, FACEBOOK_PACKAGE))) {
        throw new AppError(
          "Facebook no está instalado en el dispositivo seleccionado.",
          409,
          "FACEBOOK_NOT_INSTALLED",
        );
      }
      const description = await runWithCleanup(
        operationId,
        profile,
        (driver, signal) => readFacebookPostDescription(driver, input.url, signal),
      );
      return {
        operationId,
        description,
        platform: "facebook" as const,
      };
    },
  );
}

export async function likeAndCommentFacebookPost(input: {
  deviceId: string;
  idempotencyKey: string;
  url: string;
  commentText: string;
  targetMarker: string;
}) {
  return executeOperation(
    "facebook-post-like-comment",
    input.idempotencyKey,
    input.deviceId,
    {
      url: input.url,
      commentText: input.commentText,
      targetMarker: input.targetMarker,
    },
    async (operationId, profile) => {
      assertDevicePrepared(input.deviceId);
      await assertProfileIdentity(profile);
      if (!(await isPackageInstalled(input.deviceId, FACEBOOK_PACKAGE))) {
        throw new AppError(
          "Facebook no está instalado en el dispositivo seleccionado.",
          409,
          "FACEBOOK_NOT_INSTALLED",
        );
      }
      try {
        await runWithCleanup(operationId, profile, (driver, signal) =>
          runFacebookPost(driver, input, signal, (effect) => {
            operationCheckpoints.set(operationId, effect);
          }),
        );
      } catch (error) {
        throw outcomeUnknown(
          error,
          operationCheckpoints.get(operationId) ?? null,
        );
      }
      return { operationId, platform: "facebook" as const };
    },
  );
}

export async function cancelOperation(operationId: string) {
  const operation = getOperation(operationId);
  if (!operation) throw new AppError("Operación no encontrada.", 404, "NOT_FOUND");
  if (!["starting", "running"].includes(operation.status)) return operation;

  updateOperation(operationId, {
    status: "cancelled",
    error: "Cancelada por el operador.",
  });
  const completion = getAndroidOperationCompletion(operationId);
  try {
    await cancelAndroidOperation(operationId);
    await completion;
  } catch (error) {
    updateOperation(operationId, {
      error: "Cancelada; Appium no confirmó el cierre [DEVICE_CLEANUP_UNKNOWN]",
    });
    throw new AppError(
      "La operación se canceló, pero Appium no confirmó el cierre de la sesión.",
      502,
      "DEVICE_CLEANUP_UNKNOWN",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const profile = requireProfile(operation.device_id);
  try {
    await cleanupDevice(operationId, profile, true);
    releaseDeviceLock(operation.device_id, operationId);
  } catch (error) {
    updateOperation(operationId, {
      error: "Cancelada; no se pudo confirmar Home [DEVICE_CLEANUP_UNKNOWN]",
    });
    throw new AppError(
      "La operación se canceló, pero no se pudo confirmar Home.",
      502,
      "DEVICE_CLEANUP_UNKNOWN",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return getOperation(operationId)!;
}
