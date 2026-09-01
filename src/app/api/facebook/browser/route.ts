import {
  closeFacebookBrowser,
  getFacebookBrowserStatus,
  openFacebookBrowser,
} from "@/lib/facebook-browser";
import { errorResponse, readJson } from "@/lib/errors";
import { facebookBrowserActionSchema } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const browser = await getFacebookBrowserStatus();
    return Response.json({ success: true, data: { browser } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = facebookBrowserActionSchema.parse(await readJson(request));
    const browser =
      input.action === "open"
        ? await openFacebookBrowser()
        : await closeFacebookBrowser();
    return Response.json({ success: true, data: { browser } });
  } catch (error) {
    return errorResponse(error);
  }
}
