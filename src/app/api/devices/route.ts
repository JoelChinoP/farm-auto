import { getDatabase } from "@/lib/database";
import { AdbClient } from "@/lib/adb";
import { clearDeviceList, listDeviceSnapshots, registerConnectedDevices, upsertDeviceProfile } from "@/lib/device-runtime";
import { FacebookError, recordFacebookDeviceIdentity } from "@/lib/facebook";
import { apiError, apiSuccess } from "@/lib/http";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return apiSuccess({ devices: listDeviceSnapshots(getDatabase()) });
}

export async function POST(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!Array.isArray(body.serials) || body.serials.some((serial) => typeof serial !== "string")) {
      return apiError("DEVICE_IMPORT_INVALID", "serials debe ser una lista de textos.", 400);
    }
    const database = getDatabase();
    const profiles = await registerConnectedDevices(database, new AdbClient({ database }), body.serials);
    return apiSuccess({ profiles, devices: listDeviceSnapshots(database) });
  } catch (error) {
    return apiError("DEVICE_IMPORT_FAILED", error instanceof Error ? error.message : String(error), 400);
  }
}

export async function PUT(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);

  try {
    const body = await request.json() as Record<string, unknown>;
    const database = getDatabase();
    const profile = database.transaction(() => {
      const saved = upsertDeviceProfile(database, {
        hardwareId: typeof body.hardwareId === "string" ? body.hardwareId : "",
        deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
        alias: typeof body.alias === "string" ? body.alias : "",
        physicalOrder: body.physicalOrder as number,
        systemPort: body.systemPort as number,
      });
      if (typeof body.facebookAccount === "string") {
        if (body.facebookAccount.trim()) recordFacebookDeviceIdentity(database, saved.deviceId, body.facebookAccount);
        else {
          const active = database.prepare(`
            SELECT 1 FROM jobs j JOIN operations o ON o.id = j.operation_id
            WHERE o.device_id = ? AND j.status IN ('pending', 'running') LIMIT 1
          `).get(saved.deviceId);
          if (active) throw new FacebookError("FACEBOOK_ACCOUNT_LOCKED", "La cuenta no puede borrarse mientras el dispositivo tiene trabajo programado.", 409);
          database.prepare("DELETE FROM facebook_device_identities WHERE device_id = ?").run(saved.deviceId);
        }
      }
      return saved;
    }).immediate();
    return apiSuccess({ profile });
  } catch (error) {
    if (error instanceof FacebookError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("DEVICE_PROFILE_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}

export async function DELETE(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);

  try {
    const database = getDatabase();
    const cleared = clearDeviceList(database);
    return apiSuccess({ cleared, devices: listDeviceSnapshots(database) });
  } catch (error) {
    return apiError("DEVICE_CLEAR_FAILED", error instanceof Error ? error.message : String(error), 400);
  }
}
