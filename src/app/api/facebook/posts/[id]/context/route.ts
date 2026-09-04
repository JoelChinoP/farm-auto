import { getDatabase } from "@/lib/database";
import { editFacebookPostContext, FacebookError, restoreFacebookExtractedContext } from "@/lib/facebook";
import { apiError, apiSuccess } from "@/lib/http";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const database = getDatabase();
    const postId = (await context.params).id;
    const row = database.prepare(`
      SELECT campaign_id FROM posts WHERE id = ?
    `).get(postId) as { campaign_id: string } | undefined;
    if (!row) return apiError("POST_NOT_FOUND", "La publicacion no existe.", 404);
    const body = await request.json() as Record<string, unknown>;
    const campaign = body.restoreExtracted === true
      ? restoreFacebookExtractedContext(database, row.campaign_id, postId)
      : editFacebookPostContext(database, row.campaign_id, postId, body.context);
    return apiSuccess({ campaign });
  } catch (error) {
    if (error instanceof FacebookError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("CONTEXT_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
