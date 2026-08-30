import { upsertDeviceProfiles } from "@/lib/db";
import { errorResponse, readJson } from "@/lib/errors";
import { deviceProfilesSchema } from "@/lib/schemas";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = deviceProfilesSchema.parse(await readJson(request));
    const profiles = upsertDeviceProfiles(
      input.profiles.map((profile) => ({
        hardware_id: profile.hardwareId,
        device_id: profile.deviceId,
        alias: profile.alias,
        physical_order: profile.physicalOrder,
        system_port: profile.systemPort,
      })),
    );
    return Response.json({ success: true, data: { profiles } });
  } catch (error) {
    return errorResponse(error);
  }
}
