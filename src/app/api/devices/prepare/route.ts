import { getDatabase } from "@/lib/database";
import { apiError, apiSuccess } from "@/lib/http";
import { createOperation, IdempotencyConflictError } from "@/lib/operations";
import { enqueueJob } from "@/lib/queue";
import { validateMutationRequest } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const securityError = validateMutationRequest(request);
  if (securityError) return apiError(securityError.code, securityError.message, 403);

  try {
    const body = await request.json() as Record<string, unknown>;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!deviceId) throw new TypeError("deviceId es obligatorio.");

    const database = getDatabase();
    const { created, job } = database.transaction(() => {
      const created = createOperation(database, {
        kind: "device.prepare",
        idempotencyKey,
        request: { deviceId },
        deviceId,
      });
      const job = enqueueJob(database, "device.prepare", { deviceId }, {
        operationId: created.operation.id,
        maxAttempts: 1,
      });
      return { created, job };
    }).immediate();
    const status = ["pending", "running"].includes(created.operation.status) ? 202 : 200;
    return apiSuccess({ operation: created.operation, jobId: job.id, replayed: created.replayed }, status);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return apiError(error.code, error.message, 409);
    }
    return apiError("PREPARATION_INVALID", error instanceof Error ? error.message : String(error), 400);
  }
}
