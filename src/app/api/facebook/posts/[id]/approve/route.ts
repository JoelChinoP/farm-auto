import { errorResponse, readJson } from "@/lib/errors";
import { approvePostDrafts } from "@/lib/facebook-batch-service";
import { facebookApproveSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const input = facebookApproveSchema.parse(await readJson(request));
    const { id } = await params;
    const batch = approvePostDrafts(id, input.comments);
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
