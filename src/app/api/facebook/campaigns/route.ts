import { getDatabase } from "@/lib/database";
import {
  assertFacebookCampaignDevicesEligible,
  FacebookError,
  getLatestFacebookCampaignSnapshot,
  listFacebookCampaignSnapshots,
  validateFacebookCampaignRequest,
} from "@/lib/facebook";
import { apiError, apiSuccess } from "@/lib/http";
import { createOperation, IdempotencyConflictError } from "@/lib/operations";
import { enqueueJob } from "@/lib/queue";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const database = getDatabase();
  return apiSuccess({
    campaign: getLatestFacebookCampaignSnapshot(database),
    history: listFacebookCampaignSnapshots(database),
  });
}

export async function POST(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    const input = validateFacebookCampaignRequest(body);
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    const database = getDatabase();
    assertFacebookCampaignDevicesEligible(database, input.deviceIds);
    const { created, job } = database.transaction(() => {
      const created = createOperation(database, {
        kind: "campaign.create",
        idempotencyKey,
        request: input,
      });
      const job = enqueueJob(database, "campaign.create", input, {
        operationId: created.operation.id,
        maxAttempts: 2,
      });
      return { created, job };
    }).immediate();
    const status = ["pending", "running"].includes(created.operation.status) ? 202 : 200;
    return apiSuccess({ operation: created.operation, jobId: job.id, replayed: created.replayed }, status);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return apiError(error.code, error.message, 409);
    if (error instanceof FacebookError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("CAMPAIGN_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
