import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { getOperation } from "@/lib/operations";
import { getJob, requestJobCancellation } from "@/lib/queue";
import { validateMutationRequest } from "@/lib/request-security";

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
  const row = database.prepare("SELECT id FROM jobs WHERE operation_id = ?").get(id) as { id: string } | undefined;
  if (!row) return apiError("OPERATION_NOT_FOUND", "La operacion no existe o no tiene trabajo asociado.", 404);

  const job = requestJobCancellation(database, row.id);
  const operation = getOperation(database, id);
  const status = job.status === "running" ? 202 : 200;
  return apiSuccess({ operation, job: getJob(database, row.id) }, status);
}
