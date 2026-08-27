import { goHome } from "@/lib/automation-service";
import { errorResponse, readJson } from "@/lib/errors";
import { deviceActionSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = deviceActionSchema.parse(await readJson(request));
    const result = await goHome(input.deviceId, input.idempotencyKey);
    return Response.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
