import { errorResponse, readJson } from "@/lib/errors";
import { generateDraft } from "@/lib/messages";
import { draftInputSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = draftInputSchema.parse(await readJson(request));
    const draft = await generateDraft(input);
    return Response.json({ success: true, data: { draft } });
  } catch (error) {
    return errorResponse(error);
  }
}
