import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { IdempotencyConflictError } from "@/lib/operations";
import { validateMutationRequest } from "@/lib/request-security";
import { requestTikTokLiveExecution, TikTokError } from "@/lib/tiktok";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const result = requestTikTokLiveExecution(getDatabase(), await request.json());
    return apiSuccess({
      operation: result.operation,
      jobId: result.job.id,
      campaign: result.campaign,
      replayed: result.replayed,
    }, ["pending", "running"].includes(result.operation.status) ? 202 : 200);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return apiError(error.code, error.message, 409);
    if (error instanceof TikTokError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("TIKTOK_LIVE_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
