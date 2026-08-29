import { getDeviceCapabilities, listAdbDevices } from "@/lib/adb";
import { appConfig } from "@/lib/config";
import {
  listDevicePreparation,
  listDrafts,
  listOperations,
  listRegistry,
} from "@/lib/db";
import { getDevices, getGenFarmerHealth } from "@/lib/genfarmer";
import { getFacebookBatchSnapshot } from "@/lib/facebook-batch-service";
import { getFacebookBrowserStatus } from "@/lib/facebook-browser";
import { automationSpecs } from "@/lib/automation-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [health, adbDevices, facebookBrowser] = await Promise.all([
    getGenFarmerHealth(),
    listAdbDevices().catch(() => []),
    getFacebookBrowserStatus(),
  ]);
  const genFarmerDevices = health.ok ? await getDevices().catch(() => []) : [];
  const devices = await Promise.all(
    adbDevices.map(async (device) => ({
      ...device,
      genFarmer: genFarmerDevices.find(
        (item) => item.currentDeviceId === device.id,
      ),
      capabilities:
        device.state === "device"
          ? await getDeviceCapabilities(device.id).catch(() => null)
          : null,
    })),
  );
  const devicesByHardware = new Map<string, (typeof devices)[number]>();
  for (const device of devices) {
    const hardwareId = device.capabilities?.hardwareId || device.id;
    const existing = devicesByHardware.get(hardwareId);
    if (!existing || (!existing.genFarmer && device.genFarmer)) {
      devicesByHardware.set(hardwareId, device);
    }
  }

  return Response.json({
    success: true,
    data: {
      health,
      deepSeek: {
        configured: Boolean(appConfig.deepSeekApiKey),
        model: appConfig.deepSeekModel,
      },
      facebookBrowser,
      setup: {
        requiredSlugs: automationSpecs.map((spec) => spec.slug),
        devices: listDevicePreparation(),
      },
      devices: [...devicesByHardware.values()],
      automations: listRegistry(),
      drafts: listDrafts(),
      operations: listOperations(),
      facebookBatch: getFacebookBatchSnapshot(),
      polledAt: new Date().toISOString(),
    },
  });
}
