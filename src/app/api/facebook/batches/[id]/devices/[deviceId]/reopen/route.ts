import { errorResponse } from "@/lib/errors";
import { reopenFacebookBatchDevice } from "@/lib/facebook-batch-service";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; deviceId: string }> },
) {
  try {
    const { id, deviceId } = await params;
    const batch = await reopenFacebookBatchDevice(id, deviceId);
    return Response.json({ success: true, data: { batch } });
  } catch (error) {
    return errorResponse(error);
  }
}
