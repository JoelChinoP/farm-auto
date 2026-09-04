import { clearOperationalHistory } from "@/lib/db";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return Response.json({ success: true, data: clearOperationalHistory() });
  } catch (error) {
    return errorResponse(error);
  }
}
