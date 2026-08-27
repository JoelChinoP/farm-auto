import { errorResponse } from "@/lib/errors";
import { getRun, stopRun } from "@/lib/genfarmer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const run = await getRun(id);
    return Response.json({ success: true, data: { run } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await stopRun(id);
    return Response.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
