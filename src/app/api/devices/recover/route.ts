import { randomUUID } from "node:crypto";

import { AdbClient } from "@/lib/adb";
import { AppiumClient } from "@/lib/appium-client";
import { appConfig } from "@/lib/config";
import {
  claimRuntimeOwnership,
  getOwnedAppiumSessionIds,
  listDeviceSnapshots,
  recoverOwnedSessions,
  releaseRuntimeOwnership,
  requestUncertainSessionRecovery,
} from "@/lib/device-runtime";
import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);

  const database = getDatabase();
  const owner = `manual-recovery-${randomUUID()}`;
  if (!claimRuntimeOwnership(database, owner, process.pid, Date.now(), appConfig.workerLeaseMs)) {
    requestUncertainSessionRecovery(database);
    return apiSuccess({ queued: true, devices: listDeviceSnapshots(database) });
  }

  try {
    const appium = new AppiumClient({
      baseUrl: appConfig.appiumUrl,
      timeoutMs: appConfig.appiumTimeoutMs,
      ownedSessionIds: getOwnedAppiumSessionIds(database),
    });
    await recoverOwnedSessions(
      database,
      owner,
      new AdbClient({ database }),
      appium,
      appConfig.cleanupTimeoutMs,
      appConfig.artifactsPath,
      AbortSignal.timeout(appConfig.cleanupTimeoutMs * 10),
    );
    return apiSuccess({ queued: false, devices: listDeviceSnapshots(database) });
  } catch (error) {
    return apiError("SESSION_RECOVERY_FAILED", error instanceof Error ? error.message : String(error), 400);
  } finally {
    releaseRuntimeOwnership(database, owner);
  }
}
