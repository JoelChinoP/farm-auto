import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { validateMutationRequest } from "@/lib/request-security";
import { editTikTokComment, TikTokError } from "@/lib/tiktok";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    const campaign = editTikTokComment(getDatabase(), (await context.params).id, {
      text: body.text,
      intention: body.intention,
      tone: body.tone,
    });
    return apiSuccess({ campaign });
  } catch (error) {
    if (error instanceof TikTokError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("COMMENT_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
