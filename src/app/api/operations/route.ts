import { getDatabase } from "@/lib/database";
import { requestFacebookExecutionCancellation } from "@/lib/facebook";
import { apiError, apiSuccess } from "@/lib/http";
import { requestJobCancellation } from "@/lib/queue";
import { validateMutationRequest } from "@/lib/request-security";
import { requestTikTokExecutionCancellation } from "@/lib/tiktok";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function DELETE(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  const database = getDatabase();
  const cancelled = database.transaction(() => {
    const jobs = database.prepare(`
      SELECT j.id, j.kind, j.status, j.campaign_id, j.post_id, j.assignment_id,
        j.operation_id, j.result_json, c.platform
      FROM jobs j LEFT JOIN campaigns c ON c.id = j.campaign_id
      WHERE j.status IN ('pending', 'running')
    `).all() as Array<{
      id: string;
      kind: string;
      status: "pending" | "running";
      campaign_id: string | null;
      post_id: string | null;
      assignment_id: string | null;
      operation_id: string | null;
      result_json: string | null;
      platform: string | null;
    }>;
    const now = Date.now();
    database.prepare(`
      UPDATE campaigns SET status = 'cancellation_requested',
        cancellation_reason = 'Cancelacion global solicitada por el operador.', updated_at = ?
      WHERE id IN (
        SELECT campaign_id FROM jobs
        WHERE kind = 'assignment.execute' AND status IN ('pending', 'running')
          AND NOT (
            result_json IS NOT NULL
            AND COALESCE(json_extract(result_json, '$.domainCommitted'), 0) = 1
          )
      )
    `).run(now);
    const campaignIds = new Set<string>();
    let total = 0;
    for (const job of jobs) {
      const result: unknown = job.result_json ? JSON.parse(job.result_json) : null;
      const committed = Boolean(result && typeof result === "object"
        && "domainCommitted" in result
        && result.domainCommitted === true);
      if (committed) continue;
      if (job.kind === "assignment.execute" && job.campaign_id && job.post_id && job.assignment_id && job.operation_id) {
        if (job.platform === "tiktok") requestTikTokExecutionCancellation(database, job.id, { global: true, now });
        else requestFacebookExecutionCancellation(database, job.id, { global: true, now });
        total += 1;
        continue;
      }
      requestJobCancellation(database, job.id, now);
      total += 1;
      if (job.campaign_id) campaignIds.add(job.campaign_id);
    }
    for (const campaignId of campaignIds) {
      database.prepare(`
        UPDATE campaigns SET status = 'cancelled', cancellation_reason = 'Cancelada por el operador.',
          revision = revision + 1, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(now, now, campaignId);
      database.prepare(`
        UPDATE posts SET status = 'cancelled',
          context_status = CASE WHEN context_status IN ('queued', 'extracting') THEN 'failed' ELSE context_status END,
          error = 'Cancelada por el operador.', updated_at = ?
        WHERE campaign_id = ? AND status NOT IN ('completed', 'outcome_unknown')
      `).run(now, campaignId);
      database.prepare(`
        UPDATE assignments SET status = 'cancelled', updated_at = ?, completed_at = ?
        WHERE campaign_id = ? AND status NOT IN ('sent', 'outcome_unknown')
      `).run(now, now, campaignId);
      database.prepare(`
        UPDATE comments SET status = 'failed', stale = 1,
          error = 'Cancelada por el operador.', updated_at = ?
        WHERE assignment_id IN (SELECT id FROM assignments WHERE campaign_id = ?)
          AND version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = comments.assignment_id)
          AND status IN ('pending', 'generating', 'regenerating')
      `).run(now, campaignId);
    }
    return total;
  }).immediate();
  return apiSuccess({ cancelled });
}
