import { getDatabase } from "@/lib/database";
import {
  FacebookError,
  getFacebookCampaignSnapshot,
  requestFacebookCampaignPublication,
  requestFacebookCampaignExecution,
  requestFacebookCampaignSchedule,
} from "@/lib/facebook";
import { apiError, apiSuccess } from "@/lib/http";
import { IdempotencyConflictError } from "@/lib/operations";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const campaign = getFacebookCampaignSnapshot(getDatabase(), (await context.params).id);
  return campaign
    ? apiSuccess({ campaign })
    : apiError("CAMPAIGN_NOT_FOUND", "La campana no existe.", 404);
}

export async function POST(request: Request, context: RouteContext<"/api/facebook/campaigns/[id]">) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    const campaignId = (await context.params).id;
    if (body.action === "publish") {
      const result = requestFacebookCampaignPublication(getDatabase(), campaignId);
      return apiSuccess({ campaign: result.campaign, jobIds: result.jobs.map((job) => job.id), replayed: result.replayed });
    }
    const result = Array.isArray(body.assignments)
      ? requestFacebookCampaignSchedule(getDatabase(), campaignId, body)
      : requestFacebookCampaignExecution(getDatabase(), campaignId, body);
    const status = ["pending", "running"].includes(result.operation.status) ? 202 : 200;
    return apiSuccess({
      operation: result.operation,
      jobId: "job" in result ? result.job.id : null,
      campaign: "campaign" in result ? result.campaign : null,
      replayed: result.replayed,
    }, status);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return apiError(error.code, error.message, 409);
    if (error instanceof FacebookError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("EXECUTION_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
