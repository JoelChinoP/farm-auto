import { errorResponse, readJson } from "@/lib/errors";
import { startFacebookBatch } from "@/lib/facebook-batch-service";
import { facebookBatchSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = facebookBatchSchema.parse(await readJson(request));
    const batch = await startFacebookBatch(input.urls, input.deviceIds);
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
