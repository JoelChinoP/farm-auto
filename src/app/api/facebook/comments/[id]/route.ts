import { getDatabase } from "@/lib/database";
import { editFacebookComment, FacebookError } from "@/lib/facebook";
import { apiError, apiSuccess } from "@/lib/http";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    const campaign = editFacebookComment(getDatabase(), (await context.params).id, {
      text: body.text,
      intention: body.intention,
      tone: body.tone,
    });
    return apiSuccess({ campaign });
  } catch (error) {
    if (error instanceof FacebookError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("COMMENT_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
