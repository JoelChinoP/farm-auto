import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { createOperation, IdempotencyConflictError } from "@/lib/operations";
import { enqueueJob } from "@/lib/queue";
import { validateMutationRequest } from "@/lib/request-security";
import {
  assertTikTokDeviceEligible,
  listTikTokCampaignSnapshots,
  readTikTokConfig,
  TikTokError,
  validateTikTokCampaignRequest,
} from "@/lib/tiktok";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const config = readTikTokConfig();
  const history = listTikTokCampaignSnapshots(getDatabase());
  return apiSuccess({
    campaign: history.find((campaign) => campaign.mode === "post") ?? null,
    history,
    configuration: {
      controlledAccount: config.controlledAccount || null,
      postEffectsEnabled: config.publicEffectsEnabled,
      liveEffectsEnabled: config.liveEffectsEnabled,
      postSelectorsConfigured: Boolean(config.accountResourceId && config.postContainerResourceId && config.postUrlResourceId),
      commentSelectorsConfigured: Boolean(
        config.commentComposerResourceId
        && config.commentEditorResourceId
        && config.commentSubmitResourceId
        && config.commentResultContainerResourceId,
      ),
      liveSelectorsConfigured: Boolean(config.accountResourceId && config.liveContainerResourceId && config.liveUrlResourceId),
      liveCalibration: config.liveCalibration,
    },
  });
}

export async function POST(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  try {
    const body = await request.json() as Record<string, unknown>;
    const input = validateTikTokCampaignRequest(body);
    const database = getDatabase();
    assertTikTokDeviceEligible(database, input.deviceIds[0]);
    const { created, job } = database.transaction(() => {
      const created = createOperation(database, {
        kind: "campaign.create",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
        request: input,
      });
      const job = enqueueJob(database, "campaign.create", input, {
        operationId: created.operation.id,
        maxAttempts: 2,
      });
      return { created, job };
    }).immediate();
    return apiSuccess({ operation: created.operation, jobId: job.id, replayed: created.replayed }, ["pending", "running"].includes(created.operation.status) ? 202 : 200);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return apiError(error.code, error.message, 409);
    if (error instanceof TikTokError) return apiError(error.code, error.message, error.status, error.details);
    return apiError("CAMPAIGN_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
