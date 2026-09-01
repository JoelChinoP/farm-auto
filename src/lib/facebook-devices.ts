import facebookDevices from "../config/facebook-devices.json" with { type: "json" };

export const configuredFacebookDevices = facebookDevices.devices;
export const configuredFacebookDeviceIds = configuredFacebookDevices.map(
  (device) => device.deviceId,
);

const configuredFacebookDeviceIdSet = new Set(configuredFacebookDeviceIds);

export function isConfiguredFacebookDevice(deviceId: string) {
  return configuredFacebookDeviceIdSet.has(deviceId);
}

export function getConfiguredFacebookDevice(deviceId: string) {
  return configuredFacebookDevices.find((device) => device.deviceId === deviceId) ?? null;
}
