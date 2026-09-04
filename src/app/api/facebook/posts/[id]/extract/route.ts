import { getDatabase } from "@/lib/database";
import { FacebookError, requestFacebookPostOperation } from "@/lib/facebook";
import { apiError, apiSuccess } from "@/lib/http";
import { IdempotencyConflictError } from "@/lib/operations";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    const queued = requestFacebookPostOperation(getDatabase(), {
      postId: (await context.params).id,
      kind: "post.extract",
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
    });
    const status = ["pending", "running"].includes(queued.operation.status) ? 202 : 200;
    return apiSuccess({ operation: queued.operation, jobId: queued.job.id, replayed: queued.replayed }, status);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return apiError(error.code, error.message, 409);
    if (error instanceof FacebookError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("EXTRACTION_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
