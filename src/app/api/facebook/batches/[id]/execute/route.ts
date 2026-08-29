import { errorResponse, readJson } from "@/lib/errors";
import { executeFacebookBatch } from "@/lib/facebook-batch-service";
import { facebookBatchExecuteSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const input = facebookBatchExecuteSchema.parse(await readJson(request));
    const { id } = await params;
    const batch = await executeFacebookBatch(id, input);
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
