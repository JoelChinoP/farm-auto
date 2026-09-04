import { getDatabase } from "@/lib/database";
import { listDeviceSnapshots, upsertDeviceProfile } from "@/lib/device-runtime";
import { apiError, apiSuccess } from "@/lib/http";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return apiSuccess({ devices: listDeviceSnapshots(getDatabase()) });
}

export async function PUT(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);

  try {
    const body = await request.json() as Record<string, unknown>;
    const profile = upsertDeviceProfile(getDatabase(), {
      hardwareId: typeof body.hardwareId === "string" ? body.hardwareId : "",
      deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
      alias: typeof body.alias === "string" ? body.alias : "",
      physicalOrder: body.physicalOrder as number,
      systemPort: body.systemPort as number,
    });
    return apiSuccess({ profile });
  } catch (error) {
    return apiError("DEVICE_PROFILE_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
