import "server-only";

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({
  path: resolve(process.cwd(), ".env"),
  quiet: true,
  override: true,
});

function localUrl(value: string) {
  const url = new URL(value);
  if (
    ![
      "127.0.0.1",
      "localhost",
      "[::1]",
      "::1",
      "host.docker.internal",
    ].includes(url.hostname)
  ) {
    throw new Error("GENFARMER_URL debe apuntar al equipo local.");
  }
  return url.toString().replace(/\/$/, "");
}

const userId = Number.parseInt(process.env.GENFARMER_USER_ID ?? "30331", 10);
if (!Number.isInteger(userId) || userId <= 0) {
  throw new Error("GENFARMER_USER_ID no es válido.");
}

export const appConfig = Object.freeze({
  genFarmerUrl: localUrl(
    process.env.GENFARMER_URL ?? "http://127.0.0.1:55554",
  ),
  genFarmerUserId: userId,
  deepSeekApiKey: process.env.API_DEEPSEEK?.trim() ?? "",
  deepSeekModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
  adbPath: process.env.ADB_PATH?.trim(),
  databasePath:
    process.env.CONTROL_PANEL_DB_PATH?.trim() ||
    resolve(process.cwd(), "data", "control-panel.sqlite"),
});
