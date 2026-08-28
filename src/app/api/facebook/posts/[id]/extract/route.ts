import { errorResponse, readJson } from "@/lib/errors";
import { extractPostContext } from "@/lib/facebook-batch-service";
import { facebookExtractSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const input = facebookExtractSchema.parse(await readJson(request));
    const { id } = await params;
    const batch = await extractPostContext({ postId: id, ...input });
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
