import "server-only";

import { createHash } from "node:crypto";
import OpenAI from "openai";

import { appConfig } from "@/lib/config";
import {
  approveDraft,
  createDraft,
  DraftRow,
  getDraft,
  getFacebookAssignmentByDraftId,
  reserveDraftForSend,
  setDraftOutcome,
} from "@/lib/db";
import { AppError } from "@/lib/errors";
import { buildFacebookTargetMarker } from "@/lib/facebook-context";
import {
  describeFacebookIntent,
  describeFacebookTone,
} from "@/lib/facebook-copy-options";
import { AsyncSemaphore, retryOperation } from "@/lib/generation-utils";
import {
  likeAndCommentFacebookPost,
  likeAndCommentTikTokPost,
} from "@/lib/automation-service";
import {
  normalizeContentUrl,
  parseGeneratedDraftContent,
} from "@/lib/schemas";

type DraftInput = {
  kind: DraftRow["kind"];
  platform: DraftRow["platform"];
  context: string;
  intent: string;
  tone: string;
  variation?: string;
};

const retryablePreflightCodes = new Set([
  "TIKTOK_NOT_INSTALLED",
  "FACEBOOK_NOT_INSTALLED",
  "SETUP_REQUIRED",
  "DEVICE_NOT_CONNECTED",
  "DEVICE_NOT_IN_GENFARMER",
  "DEVICE_BUSY",
  "DEVICE_OUTCOME_UNKNOWN",
  "FACEBOOK_TARGET_NOT_VERIFIED",
  "ADB_ERROR",
  "IDEMPOTENT_OPERATION_FAILED",
]);

const globalGeneration = globalThis as typeof globalThis & {
  deepSeekClient?: OpenAI;
  deepSeekSemaphore?: AsyncSemaphore;
};

function getDeepSeekClient() {
  if (!appConfig.deepSeekApiKey) {
    throw new AppError(
      "Falta API_DEEPSEEK en el archivo .env.",
      503,
      "DEEPSEEK_NOT_CONFIGURED",
    );
  }
  return globalGeneration.deepSeekClient ??=
    new OpenAI({
      apiKey: appConfig.deepSeekApiKey,
      baseURL: "https://api.deepseek.com",
      maxRetries: 0,
      timeout: 45_000,
    });
}

const deepSeekSemaphore = globalGeneration.deepSeekSemaphore ??=
  new AsyncSemaphore(appConfig.deepSeekGenerationConcurrency);

function providerStatus(error: unknown) {
  if (error instanceof AppError && error.details && typeof error.details === "object") {
    const value = (error.details as { providerStatus?: unknown }).providerStatus;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  const status = typeof error === "object" && error && "status" in error
    ? Number(error.status)
    : 0;
  return Number.isFinite(status) ? status : 0;
}

function retryAfterMilliseconds(error: unknown) {
  if (error instanceof AppError && error.details && typeof error.details === "object") {
    const value = (error.details as { retryAfterMilliseconds?: unknown })
      .retryAfterMilliseconds;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function readRetryAfter(error: unknown) {
  if (!error || typeof error !== "object" || !("headers" in error)) return null;
  const headers = error.headers;
  if (!headers || typeof headers !== "object" || !("get" in headers)) return null;
  const get = headers.get;
  if (typeof get !== "function") return null;
  const millisecondsHeader = get.call(headers, "retry-after-ms");
  if (millisecondsHeader !== null && millisecondsHeader !== "") {
    const milliseconds = Number(millisecondsHeader);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  }
  const retryAfterHeader = get.call(headers, "retry-after");
  if (retryAfterHeader === null || retryAfterHeader === "") return null;
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(String(retryAfterHeader));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function normalizeDeepSeekError(error: unknown) {
  if (error instanceof AppError) return error;
  const status = providerStatus(error);
  return new AppError(
    status === 401
      ? "DeepSeek rechazó API_DEEPSEEK. Revisa la clave configurada."
      : status === 429
        ? "DeepSeek alcanzó temporalmente su límite de solicitudes."
        : "DeepSeek no pudo generar el borrador.",
    status === 401 ? 503 : 502,
    status === 401
      ? "DEEPSEEK_AUTH_FAILED"
      : status === 429
        ? "DEEPSEEK_RATE_LIMIT"
        : "DEEPSEEK_ERROR",
    {
      providerStatus: status,
      retryAfterMilliseconds: readRetryAfter(error),
    },
  );
}

function shouldRetryDeepSeek(error: unknown) {
  if (
    error instanceof AppError &&
    ["EMPTY_MODEL_RESPONSE", "INVALID_MODEL_RESPONSE"].includes(error.code)
  ) {
    return true;
  }
  const status = providerStatus(error);
  return status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
}

export async function generateDraft(input: DraftInput) {
  const client = getDeepSeekClient();
  const targetLength = "15 a 180";
  const generated = await deepSeekSemaphore.run(() =>
    retryOperation(
      async () => {
        let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
        try {
          completion = await client.chat.completions.create({
            model: appConfig.deepSeekModel,
            temperature: 0.85,
            max_tokens: 1_000,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: `Eres un asistente de redacción en español peruano actual. Crea un solo borrador natural y breve, no una campaña. Debe mantener exactamente la intención del operador, sonar humano y conversacional, sin inventar experiencias, identidades ni afirmaciones. Si es un comentario social, debe referirse a por lo menos un elemento concreto del contexto proporcionado y evitar elogios genéricos. Evita gramática rígida o tono corporativo. Puedes usar como máximo un modismo suave y pertinente entre "chévere", "bacán", "tranqui", "al toque", "causa" o la partícula "pe"; si no encaja, no uses ninguno. No fuerces faltas ortográficas. No incluyas hashtags repetitivos, presión, engaño, spam ni instrucciones para manipular engagement. Devuelve únicamente JSON con la forma {"text":"..."}. Longitud: ${targetLength} caracteres.`,
              },
              {
                role: "user",
                content: JSON.stringify({
                  type: input.kind,
                  platform: input.platform,
                  context: input.context,
                  intent: input.intent,
                  intentGuidance: describeFacebookIntent(input.intent),
                  tone: input.tone,
                  toneGuidance: describeFacebookTone(input.tone),
                  variation: input.variation,
                }),
              },
            ],
          });
        } catch (error) {
          throw normalizeDeepSeekError(error);
        }

        const content = completion.choices[0]?.message.content;
        if (!content) {
          throw new AppError(
            "DeepSeek no devolvió un borrador.",
            502,
            "EMPTY_MODEL_RESPONSE",
          );
        }
        const parsed = parseGeneratedDraftContent(content);
        if (!parsed) {
          throw new AppError(
            "DeepSeek devolvió un borrador fuera del formato esperado.",
            502,
            "INVALID_MODEL_RESPONSE",
          );
        }
        return parsed;
      },
      {
        attempts: 3,
        shouldRetry: shouldRetryDeepSeek,
        delayMilliseconds: (error, attempt) => {
          const requestedDelay = retryAfterMilliseconds(error);
          if (requestedDelay !== null) return Math.min(requestedDelay, 60_000);
          const ceiling = Math.min(8_000, 500 * 2 ** (attempt - 1));
          return Math.floor(Math.random() * ceiling);
        },
      },
    ),
  );
  return createDraft({
    kind: input.kind,
    platform: input.platform,
    context: input.context,
    intent: input.intent,
    tone: input.tone,
    text: generated.text,
  });
}

export function approveMessage(
  id: string,
  input: { text: string },
  facebookAssignmentId?: string,
) {
  const draft = getDraft(id);
  if (!draft) throw new AppError("Borrador no encontrado.", 404, "NOT_FOUND");
  const assignment = getFacebookAssignmentByDraftId(id);
  if (assignment && assignment.id !== facebookAssignmentId) {
    throw new AppError(
      "Este borrador se administra desde su cola de Facebook.",
      409,
      "BATCH_DRAFT_MANAGED",
    );
  }

  return approveDraft(id, input.text);
}

export async function sendApprovedMessage(
  id: string,
  deviceId: string,
  contentUrl?: string,
  facebookAssignmentId?: string,
) {
  const draft = getDraft(id);
  if (!draft) throw new AppError("Borrador no encontrado.", 404, "NOT_FOUND");
  const assignment = getFacebookAssignmentByDraftId(id);
  if (assignment && assignment.id !== facebookAssignmentId) {
    throw new AppError(
      "Este borrador se ejecuta únicamente desde su cola de Facebook.",
      409,
      "BATCH_DRAFT_MANAGED",
    );
  }
  if (draft.status !== "approved") {
    throw new AppError(
      "El texto debe estar aprobado antes de publicarse.",
      409,
      "MESSAGE_NOT_SENDABLE",
    );
  }

  if (
    draft.kind !== "social_comment" ||
    (draft.platform !== "tiktok" && draft.platform !== "facebook")
  ) {
    throw new AppError(
      "La plataforma no admite publicación automática de comentarios.",
      409,
      "UNSUPPORTED_SOCIAL_COMMENT",
    );
  }
  if (!contentUrl) {
    throw new AppError(
      `Ingresa el enlace de la publicación de ${draft.platform === "tiktok" ? "TikTok" : "Facebook"}.`,
      400,
      "CONTENT_URL_REQUIRED",
    );
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeContentUrl(draft.platform, contentUrl);
  } catch (error) {
    throw new AppError(
      error instanceof Error ? error.message : "Enlace inválido.",
      400,
      "INVALID_CONTENT_URL",
    );
  }

  const idempotencyKey = createHash("sha256")
    .update(
      `${draft.id}\0${deviceId}\0${normalizedUrl}\0${draft.text}\0${draft.updated_at}`,
    )
    .digest("hex")
    .slice(0, 8)
    .padEnd(8, "0")
    .concat("-0000-4000-8000-")
    .concat(
      createHash("sha256")
        .update(`${normalizedUrl}\0${draft.text}`)
        .digest("hex")
        .slice(0, 12),
    );

  const facebookTargetMarker = draft.platform === "facebook"
    ? buildFacebookTargetMarker(draft.context)
    : null;
  if (draft.platform === "facebook" && !facebookTargetMarker) {
    throw new AppError(
      "No hay una descripción suficientemente específica para verificar la publicación objetivo.",
      409,
      "FACEBOOK_TARGET_UNVERIFIABLE",
    );
  }

  reserveDraftForSend(id);
  try {
    const result = draft.platform === "tiktok"
      ? await likeAndCommentTikTokPost({
          deviceId,
          idempotencyKey,
          url: normalizedUrl,
          commentText: draft.text,
        })
      : await likeAndCommentFacebookPost({
          deviceId,
          idempotencyKey,
          url: normalizedUrl,
          commentText: draft.text,
          targetMarker: facebookTargetMarker!,
        });
    setDraftOutcome(id, "sent");
    return result;
  } catch (error) {
    const code = error instanceof AppError ? error.code : "";
    // Once reserved, only errors proven to be preflight-safe may be retried.
    const status = retryablePreflightCodes.has(code)
      ? "approved"
      : "outcome_unknown";
    setDraftOutcome(
      id,
      status,
      status === "approved"
        ? null
        : error instanceof Error
          ? error.message
          : String(error),
    );
    throw error;
  }
}
