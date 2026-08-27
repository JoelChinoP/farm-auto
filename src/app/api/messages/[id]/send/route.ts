import { errorResponse, readJson } from "@/lib/errors";
import { sendApprovedMessage } from "@/lib/messages";
import { sendDraftSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const input = sendDraftSchema.parse(await readJson(request));
    const { id } = await params;
    const result = await sendApprovedMessage(
      id,
      input.deviceId,
      input.contentUrl,
    );
    return Response.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
