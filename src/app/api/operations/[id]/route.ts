import { getDatabase } from "@/lib/database";
import { requestFacebookExecutionCancellation } from "@/lib/facebook";
import { apiError, apiSuccess } from "@/lib/http";
import { getOperation } from "@/lib/operations";
import { getJob, requestJobCancellation } from "@/lib/queue";
import { validateMutationRequest } from "@/lib/request-security";
import { requestTikTokExecutionCancellation } from "@/lib/tiktok";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext<"/api/operations/[id]">) {
  const { id } = await context.params;
  const operation = getOperation(getDatabase(), id);
  return operation
    ? apiSuccess({ operation })
    : apiError("OPERATION_NOT_FOUND", "La operacion no existe.", 404);
}

export async function DELETE(request: Request, context: RouteContext<"/api/operations/[id]">) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);
  const { id } = await context.params;
  const database = getDatabase();
  const job = database.transaction(() => {
    const row = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(id) as { id: string } | undefined;
    if (!row) return null;
    const current = getJob(database, row.id)!;
    if (!["pending", "running"].includes(current.status)) return current;
    const result = current.result;
    if (result && typeof result === "object" && "domainCommitted" in result && result.domainCommitted === true) {
      return current;
    }
    const platform = current.campaignId
      ? (database.prepare("SELECT platform FROM campaigns WHERE id = ?").get(current.campaignId) as { platform: string } | undefined)?.platform
      : null;
    const cancelled = current.kind === "assignment.execute"
      ? platform === "tiktok"
        ? requestTikTokExecutionCancellation(database, row.id)
        : requestFacebookExecutionCancellation(database, row.id)
      : requestJobCancellation(database, row.id);
    if (!current.postId || !current.campaignId) return cancelled;
    const now = Date.now();
    if (current.kind === "assignment.execute" && current.assignmentId) {
      return cancelled;
    } else if (current.kind === "post.extract") {
      const post = database.prepare("SELECT context, context_status FROM posts WHERE id = ?")
        .get(current.postId) as { context: string | null; context_status: string };
      const hasContext = Boolean(post.context?.trim()) && ["ready", "cached", "edited"].includes(post.context_status);
      database.prepare("UPDATE posts SET status = ?, context_status = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(hasContext ? "context_ready" : "cancelled", hasContext ? post.context_status : "failed", "Extraccion cancelada por el operador.", now, current.postId);
    } else if (current.kind === "comments.generate") {
      database.prepare("UPDATE posts SET status = 'context_ready', error = ?, updated_at = ? WHERE id = ?")
        .run("Generacion cancelada por el operador.", now, current.postId);
      database.prepare("UPDATE assignments SET status = 'pending', updated_at = ? WHERE post_id = ? AND status = 'generating'")
        .run(now, current.postId);
      database.prepare(`
        UPDATE comments SET status = 'failed', stale = 1,
          error = 'Generacion cancelada por el operador.', updated_at = ?
        WHERE assignment_id IN (SELECT id FROM assignments WHERE post_id = ?)
          AND version = (SELECT MAX(c2.version) FROM comments c2 WHERE c2.assignment_id = comments.assignment_id)
          AND status IN ('generating', 'regenerating')
      `).run(now, current.postId);
    }
    database.prepare("UPDATE campaigns SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(now, current.campaignId);
    return cancelled;
  }).immediate();
  if (!job) return apiError("OPERATION_NOT_FOUND", "La operacion no existe o no tiene trabajo asociado.", 404);
  const operation = getOperation(database, id);
  const status = job.status === "running" ? 202 : 200;
  return apiSuccess({ operation, job }, status);
}
