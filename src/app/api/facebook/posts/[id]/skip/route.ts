import { errorResponse } from "@/lib/errors";
import { skipFacebookPost } from "@/lib/facebook-batch-service";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const batch = skipFacebookPost(id);
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
