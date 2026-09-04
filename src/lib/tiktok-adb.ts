export const TIKTOK_PACKAGE = "com.zhiliaoapp.musically";

export function tiktokLaunchAdbCommands(deviceId: string, url: string) {
  return [
    [
      "-s",
      deviceId,
      "shell",
      "monkey",
      "-p",
      TIKTOK_PACKAGE,
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
      url,
      "-p",
      TIKTOK_PACKAGE,
    ],
  ];
}
