import { errorResponse, readJson } from "@/lib/errors";
import { generatePostDrafts } from "@/lib/facebook-batch-service";
import { facebookDraftsSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const input = facebookDraftsSchema.parse(await readJson(request));
    const { id } = await params;
    const batch = await generatePostDrafts({ postId: id, ...input });
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
