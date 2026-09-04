import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { IdempotencyConflictError } from "@/lib/operations";
import { validateMutationRequest } from "@/lib/request-security";
import { requestTikTokCommentGeneration, TikTokError } from "@/lib/tiktok";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    const queued = requestTikTokCommentGeneration(getDatabase(), {
      postId: (await context.params).id,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      overwriteManual: body.overwriteManual === true,
    });
    return apiSuccess({ operation: queued.operation, jobId: queued.job.id, replayed: queued.replayed }, ["pending", "running"].includes(queued.operation.status) ? 202 : 200);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return apiError(error.code, error.message, 409);
    if (error instanceof TikTokError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("GENERATION_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
