import { runTikTokLiveTapTap } from "@/lib/automation-service";
import { AppError, errorResponse, readJson } from "@/lib/errors";
import { normalizeContentUrl, tiktokLiveTapTapSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = tiktokLiveTapTapSchema.parse(await readJson(request));
    let url: string;
    try {
      url = normalizeContentUrl("tiktok", input.url);
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : "Enlace inválido.",
        400,
        "INVALID_CONTENT_URL",
      );
    }
    const result = await runTikTokLiveTapTap({ ...input, url });
    return Response.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
