import { getDatabase } from "@/lib/database";
import { requestDeviceRetirement } from "@/lib/device-runtime";
import { apiError, apiSuccess } from "@/lib/http";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const retirement = requestDeviceRetirement(getDatabase(), (await context.params).id);
    return apiSuccess({ retirement }, retirement.status === "pending" ? 202 : 200);
  } catch (error) {
    return apiError("DEVICE_RETIREMENT_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
