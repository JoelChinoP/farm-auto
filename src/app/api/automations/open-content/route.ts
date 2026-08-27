import { openSocialContent } from "@/lib/automation-service";
import { AppError, errorResponse, readJson } from "@/lib/errors";
import { normalizeContentUrl, openContentSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = openContentSchema.parse(await readJson(request));
    let url: string;
    try {
      url = normalizeContentUrl(input.platform, input.url);
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : "Enlace inválido.",
        400,
        "INVALID_CONTENT_URL",
      );
    }
    const result = await openSocialContent({ ...input, url });
    return Response.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
