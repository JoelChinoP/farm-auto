export const FACEBOOK_PACKAGE = "com.facebook.katana";

function normalizeFacebookDeviceUrl(value: string) {
  const url = new URL(value);
  if (url.hostname.toLowerCase().endsWith("facebook.com")) {
    url.hostname = "www.facebook.com";
  }
  return url.toString();
}

export function facebookLaunchAdbCommands(deviceId: string, url: string) {
  return [
    [
      "-s",
      deviceId,
      "shell",
      "monkey",
      "-p",
      FACEBOOK_PACKAGE,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ],
    [
      "-s",
      deviceId,
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      normalizeFacebookDeviceUrl(url),
      "-p",
      FACEBOOK_PACKAGE,
    ],
  ];
}

export function facebookCloseAdbCommand(deviceId: string) {
  return [
    "-s",
    deviceId,
    "shell",
    "am",
    "force-stop",
    FACEBOOK_PACKAGE,
  ];
}
