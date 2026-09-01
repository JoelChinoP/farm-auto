import { errorResponse } from "@/lib/errors";
import { abortAllProcesses } from "@/lib/process-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await abortAllProcesses();
    return Response.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
