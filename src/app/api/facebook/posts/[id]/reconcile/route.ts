import { errorResponse, readJson } from "@/lib/errors";
import { reconcilePostOutcomes } from "@/lib/facebook-batch-service";
import { facebookReconcileSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const input = facebookReconcileSchema.parse(await readJson(request));
    const { id } = await params;
    const batch = reconcilePostOutcomes(id, input.outcomes);
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
