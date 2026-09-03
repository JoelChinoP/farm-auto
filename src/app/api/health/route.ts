import { getDatabase } from "@/lib/database";
import { getQueueStats } from "@/lib/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const database = getDatabase();
  database.prepare("SELECT 1").get();

  return Response.json({
    success: true,
    data: {
      status: "ready",
      database: "ready",
      queue: getQueueStats(database),
      checkedAt: new Date().toISOString(),
    },
  });
}
