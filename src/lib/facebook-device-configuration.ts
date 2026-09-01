import "server-only";

import type { AdbDevice } from "@/lib/adb";
import { listDeviceProfiles, upsertDeviceProfiles } from "@/lib/db";
import { configuredFacebookDevices } from "@/lib/facebook-devices";

type DeviceWithCapabilities = AdbDevice & {
  capabilities: null | { hardwareId: string };
};

export function syncConfiguredFacebookDeviceProfiles(
  devices: DeviceWithCapabilities[],
) {
  const profiles = listDeviceProfiles();
  const profilesByHardwareId = new Map(
    profiles.map((profile) => [profile.hardware_id, profile]),
  );
  const profilesByDeviceId = new Map(
    profiles.map((profile) => [profile.device_id, profile]),
  );
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  const profilesToSave = configuredFacebookDevices.flatMap((configured) => {
    const device = devicesById.get(configured.deviceId);
    const hardwareId = device?.capabilities?.hardwareId;
    if (device?.state !== "device" || !hardwareId) return [];

    const current = profilesByHardwareId.get(hardwareId);
    const profileForDevice = profilesByDeviceId.get(configured.deviceId);
    // A changed hardware identity requires explicit review rather than silently
    // transferring a profile to another phone.
    if (profileForDevice && profileForDevice.hardware_id !== hardwareId) return [];
    if (
      current &&
      current.device_id === configured.deviceId &&
      current.alias === configured.alias &&
      current.physical_order === configured.physicalOrder &&
      current.system_port === configured.systemPort
    ) {
      return [];
    }

    return [
      {
        hardware_id: hardwareId,
        device_id: configured.deviceId,
        alias: configured.alias,
        physical_order: configured.physicalOrder,
        system_port: configured.systemPort,
      },
    ];
  });

  if (profilesToSave.length) upsertDeviceProfiles(profilesToSave);
}
