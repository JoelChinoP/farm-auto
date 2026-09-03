import { resolve } from "node:path";

function localUrl(value: string) {
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("APPIUM_URL debe ser una URL HTTP local sin credenciales.");
  }
  return url.toString().replace(/\/$/, "");
}

export const appConfig = Object.freeze({
  databasePath:
    process.env.DATABASE_PATH?.trim() ||
    resolve(process.cwd(), "data", "farm-appium.sqlite"),
  appiumUrl: localUrl(process.env.APPIUM_URL || "http://127.0.0.1:4723"),
  adbPath: process.env.ADB_PATH?.trim() || "adb",
});
