import { getDeviceCapabilities, listAdbDevices } from "@/lib/adb";
import { getAppiumHealth } from "@/lib/appium";
import { SETUP_REVISION } from "@/lib/automation-service";
import { appConfig } from "@/lib/config";
import {
  listDevicePreparation,
  listDeviceProfiles,
  listDrafts,
  listOperations,
} from "@/lib/db";
import { getFacebookBatchSnapshot } from "@/lib/facebook-batch-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [health, adbDevices] = await Promise.all([
    getAppiumHealth(),
    listAdbDevices().catch(() => []),
  ]);
  const adbWithCapabilities = await Promise.all(
    adbDevices.map(async (device) => ({
      ...device,
      capabilities:
        device.state === "device"
          ? await getDeviceCapabilities(device.id).catch(() => null)
          : null,
    })),
  );
  const adbById = new Map(adbWithCapabilities.map((device) => [device.id, device]));
  const profiles = listDeviceProfiles();
  const profiledDevices = profiles.map((profile) => {
    const connected = adbById.get(profile.device_id);
    if (connected) adbById.delete(profile.device_id);
    return {
      id: profile.device_id,
      state: connected?.state ?? "disconnected",
      model: connected?.model ?? profile.alias,
      product: connected?.product,
      profile,
      capabilities: connected?.capabilities ?? null,
    };
  });
  const devices = [
    ...profiledDevices,
    ...[...adbById.values()].map((pending) => ({ ...pending, profile: null })),
  ];

  return Response.json({
    success: true,
    data: {
      health,
      deepSeek: {
        configured: Boolean(appConfig.deepSeekApiKey),
        model: appConfig.deepSeekModel,
      },
      setup: {
        revision: SETUP_REVISION,
        devices: listDevicePreparation(),
      },
      devices,
      drafts: listDrafts(),
      operations: listOperations(),
      facebookBatch: getFacebookBatchSnapshot(),
      polledAt: new Date().toISOString(),
    },
  });
}
