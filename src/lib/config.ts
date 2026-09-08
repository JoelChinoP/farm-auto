import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

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

function facebookProfilePath() {
  const root = process.env.LOCALAPPDATA?.trim() || resolve(homedir(), ".farm-appium");
  const path = resolve(
    process.env.FACEBOOK_BROWSER_PROFILE_PATH?.trim() || root,
    process.env.FACEBOOK_BROWSER_PROFILE_PATH?.trim() ? "" : "facebook-edge-profile",
  );
  const workspaceRelative = relative(resolve(/* turbopackIgnore: true */ process.cwd()), path);
  if (!workspaceRelative || (!workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative))) {
    throw new Error("FACEBOOK_BROWSER_PROFILE_PATH debe estar fuera del repositorio.");
  }
  return path;
}

function labels(name: string, fallback: string) {
  const values = (process.env[name]?.trim() || fallback).split("|").map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error(`${name} debe contener al menos una etiqueta.`);
  return values;
}

const commentMinWords = positiveInteger("COMMENT_MIN_WORDS", 5);
const commentMaxWords = positiveInteger("COMMENT_MAX_WORDS", 15);
if (commentMaxWords < commentMinWords) {
  throw new Error("COMMENT_MAX_WORDS debe ser igual o mayor que COMMENT_MIN_WORDS.");
}
const workerDeviceConcurrency = positiveInteger("WORKER_DEVICE_CONCURRENCY", 4);
if (workerDeviceConcurrency > 100) throw new Error("WORKER_DEVICE_CONCURRENCY no puede superar 100.");
const deepSeekConcurrency = positiveInteger("DEEPSEEK_CONCURRENCY", 2);
if (deepSeekConcurrency > 4) throw new Error("DEEPSEEK_CONCURRENCY no puede superar 4.");

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
  workerShutdownTimeoutMs: positiveInteger("WORKER_SHUTDOWN_TIMEOUT_MS", 60_000),
  workerDeviceConcurrency,
  facebookBrowserExecutablePath: process.env.FACEBOOK_BROWSER_EXECUTABLE_PATH?.trim() || undefined,
  facebookBrowserProfilePath: facebookProfilePath(),
  facebookExtractionTimeoutMs: positiveInteger("FACEBOOK_EXTRACTION_TIMEOUT_MS", 45_000),
  facebookControlledAccount: process.env.FACEBOOK_CONTROLLED_ACCOUNT?.trim() || "",
  facebookAccountResourceId: process.env.FACEBOOK_ACCOUNT_RESOURCE_ID?.trim() || "",
  facebookPostContainerResourceId: process.env.FACEBOOK_POST_CONTAINER_RESOURCE_ID?.trim() || "",
  facebookPostUrlResourceId: process.env.FACEBOOK_POST_URL_RESOURCE_ID?.trim() || "",
  facebookCommentComposerResourceId: process.env.FACEBOOK_COMMENT_COMPOSER_RESOURCE_ID?.trim() || "",
  facebookCommentEditorResourceId: process.env.FACEBOOK_COMMENT_EDITOR_RESOURCE_ID?.trim() || "",
  facebookCommentSubmitResourceId: process.env.FACEBOOK_COMMENT_SUBMIT_RESOURCE_ID?.trim() || "",
  facebookCommentResultContainerResourceId: process.env.FACEBOOK_COMMENT_RESULT_CONTAINER_RESOURCE_ID?.trim() || "",
  facebookUiTimeoutMs: positiveInteger("FACEBOOK_UI_TIMEOUT_MS", 15_000),
  facebookLikeActiveLabels: labels("FACEBOOK_LIKE_ACTIVE_LABELS", "Ya no me gusta|Unlike|Remove Like|Quitar Me gusta"),
  facebookLikeInactiveLabels: labels("FACEBOOK_LIKE_INACTIVE_LABELS", "Me gusta|Like"),
  facebookCommentLabels: labels("FACEBOOK_COMMENT_LABELS", "Comentar|Comment"),
  facebookShareLabels: labels("FACEBOOK_SHARE_LABELS", "Compartir|Share"),
  facebookShareNowLabels: labels("FACEBOOK_SHARE_NOW_LABELS", "Compartir ahora|Share now"),
  facebookShareConfirmationLabels: labels("FACEBOOK_SHARE_CONFIRMATION_LABELS", "Publicación compartida|Post shared"),
  deepSeekApiKey: process.env.API_DEEPSEEK?.trim() || "",
  deepSeekConcurrency,
  deepSeekModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat",
  deepSeekTimeoutMs: positiveInteger("DEEPSEEK_TIMEOUT_MS", 45_000),
  commentGenerationPrompt: process.env.COMMENT_GENERATION_PROMPT?.trim() ||
    "Escribe comentarios naturales relacionados con el contexto y la intencion indicada. No inventes experiencias, identidades ni datos.",
  commentMinWords,
  commentMaxWords,
});
