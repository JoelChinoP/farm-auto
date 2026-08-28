import "server-only";

import { isPackageInstalledUnchecked, listAdbDevices } from "@/lib/adb";
import {
  ensureAutomationDeviceReady,
  extractFacebookPostContext,
} from "@/lib/automation-service";
import {
  createFacebookBatch,
  getDraft,
  getFacebookBatch,
  getFacebookPost,
  getRegistry,
  getVisibleFacebookBatch,
  listFacebookAssignments,
  listFacebookPosts,
  replaceFacebookAssignments,
  setDraftOutcome,
  transitionFacebookPost,
  updateFacebookAssignment,
  updateFacebookBatch,
  updateFacebookPost,
} from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getDevices } from "@/lib/genfarmer";
import { approveMessage, generateDraft, sendApprovedMessage } from "@/lib/messages";
import {
  expandFacebookAllocations,
  normalizeFacebookUrls,
} from "@/lib/schemas";

const terminalPostStatuses = new Set(["completed", "skipped"]);
const uncertainAutomationCodes = new Set([
  "RUN_TIMEOUT",
  "RUN_FAILED",
  "GENFARMER_UNAVAILABLE",
  "GENFARMER_ERROR",
  "OPERATION_IN_PROGRESS",
  "DEVICE_CLEANUP_UNKNOWN",
]);
const retryableAutomationCodes = new Set([
  "TIKTOK_NOT_INSTALLED",
  "FACEBOOK_NOT_INSTALLED",
  "SETUP_REQUIRED",
  "DEVICE_NOT_CONNECTED",
  "DEVICE_NOT_IN_GENFARMER",
  "DEVICE_BUSY",
  "DEVICE_OUTCOME_UNKNOWN",
  "ADB_ERROR",
  "IDEMPOTENT_OPERATION_FAILED",
]);

export function getFacebookBatchSnapshot() {
  const batch = getVisibleFacebookBatch();
  if (!batch) return null;
  const posts = listFacebookPosts(batch.id).map((post) => ({
    ...post,
    assignments: listFacebookAssignments(post.id).map((assignment) => ({
      ...assignment,
      draft: assignment.draft_id ? getDraft(assignment.draft_id) ?? null : null,
    })),
  }));
  return { ...batch, posts };
}

function currentPost(postId: string) {
  const post = getFacebookPost(postId);
  if (!post) throw new AppError("Publicación no encontrada.", 404, "NOT_FOUND");
  const batch = getFacebookBatch(post.batch_id);
  if (!batch || batch.status !== "active") {
    throw new AppError("Esta cola ya no está activa.", 409, "BATCH_NOT_ACTIVE");
  }
  const current = listFacebookPosts(batch.id).find(
    (item) => !terminalPostStatuses.has(item.status),
  );
  if (!current || current.id !== post.id) {
    throw new AppError(
      "Las publicaciones se procesan en orden. Completa la publicación actual.",
      409,
      "POST_NOT_CURRENT",
    );
  }
  return post;
}

function finishBatchIfNeeded(batchId: string) {
  const pending = listFacebookPosts(batchId).some(
    (post) => !terminalPostStatuses.has(post.status),
  );
  if (!pending) updateFacebookBatch(batchId, "completed");
}

export function startFacebookBatch(values: string[]) {
  let urls: string[];
  try {
    urls = normalizeFacebookUrls(values);
  } catch (error) {
    throw new AppError(
      error instanceof Error ? error.message : "Revisa los enlaces de Facebook.",
      400,
      "INVALID_CONTENT_URL",
    );
  }
  if (!urls.length) {
    throw new AppError("Ingresa al menos un enlace.", 400, "EMPTY_BATCH");
  }
  createFacebookBatch(urls);
  return getFacebookBatchSnapshot();
}

export async function extractPostContext(input: {
  postId: string;
  deviceId: string;
  idempotencyKey: string;
}) {
  const post = currentPost(input.postId);
  const assignments = listFacebookAssignments(post.id);
  if (
    assignments.some((assignment) =>
      ["running", "sent", "outcome_unknown"].includes(assignment.status),
    )
  ) {
    throw new AppError(
      "El contexto ya no puede reemplazarse en esta etapa.",
      409,
      "CONTEXT_NOT_EDITABLE",
    );
  }
  transitionFacebookPost(
    post.id,
    ["queued", "context_ready", "drafts_ready", "partial_failed"],
    "extracting",
  );
  try {
    const result = await extractFacebookPostContext({
      deviceId: input.deviceId,
      idempotencyKey: input.idempotencyKey,
      url: post.url,
    });
    const context = result.result?.context;
    if (!context) {
      throw new AppError(
        "La extracción todavía no produjo un contexto.",
        409,
        "CONTEXT_NOT_READY",
      );
    }
    updateFacebookPost(post.id, {
      extracted_context: context,
      context,
      status: "context_ready",
      error: null,
    });
  } catch (error) {
    updateFacebookPost(post.id, {
      status: post.status,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return getFacebookBatchSnapshot();
}

export async function generatePostDrafts(input: {
  postId: string;
  context: string;
  deviceIds: string[];
  allocations: Array<{ intent: string; tone: string; count: number }>;
}) {
  const post = currentPost(input.postId);
  const existing = listFacebookAssignments(post.id);
  if (
    ["approved", "running", "completed"].includes(post.status) ||
    existing.some((assignment) =>
      ["running", "sent", "outcome_unknown"].includes(assignment.status),
    )
  ) {
    throw new AppError(
      "No se pueden reemplazar comentarios que ya se están publicando o fueron enviados.",
      409,
      "ASSIGNMENTS_NOT_REPLACEABLE",
    );
  }

  for (const deviceId of input.deviceIds) {
    if (
      !getRegistry("device-home", deviceId) ||
      !getRegistry("facebook-post-like-comment", deviceId)
    ) {
      throw new AppError(
        `Prepara las automatizaciones del dispositivo ${deviceId}.`,
        409,
        "SETUP_REQUIRED",
      );
    }
  }
  const genFarmerDevices = await getDevices();
  const connected = new Set(
    (await listAdbDevices())
      .filter((device) => device.state === "device")
      .map((device) => device.id),
  );
  for (const deviceId of input.deviceIds) {
    if (!connected.has(deviceId)) {
      throw new AppError(
        `El dispositivo ${deviceId} no está conectado o autorizado por ADB.`,
        409,
        "DEVICE_NOT_CONNECTED",
      );
    }
    if (!genFarmerDevices.some((device) => device.currentDeviceId === deviceId)) {
      throw new AppError(
        `GenFarmer no reconoce el dispositivo ${deviceId}.`,
        409,
        "DEVICE_NOT_IN_GENFARMER",
      );
    }
    if (!(await isPackageInstalledUnchecked(deviceId, "com.facebook.katana"))) {
      throw new AppError(
        `Facebook no está instalado en ${deviceId}.`,
        409,
        "FACEBOOK_NOT_INSTALLED",
      );
    }
  }
  currentPost(input.postId);

  let expanded: ReturnType<typeof expandFacebookAllocations>;
  try {
    expanded = expandFacebookAllocations(input.deviceIds, input.allocations);
  } catch (error) {
    throw new AppError(
      error instanceof Error ? error.message : "Distribución inválida.",
      400,
      "INVALID_ALLOCATION",
    );
  }

  transitionFacebookPost(
    post.id,
    ["queued", "context_ready", "drafts_ready", "partial_failed"],
    "generating",
  );
  updateFacebookPost(post.id, { context: input.context });
  const assignments = replaceFacebookAssignments(post.id, expanded);
  let failures = 0;
  for (const [index, assignment] of assignments.entries()) {
    updateFacebookAssignment(assignment.id, { status: "generating", error: null });
    try {
      const draft = await generateDraft({
        kind: "social_comment",
        platform: "facebook",
        context: input.context,
        intent: assignment.intent,
        tone: assignment.tone,
        variation: `Borrador independiente ${index + 1} de ${assignments.length}. Redacta una variante propia para esta asignación.`,
      });
      updateFacebookAssignment(assignment.id, {
        draft_id: draft.id,
        status: "draft",
        error: null,
      });
    } catch (error) {
      failures++;
      updateFacebookAssignment(assignment.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  updateFacebookPost(post.id, {
    status: failures ? "partial_failed" : "drafts_ready",
    error: failures
      ? `${failures} de ${assignments.length} comentarios no pudieron generarse.`
      : null,
  });
  if (failures) {
    throw new AppError(
      `${failures} de ${assignments.length} comentarios no pudieron generarse.`,
      502,
      "DRAFT_GENERATION_PARTIAL",
    );
  }
  return getFacebookBatchSnapshot();
}

export function approvePostDrafts(
  postId: string,
  comments: Array<{ assignmentId: string; text: string }>,
) {
  const post = currentPost(postId);
  const assignments = listFacebookAssignments(post.id);
  if (!assignments.length || assignments.some((assignment) => !assignment.draft_id)) {
    throw new AppError(
      "Todos los dispositivos deben tener un comentario generado.",
      409,
      "DRAFTS_INCOMPLETE",
    );
  }
  const byAssignment = new Map(
    comments.map((comment) => [comment.assignmentId, comment.text]),
  );
  if (
    byAssignment.size !== assignments.length ||
    assignments.some((assignment) => !byAssignment.has(assignment.id))
  ) {
    throw new AppError(
      "Revisa y envía un comentario por cada dispositivo.",
      400,
      "COMMENTS_INCOMPLETE",
    );
  }

  transitionFacebookPost(post.id, ["drafts_ready"], "approving");
  try {
    for (const assignment of assignments) {
      approveMessage(
        assignment.draft_id!,
        {
          text: byAssignment.get(assignment.id)!,
          consentConfirmed: false,
          recipient: "",
        },
        assignment.id,
      );
      updateFacebookAssignment(assignment.id, {
        status: "approved",
        error: null,
      });
    }
    updateFacebookPost(post.id, { status: "approved", error: null });
  } catch (error) {
    updateFacebookPost(post.id, {
      status: "partial_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return getFacebookBatchSnapshot();
}

export async function executePostAssignments(postId: string) {
  const post = currentPost(postId);
  const assignments = listFacebookAssignments(post.id);
  if (
    !assignments.length ||
    assignments.some(
      (assignment) => assignment.status !== "approved" || !assignment.draft_id,
    )
  ) {
    throw new AppError(
      "Aprueba todos los comentarios antes de ejecutar los dispositivos.",
      409,
      "COMMENTS_NOT_APPROVED",
    );
  }

  await Promise.all(
    assignments.map((assignment) =>
      ensureAutomationDeviceReady(assignment.device_id),
    ),
  );
  currentPost(post.id);
  transitionFacebookPost(post.id, ["approved"], "running");
  assignments.forEach((assignment) =>
    updateFacebookAssignment(assignment.id, { status: "running", error: null }),
  );
  const results = await Promise.allSettled(
    assignments.map(async (assignment) => {
      try {
        await sendApprovedMessage(
          assignment.draft_id!,
          assignment.device_id,
          post.url,
          assignment.id,
        );
        updateFacebookAssignment(assignment.id, { status: "sent", error: null });
      } catch (error) {
        const uncertain =
          error instanceof AppError && uncertainAutomationCodes.has(error.code);
        const retryable =
          error instanceof AppError && retryableAutomationCodes.has(error.code);
        updateFacebookAssignment(assignment.id, {
          status: uncertain
            ? "outcome_unknown"
            : retryable
              ? "approved"
              : "failed",
          error: retryable
            ? null
            : error instanceof Error
              ? error.message
              : String(error),
        });
        throw error;
      }
    }),
  );
  const failures = results.filter((result) => result.status === "rejected").length;
  const unknown = listFacebookAssignments(post.id).filter(
    (assignment) => assignment.status === "outcome_unknown",
  ).length;
  const retryable =
    failures > 0 &&
    listFacebookAssignments(post.id).every(
      (assignment) => assignment.status === "approved",
    );
  updateFacebookPost(post.id, {
    status: unknown
      ? "outcome_unknown"
      : retryable
        ? "approved"
        : failures
          ? "partial_failed"
          : "completed",
    error: unknown
      ? `${unknown} dispositivos tienen un resultado público pendiente de verificación manual.`
      : retryable
        ? "La ejecución no comenzó y puede reintentarse."
        : failures
          ? `${failures} de ${assignments.length} dispositivos no completaron la acción.`
          : null,
  });
  if (unknown) {
    throw new AppError(
      `${unknown} dispositivos deben verificarse manualmente antes de continuar.`,
      409,
      "FACEBOOK_OUTCOME_UNKNOWN",
    );
  }
  if (retryable) {
    throw new AppError(
      "La ejecución no comenzó; puedes reintentar con los mismos comentarios aprobados.",
      409,
      "FACEBOOK_EXECUTION_RETRYABLE",
    );
  }
  if (failures) {
    throw new AppError(
      `${failures} de ${assignments.length} dispositivos no completaron la acción.`,
      502,
      "FACEBOOK_EXECUTION_PARTIAL",
    );
  }
  finishBatchIfNeeded(post.batch_id);
  return getFacebookBatchSnapshot();
}

export function reconcilePostOutcomes(
  postId: string,
  outcomes: Array<{ assignmentId: string; outcome: "sent" | "not_sent" }>,
) {
  const post = currentPost(postId);
  if (!["outcome_unknown", "partial_failed"].includes(post.status)) {
    throw new AppError(
      "Esta publicación no tiene resultados pendientes de verificación.",
      409,
      "POST_NOT_RECONCILABLE",
    );
  }
  const assignments = listFacebookAssignments(post.id);
  const unknown = assignments.filter((assignment) =>
    post.status === "outcome_unknown"
      ? assignment.status === "outcome_unknown"
      : assignment.status === "failed",
  );
  const byAssignment = new Map(
    outcomes.map((outcome) => [outcome.assignmentId, outcome.outcome]),
  );
  if (
    !unknown.length ||
    byAssignment.size !== unknown.length ||
    unknown.some((assignment) => !byAssignment.has(assignment.id))
  ) {
    throw new AppError(
      "Registra el resultado observado de cada dispositivo pendiente.",
      400,
      "RECONCILIATION_INCOMPLETE",
    );
  }

  const retryApprovedDrafts =
    unknown.length === assignments.length &&
    unknown.every((assignment) => byAssignment.get(assignment.id) === "not_sent");

  for (const assignment of unknown) {
    const sent = byAssignment.get(assignment.id) === "sent";
    updateFacebookAssignment(assignment.id, {
      status: sent ? "sent" : retryApprovedDrafts ? "approved" : "failed",
      error: sent
        ? null
        : retryApprovedDrafts
          ? null
          : "El operador confirmó que el comentario no fue publicado.",
    });
    if (assignment.draft_id) {
      setDraftOutcome(
        assignment.draft_id,
        sent ? "sent" : retryApprovedDrafts ? "approved" : "failed",
        sent || retryApprovedDrafts
          ? null
          : "Publicación no observada durante la verificación manual.",
      );
    }
  }

  if (retryApprovedDrafts) {
    updateFacebookPost(post.id, { status: "approved", error: null });
    return getFacebookBatchSnapshot();
  }

  const reconciled = listFacebookAssignments(post.id);
  if (
    reconciled.some(
      (assignment) => !["sent", "failed"].includes(assignment.status),
    )
  ) {
    throw new AppError(
      "La verificación no resolvió todas las asignaciones.",
      409,
      "RECONCILIATION_INCOMPLETE",
    );
  }
  const notSent = reconciled.filter((assignment) => assignment.status === "failed").length;
  updateFacebookPost(post.id, {
    status: notSent ? "partial_failed" : "completed",
    error: notSent
      ? `${notSent} dispositivos fueron verificados como no enviados.`
      : null,
  });
  if (!notSent) finishBatchIfNeeded(post.batch_id);
  return getFacebookBatchSnapshot();
}

export function skipFacebookPost(postId: string) {
  const post = currentPost(postId);
  transitionFacebookPost(
    post.id,
    [
      "queued",
      "context_ready",
      "drafts_ready",
      "approved",
      "partial_failed",
    ],
    "skipped",
  );
  finishBatchIfNeeded(post.batch_id);
  return getFacebookBatchSnapshot();
}
