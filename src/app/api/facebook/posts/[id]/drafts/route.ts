import { errorResponse, readJson } from "@/lib/errors";
import {
  cancelPostDraftGeneration,
  generatePostDrafts,
} from "@/lib/facebook-batch-service";
import { facebookDraftsSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const input = facebookDraftsSchema.parse(await readJson(request));
    const { id } = await params;
    const batch = await generatePostDrafts({
      postId: id,
      ...input,
      signal: request.signal,
    });
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const batch = cancelPostDraftGeneration((await params).id);
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
