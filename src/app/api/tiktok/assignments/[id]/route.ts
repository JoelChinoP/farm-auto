import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { IdempotencyConflictError } from "@/lib/operations";
import { validateMutationRequest } from "@/lib/request-security";
import { reconcileTikTokAssignment, TikTokError } from "@/lib/tiktok";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    return apiSuccess(reconcileTikTokAssignment(getDatabase(), (await context.params).id, await request.json()));
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return apiError(error.code, error.message, 409);
    if (error instanceof TikTokError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("RECONCILIATION_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
