import { errorResponse, readJson } from "@/lib/errors";
import { approveMessage } from "@/lib/messages";
import { approveDraftSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const input = approveDraftSchema.parse(await readJson(request));
    const { id } = await params;
    const draft = approveMessage(id, input);
    return Response.json({ success: true, data: { draft } });
  } catch (error) {
    return errorResponse(error);
  }
}
