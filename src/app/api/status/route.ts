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
import { automationSpecs } from "@/lib/automation-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [health, adbDevices] = await Promise.all([
    getGenFarmerHealth(),
    listAdbDevices().catch(() => []),
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

  return Response.json({
    success: true,
    data: {
      health,
      deepSeek: {
        configured: Boolean(appConfig.deepSeekApiKey),
        model: appConfig.deepSeekModel,
      },
      setup: {
        requiredSlugs: automationSpecs.map((spec) => spec.slug),
        devices: listDevicePreparation(),
      },
      devices,
      automations: listRegistry(),
      drafts: listDrafts(),
      operations: listOperations(),
      facebookBatch: getFacebookBatchSnapshot(),
      polledAt: new Date().toISOString(),
    },
  });
}
