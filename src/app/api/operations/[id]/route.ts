import { cancelOperation } from "@/lib/automation-service";
import { getOperation } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const operation = getOperation((await params).id);
    if (!operation) throw new AppError("Operación no encontrada.", 404, "NOT_FOUND");
    return Response.json({ success: true, data: { operation } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const operation = await cancelOperation((await params).id);
    return Response.json({ success: true, data: { operation } });
  } catch (error) {
    return errorResponse(error);
  }
}
