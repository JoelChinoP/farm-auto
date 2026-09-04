import { resolve } from "node:path";

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} debe ser un entero positivo.`);
  return value;
}

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
  artifactsPath: process.env.ARTIFACTS_PATH?.trim() || resolve(process.cwd(), "data", "appium-artifacts"),
  adbTimeoutMs: positiveInteger("ADB_TIMEOUT_MS", 10_000),
  appiumTimeoutMs: positiveInteger("APPIUM_TIMEOUT_MS", 30_000),
  cleanupTimeoutMs: positiveInteger("CLEANUP_TIMEOUT_MS", 15_000),
  workerLeaseMs: positiveInteger("WORKER_LEASE_MS", 15_000),
  workerPollMs: positiveInteger("WORKER_POLL_MS", 500),
});
