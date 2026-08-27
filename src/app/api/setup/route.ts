import { setupAutomations } from "@/lib/automation-service";
import { errorResponse, readJson } from "@/lib/errors";
import { setupSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = setupSchema.parse(await readJson(request));
    const automations = await setupAutomations(input.deviceId);
    return Response.json({ success: true, data: { automations } });
  } catch (error) {
    return errorResponse(error);
  }
}
