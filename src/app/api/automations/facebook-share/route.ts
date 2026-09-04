import { shareFacebookPostOnDevices } from "@/lib/automation-service";
import { AppError, errorResponse, readJson } from "@/lib/errors";
import { facebookShareSchema, normalizeContentUrl } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = facebookShareSchema.parse(await readJson(request));
    let url: string;
    try {
      url = normalizeContentUrl("facebook", input.url);
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : "Enlace inválido.",
        400,
        "INVALID_CONTENT_URL",
      );
    }
    const result = await shareFacebookPostOnDevices({ ...input, url });
    return Response.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
