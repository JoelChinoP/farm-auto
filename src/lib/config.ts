import { config as loadEnv } from "dotenv";
import { homedir } from "node:os";
import { resolve } from "node:path";

loadEnv({
  path: resolve(process.cwd(), ".env"),
  quiet: true,
});

function localUrl(value: string) {
  const url = new URL(value);
  if (
    ![
      "127.0.0.1",
      "localhost",
      "[::1]",
      "::1",
    ].includes(url.hostname)
  ) {
    throw new Error("APPIUM_URL debe apuntar al equipo local.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("APPIUM_URL no es una URL HTTP local válida.");
  }
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const commentMinWords = positiveInteger(process.env.COMMENT_MIN_WORDS, 3);
const commentMaxWords = Math.max(
  commentMinWords,
  positiveInteger(process.env.COMMENT_MAX_WORDS, 15),
);

function defaultFacebookBrowserProfilePath() {
  const localData =
    process.env.LOCALAPPDATA?.trim() ||
    process.env.XDG_DATA_HOME?.trim() ||
    resolve(homedir(), ".local", "share");
  return resolve(localData, "farm-auto", "facebook-browser-profile");
}

export const appConfig = Object.freeze({
  appiumUrl: localUrl(process.env.APPIUM_URL ?? "http://127.0.0.1:4723"),
  deepSeekApiKey: process.env.API_DEEPSEEK?.trim() ?? "",
  deepSeekModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
  deepSeekGenerationConcurrency: Math.min(
    4,
    positiveInteger(process.env.DEEPSEEK_GENERATION_CONCURRENCY, 4),
  ),
  commentGenerationPrompt:
    process.env.COMMENT_GENERATION_PROMPT?.trim() ||
    "Escribe como una persona peruana comentando en redes sociales. Usa un estilo natural, casual y con ortografia relajada: omite ocasionalmente tildes, mayusculas o puntuacion, sin dificultar la lectura. Relaciona cada comentario con el contexto y la intencion indicados. No inventes experiencias o identidades, no uses tono corporativo, elogios genericos, hashtags ni spam.",
  commentMinWords,
  commentMaxWords,
  facebookBrowserExecutablePath:
    process.env.FACEBOOK_BROWSER_EXECUTABLE_PATH?.trim() || undefined,
  facebookBrowserProfilePath:
    process.env.FACEBOOK_BROWSER_PROFILE_PATH?.trim() ||
    defaultFacebookBrowserProfilePath(),
  adbPath: process.env.ADB_PATH?.trim(),
  databasePath:
    process.env.CONTROL_PANEL_DB_PATH?.trim() ||
    resolve(process.cwd(), "data", "control-panel.sqlite"),
  appiumArtifactsPath: resolve(process.cwd(), "data", "appium-artifacts"),
});
