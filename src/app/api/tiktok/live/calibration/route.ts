import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { validateMutationRequest } from "@/lib/request-security";
import { recordTikTokLiveCalibration, TikTokError } from "@/lib/tiktok";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.confirmed !== true) {
      return apiError("EXPLICIT_CONFIRMATION_REQUIRED", "Confirma que el punto medido coincide con el toque físico.", 409);
    }
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const x = Number(body.x);
    const y = Number(body.y);
    const calibration = recordTikTokLiveCalibration(getDatabase(), deviceId, x, y);
    return apiSuccess({ calibration });
  } catch (error) {
    if (error instanceof TikTokError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("TIKTOK_LIVE_CALIBRATION_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
