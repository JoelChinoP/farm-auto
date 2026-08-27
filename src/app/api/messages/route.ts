import { listDrafts } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ success: true, data: { drafts: listDrafts(100) } });
}
