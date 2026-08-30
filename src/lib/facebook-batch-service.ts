import "server-only";

import { randomInt } from "node:crypto";

import {
  getDeviceHardwareId,
  isPackageInstalledUnchecked,
  listAdbDevices,
} from "@/lib/adb";
import {
  assertDevicePrepared,
  ensureAutomationDeviceReady,
} from "@/lib/automation-service";
import { appConfig } from "@/lib/config";
import {
  advanceFacebookBatchRound,
  claimFacebookBatchExecution,
  createFacebookBatch,
  getDraft,
  getFacebookBatch,
  getFacebookPost,
  getVisibleFacebookBatch,
  hasFacebookBatchPublicActions,
  listFacebookAssignments,
  listFacebookPosts,
  listFacebookRotationSlots,
  releaseFacebookBatchExecution,
  replaceFacebookAssignments,
  setFacebookBatchNextExecutionAt,
  setDraftOutcome,
  transitionFacebookPost,
  updateFacebookAssignment,
  updateFacebookBatch,
  updateFacebookPost,
} from "@/lib/db";
import type {
  FacebookAssignmentRow,
  FacebookPostRow,
} from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getAuthenticatedFacebookDescription } from "@/lib/facebook-browser";
import { mapWithConcurrency } from "@/lib/generation-utils";
import {
  buildFacebookRotationPlan,
  getFacebookRoundDisposition,
  runFacebookRound,
} from "@/lib/facebook-rotation";
import type { FacebookRoundAssignmentStatus } from "@/lib/facebook-rotation";
import {
  approveMessage,
  generateDraft,
  sendApprovedMessage,
} from "@/lib/messages";
import {
  distributeFacebookDevices,
  expandFacebookAllocations,
  normalizeFacebookUrls,
} from "@/lib/schemas";

const terminalPostStatuses = new Set(["completed", "skipped"]);
function parseBatchDeviceIds(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertFacebookDevicesReady(deviceIds: string[]) {
  for (const deviceId of deviceIds) assertDevicePrepared(deviceId);

  const adbDevices = await listAdbDevices();
  const connected = new Set(
    adbDevices
      .filter((device) => device.state === "device")
      .map((device) => device.id),
  );
  for (const deviceId of deviceIds) {
    if (!connected.has(deviceId)) {
      throw new AppError(
        `El dispositivo ${deviceId} no está conectado o autorizado por ADB.`,
        409,
        "DEVICE_NOT_CONNECTED",
      );
    }
  }

  const hardwareIds = await Promise.all(deviceIds.map(getDeviceHardwareId));
  if (new Set(hardwareIds).size !== hardwareIds.length) {
    throw new AppError(
      "Dos identificadores ADB apuntan al mismo dispositivo fisico.",
      409,
      "DUPLICATE_DEVICE_HARDWARE",
    );
  }

  const installed = await Promise.all(
    deviceIds.map((deviceId) =>
      isPackageInstalledUnchecked(deviceId, "com.facebook.katana"),
    ),
  );
  const missingIndex = installed.findIndex((value) => !value);
  if (missingIndex >= 0) {
    throw new AppError(
      `Facebook no está instalado en ${deviceIds[missingIndex]}.`,
      409,
      "FACEBOOK_NOT_INSTALLED",
    );
  }
}

export function getFacebookBatchSnapshot() {
  const batch = getVisibleFacebookBatch();
  if (!batch) return null;
  const storedDeviceIds = parseBatchDeviceIds(batch.device_ids_json);
  const batchPosts = listFacebookPosts(batch.id);
  const rotation = batch.plan_version === "rotation_v1";
  const deviceGroups = !rotation && storedDeviceIds.length
    ? distributeFacebookDevices(storedDeviceIds, batchPosts.length)
    : batchPosts.map(() => [] as string[]);
  const rotationSlots = rotation ? listFacebookRotationSlots(batch.id) : [];
  const slotsByPair = new Map(
    rotationSlots.map((slot) => [`${slot.post_id}\0${slot.device_id}`, slot]),
  );
  const posts = batchPosts.map((post) => {
    const plannedDeviceIds = rotation
      ? storedDeviceIds
      : deviceGroups[post.position] ?? [];
    const deviceOrder = new Map(
      plannedDeviceIds.map((deviceId, index) => [deviceId, index]),
    );
    const assignments = listFacebookAssignments(post.id).map((assignment) => {
      const slot = slotsByPair.get(`${post.id}\0${assignment.device_id}`);
      return {
        ...assignment,
        round_index: slot?.round_index ?? null,
        sequence_index: slot?.sequence_index ?? null,
        draft: assignment.draft_id ? getDraft(assignment.draft_id) ?? null : null,
      };
    }).sort(
      (left, right) =>
        (deviceOrder.get(left.device_id) ?? Number.MAX_SAFE_INTEGER) -
          (deviceOrder.get(right.device_id) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    );
    return {
      ...post,
      planned_device_ids: plannedDeviceIds,
      assignments,
    };
  });
  const allAssignments = posts.flatMap((post) => post.assignments);
  const activePostIds = new Set(
    posts.filter((post) => post.status !== "skipped").map((post) => post.id),
  );
  const activeAssignments = posts
    .filter((post) => activePostIds.has(post.id))
    .flatMap((post) => post.assignments);
  return {
    id: batch.id,
    status: batch.status,
    plan_version: batch.plan_version,
    current_round: batch.current_round,
    total_rounds: rotation ? batchPosts.length : 0,
    execution_status: batch.execution_status,
    next_execution_at: batch.next_execution_at,
    execution_started:
      rotation &&
      (batch.current_round > 0 || hasFacebookBatchPublicActions(batch.id)),
    created_at: batch.created_at,
    updated_at: batch.updated_at,
    device_ids: storedDeviceIds,
    progress: {
      prepared_posts: posts.filter(
        (post) =>
          post.status === "skipped" ||
          (post.assignments.length === storedDeviceIds.length &&
            post.assignments.every((assignment) => assignment.draft)),
      ).length,
      completed_assignments: activeAssignments.filter((assignment) =>
        assignment.status === "sent",
      ).length,
      total_assignments: rotation
        ? rotationSlots.filter((slot) => activePostIds.has(slot.post_id)).length
        : allAssignments.length,
    },
    posts,
  };
}

function currentPost(postId: string) {
  const post = getFacebookPost(postId);
  if (!post) throw new AppError("Publicación no encontrada.", 404, "NOT_FOUND");
  const batch = getFacebookBatch(post.batch_id);
  if (!batch || batch.status !== "active") {
    throw new AppError("Esta cola ya no está activa.", 409, "BATCH_NOT_ACTIVE");
  }
  if (batch.plan_version === "legacy") {
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
  }
  if (
    batch.plan_version === "rotation_v1" &&
    batch.execution_status === "running"
  ) {
    throw new AppError(
      "La rotación está ejecutándose; espera a que termine o se detenga.",
      409,
      "BATCH_EXECUTION_BUSY",
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

export async function startFacebookBatch(values: string[], deviceIds: string[]) {
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
  let deviceGroups: string[][];
  try {
    deviceGroups = distributeFacebookDevices(deviceIds, urls.length);
  } catch (error) {
    throw new AppError(
      error instanceof Error ? error.message : "Distribución de dispositivos inválida.",
      400,
      "INVALID_DEVICE_DISTRIBUTION",
    );
  }
  await assertFacebookDevicesReady(deviceIds);
  createFacebookBatch(
    urls,
    deviceIds,
    buildFacebookRotationPlan(deviceGroups),
  );
  return getFacebookBatchSnapshot();
}

export async function extractPostContext(input: { postId: string }) {
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
    const context = await getAuthenticatedFacebookDescription(post.url);
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
  const batch = getFacebookBatch(post.batch_id)!;
  const storedDeviceIds = parseBatchDeviceIds(batch.device_ids_json);
  let plannedDeviceIds = input.deviceIds;
  if (storedDeviceIds.length) {
    plannedDeviceIds = batch.plan_version === "rotation_v1"
      ? storedDeviceIds
      : distributeFacebookDevices(
          storedDeviceIds,
          listFacebookPosts(batch.id).length,
        )[post.position];
    if (
      plannedDeviceIds.length !== input.deviceIds.length ||
      plannedDeviceIds.some((deviceId) => !input.deviceIds.includes(deviceId))
    ) {
      throw new AppError(
        "Los dispositivos de esta publicación no coinciden con el reparto fijado para la cola.",
        409,
        "DEVICE_PLAN_MISMATCH",
      );
    }
  }
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

  const expectedDevices = new Set(plannedDeviceIds);
  if (
    existing.length &&
    (existing.length !== plannedDeviceIds.length ||
      existing.some((assignment) => !expectedDevices.has(assignment.device_id)))
  ) {
    throw new AppError(
      "Las asignaciones guardadas no coinciden con el plan de dispositivos.",
      409,
      "ASSIGNMENT_PLAN_MISMATCH",
    );
  }

  let expanded: ReturnType<typeof expandFacebookAllocations> | null = null;
  if (!existing.length) {
    try {
      expanded = expandFacebookAllocations(plannedDeviceIds, input.allocations);
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : "Distribución inválida.",
        400,
        "INVALID_ALLOCATION",
      );
    }
  }

  transitionFacebookPost(
    post.id,
    ["queued", "context_ready", "drafts_ready", "partial_failed"],
    "generating",
  );
  const generationContext = existing.length
    ? post.context || input.context
    : input.context;
  let unexpectedError: unknown = null;
  try {
    if (!existing.length) updateFacebookPost(post.id, { context: input.context });
    const assignments = existing.length
      ? existing
      : replaceFacebookAssignments(post.id, expanded!);
    const deviceOrder = new Map(
      plannedDeviceIds.map((deviceId, index) => [deviceId, index]),
    );
    const pending = assignments.filter(
      (assignment) =>
        !assignment.draft_id && ["pending", "failed"].includes(assignment.status),
    );
    let fatalError: unknown = null;
    await mapWithConcurrency(
      pending,
      appConfig.deepSeekGenerationConcurrency,
      async (assignment) => {
        if (fatalError) {
          updateFacebookAssignment(assignment.id, {
            status: "failed",
            error: fatalError instanceof Error ? fatalError.message : String(fatalError),
          });
          return;
        }
        updateFacebookAssignment(assignment.id, { status: "generating", error: null });
        try {
          const position = deviceOrder.get(assignment.device_id) ?? 0;
          const draft = await generateDraft({
            kind: "social_comment",
            platform: "facebook",
            context: generationContext,
            intent: assignment.intent,
            tone: assignment.tone,
            variation: `Borrador independiente ${position + 1} de ${assignments.length}. Redacta una variante propia para esta asignación.`,
          });
          updateFacebookAssignment(assignment.id, {
            draft_id: draft.id,
            status: "draft",
            error: null,
          });
        } catch (error) {
          const providerStatus =
            error instanceof AppError &&
            error.details &&
            typeof error.details === "object" &&
            "providerStatus" in error.details
              ? Number(error.details.providerStatus)
              : 0;
          if (
            error instanceof AppError &&
            (["DEEPSEEK_NOT_CONFIGURED", "DEEPSEEK_AUTH_FAILED"].includes(
              error.code,
            ) ||
              (providerStatus >= 400 &&
                providerStatus < 500 &&
                ![408, 409, 429].includes(providerStatus)))
          ) {
            fatalError = error;
          }
          updateFacebookAssignment(assignment.id, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
  } catch (error) {
    unexpectedError = error;
  } finally {
    const interruptedMessage = unexpectedError
      ? unexpectedError instanceof Error
        ? unexpectedError.message
        : String(unexpectedError)
      : "La generación se interrumpió antes de completar esta asignación.";
    for (const assignment of listFacebookAssignments(post.id)) {
      if (assignment.status === "generating") {
        updateFacebookAssignment(assignment.id, {
          status: "failed",
          error: interruptedMessage,
        });
      }
    }
    const finalAssignments = listFacebookAssignments(post.id);
    const failures = finalAssignments.filter((assignment) => !assignment.draft_id).length;
    const preserved = finalAssignments.length - failures;
    updateFacebookPost(post.id, {
      status: failures ? "partial_failed" : "drafts_ready",
      error: failures
        ? `${failures} de ${finalAssignments.length} comentarios siguen pendientes. ${preserved} borrador(es) correcto(s) se conservaron.`
        : null,
    });
  }
  if (unexpectedError) throw unexpectedError;
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

export async function executePostAssignments(
  postId: string,
  timing: { minDelaySeconds: number; maxDelaySeconds: number },
) {
  const post = currentPost(postId);
  const batch = getFacebookBatch(post.batch_id)!;
  if (batch.plan_version === "rotation_v1") {
    throw new AppError(
      "Esta cola debe ejecutarse por rondas desde el control general.",
      409,
      "ROTATION_BATCH_REQUIRED",
    );
  }
  const assignments = listFacebookAssignments(post.id);
  const executableAssignments = assignments.filter(
    (assignment) => assignment.status === "approved" && assignment.draft_id,
  );
  if (
    !executableAssignments.length ||
    assignments.some((assignment) =>
      !["approved", "sent", "failed"].includes(assignment.status),
    )
  ) {
    throw new AppError(
      "No hay comentarios aprobados pendientes de ejecución.",
      409,
      "COMMENTS_NOT_APPROVED",
    );
  }

  await Promise.all(
    executableAssignments.map((assignment) =>
      ensureAutomationDeviceReady(assignment.device_id),
    ),
  );
  currentPost(post.id);
  transitionFacebookPost(post.id, ["approved"], "running");
  for (const [index, assignment] of executableAssignments.entries()) {
    updateFacebookAssignment(assignment.id, { status: "running", error: null });
    try {
      await sendApprovedMessage(
        assignment.draft_id!,
        assignment.device_id,
        post.url,
        assignment.id,
      );
      updateFacebookAssignment(assignment.id, { status: "sent", error: null });
    } catch (error) {
      updateFacebookAssignment(
        assignment.id,
        assignmentOutcomeAfterSendError(assignment.draft_id!, error),
      );
    }

    if (index < executableAssignments.length - 1) {
      const delaySeconds = randomInt(
        timing.minDelaySeconds,
        timing.maxDelaySeconds + 1,
      );
      await wait(delaySeconds * 1_000);
    }
  }

  const finalAssignments = listFacebookAssignments(post.id);
  const unknown = finalAssignments.filter(
    (assignment) => assignment.status === "outcome_unknown",
  ).length;
  const retryable = finalAssignments.filter(
    (assignment) => assignment.status === "approved",
  ).length;
  const failures = finalAssignments.filter(
    (assignment) => assignment.status === "failed",
  ).length;
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
        ? `${retryable} dispositivos no iniciaron la acción y pueden reintentarse.`
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
      `${retryable} dispositivos no iniciaron la acción; puedes reintentarlos con los mismos comentarios aprobados.`,
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

function updateRotationPostStatus(post: FacebookPostRow) {
  const assignments = listFacebookAssignments(post.id);
  const unknown = assignments.filter(
    (assignment) => assignment.status === "outcome_unknown",
  ).length;
  const running = assignments.filter(
    (assignment) => assignment.status === "running",
  ).length;
  const approved = assignments.filter(
    (assignment) => assignment.status === "approved",
  ).length;
  const failures = assignments.filter(
    (assignment) => assignment.status === "failed",
  ).length;
  updateFacebookPost(post.id, {
    status: unknown
      ? "outcome_unknown"
      : running
        ? "running"
        : approved
          ? "approved"
          : failures
            ? "partial_failed"
            : "completed",
    error: unknown
      ? `${unknown} dispositivos tienen un resultado público pendiente de verificación manual.`
      : approved && failures
        ? `${failures} acciones fallaron; quedan ${approved} comentarios aprobados por ejecutar.`
        : failures
          ? `${failures} de ${assignments.length} dispositivos no completaron la acción.`
          : null,
  });
}

function assignmentOutcomeAfterSendError(draftId: string, error: unknown) {
  const draftStatus = getDraft(draftId)?.status;
  const status = draftStatus === "approved"
    ? "approved" as const
    : draftStatus === "failed"
      ? "failed" as const
      : "outcome_unknown" as const;
  return {
    status,
    error: status === "approved"
      ? null
      : error instanceof Error
        ? error.message
        : String(error),
  };
}

function assertRotationExecutionClaim(
  batchId: string,
  roundIndex: number,
  postId?: string,
) {
  const batch = getFacebookBatch(batchId);
  if (
    !batch ||
    batch.status !== "active" ||
    batch.plan_version !== "rotation_v1" ||
    batch.execution_status !== "running" ||
    batch.current_round !== roundIndex
  ) {
    throw new AppError(
      "La cola cambió durante la ejecución de la ronda.",
      409,
      "BATCH_ROUND_CHANGED",
    );
  }
  if (postId) {
    const post = getFacebookPost(postId);
    if (!post || post.batch_id !== batchId || post.status === "skipped") {
      throw new AppError(
        "La publicación cambió durante la ejecución de la ronda.",
        409,
        "POST_STATE_CHANGED",
      );
    }
  }
}

function assertRotationPrepared(
  posts: FacebookPostRow[],
  deviceIds: string[],
) {
  for (const post of posts) {
    if (post.status === "skipped") continue;
    const assignments = listFacebookAssignments(post.id);
    const assignmentDevices = new Set(assignments.map((item) => item.device_id));
    if (
      assignments.length !== deviceIds.length ||
      deviceIds.some((deviceId) => !assignmentDevices.has(deviceId)) ||
      assignments.some(
        (assignment) =>
          !assignment.draft_id ||
          !["approved", "sent", "failed", "outcome_unknown"].includes(
            assignment.status,
          ),
      )
    ) {
      throw new AppError(
        `La publicación ${post.position + 1} todavía no tiene todos sus comentarios aprobados.`,
        409,
        "ROTATION_NOT_PREPARED",
      );
    }
  }
}

export async function executeFacebookBatch(
  batchId: string,
  timing: {
    minDelaySeconds: number;
    maxDelaySeconds: number;
    minRoundDelaySeconds: number;
    maxRoundDelaySeconds: number;
  },
) {
  const initialBatch = getFacebookBatch(batchId);
  if (!initialBatch) throw new AppError("Cola no encontrada.", 404, "NOT_FOUND");
  if (initialBatch.plan_version !== "rotation_v1") {
    throw new AppError(
      "Esta cola usa el flujo anterior por publicación.",
      409,
      "LEGACY_BATCH_REQUIRED",
    );
  }

  claimFacebookBatchExecution(batchId);
  let releaseRequired = true;
  const releaseAndSnapshot = () => {
    releaseFacebookBatchExecution(batchId);
    releaseRequired = false;
    return getFacebookBatchSnapshot();
  };
  try {
    const posts = listFacebookPosts(batchId);
    const activePosts = posts.filter((post) => post.status !== "skipped");
    const unresolvedOutcomes = activePosts.flatMap((post) =>
      listFacebookAssignments(post.id).filter(
        (assignment) => assignment.status === "outcome_unknown",
      ),
    ).length;
    if (unresolvedOutcomes) {
      throw new AppError(
        `${unresolvedOutcomes} resultados deben verificarse antes de continuar la rotación.`,
        409,
        "FACEBOOK_OUTCOME_UNKNOWN",
      );
    }
    const deviceIds = parseBatchDeviceIds(initialBatch.device_ids_json);
    const allSlots = listFacebookRotationSlots(batchId);
    if (!posts.length || !deviceIds.length) {
      throw new AppError(
        "El plan de rotación persistido está incompleto.",
        500,
        "INVALID_ROTATION_PLAN",
      );
    }
    const expectedSlots = buildFacebookRotationPlan(
      distributeFacebookDevices(deviceIds, posts.length),
    );
    const postIdsByPosition = new Map(
      posts.map((post) => [post.position, post.id]),
    );
    const expectedSlotKeys = new Set(
      expectedSlots.map((slot) =>
        `${postIdsByPosition.get(slot.postPosition)}\0${slot.deviceId}\0${slot.roundIndex}\0${slot.sequenceIndex}`,
      ),
    );
    if (
      allSlots.length !== expectedSlotKeys.size ||
      allSlots.some(
        (slot) =>
          !expectedSlotKeys.has(
            `${slot.post_id}\0${slot.device_id}\0${slot.round_index}\0${slot.sequence_index}`,
          ),
      )
    ) {
      throw new AppError(
        "El plan de rotación persistido está incompleto.",
        500,
        "INVALID_ROTATION_PLAN",
      );
    }
    assertRotationPrepared(posts, deviceIds);

    let batch = getFacebookBatch(batchId)!;
    if (batch.current_round >= posts.length) return releaseAndSnapshot();
    const scheduledTime = batch.next_execution_at
      ? Date.parse(batch.next_execution_at)
      : Number.NaN;
    if (Number.isFinite(scheduledTime) && scheduledTime > Date.now()) {
      return releaseAndSnapshot();
    }
    setFacebookBatchNextExecutionAt(batchId, null);
    {
      const roundIndex = batch.current_round;
      assertRotationExecutionClaim(batchId, roundIndex);
      const roundSlots = listFacebookRotationSlots(batchId, roundIndex).filter(
        (slot) => activePosts.some((post) => post.id === slot.post_id),
      );
      const postsById = new Map(activePosts.map((post) => [post.id, post]));
      const assignmentsByPost = new Map(
        activePosts.map((post) => [post.id, listFacebookAssignments(post.id)]),
      );
      const assignmentsByPair = new Map<string, FacebookAssignmentRow>();
      for (const [postId, assignments] of assignmentsByPost) {
        for (const assignment of assignments) {
          assignmentsByPair.set(`${postId}\0${assignment.device_id}`, assignment);
        }
      }
      const roundItems = roundSlots.map((slot) => {
        const post = postsById.get(slot.post_id);
        const assignment = assignmentsByPair.get(
          `${slot.post_id}\0${slot.device_id}`,
        );
        if (!post || !assignment || !assignment.draft_id) {
          throw new AppError(
            "La ronda contiene una asignación incompleta.",
            500,
            "INVALID_ROTATION_PLAN",
          );
        }
        return { slot, post, assignment };
      });
      const unknownBeforeRun = roundItems.filter(
        ({ assignment }) => assignment.status === "outcome_unknown",
      ).length;
      if (unknownBeforeRun) {
        throw new AppError(
          `${unknownBeforeRun} resultados deben verificarse antes de continuar la ronda.`,
          409,
          "FACEBOOK_OUTCOME_UNKNOWN",
        );
      }
      if (
        roundItems.some(({ assignment }) =>
          !["approved", "sent", "failed"].includes(assignment.status),
        )
      ) {
        throw new AppError(
          "La ronda contiene comentarios que todavía no están aprobados.",
          409,
          "ROTATION_NOT_PREPARED",
        );
      }

      const executable = roundItems.filter(
        ({ assignment }) => assignment.status === "approved",
      );
      await Promise.all(
        executable.map(({ assignment }) =>
          ensureAutomationDeviceReady(assignment.device_id),
        ),
      );
      for (const post of activePosts) {
        if (roundItems.some((item) => item.post.id === post.id)) {
          updateFacebookPost(post.id, { status: "running", error: null });
        }
      }

      const lanes = activePosts.map((post) =>
        roundItems
          .filter(
            (item) =>
              item.post.id === post.id && item.assignment.status === "approved",
          )
          .sort((left, right) => left.slot.sequence_index - right.slot.sequence_index)
          .slice(0, 1),
      );
      const attemptedAssignmentIds = new Set(
        lanes.flat().map(({ assignment }) => assignment.id),
      );
      await runFacebookRound(
        lanes,
        async ({ post, assignment }) => {
          const current = listFacebookAssignments(post.id).find(
            (item) => item.id === assignment.id,
          );
          if (!current || current.status !== "approved" || !current.draft_id) return;
          assertRotationExecutionClaim(batchId, roundIndex, post.id);
          updateFacebookAssignment(current.id, { status: "running", error: null });
          try {
            await sendApprovedMessage(
              current.draft_id,
              current.device_id,
              post.url,
              current.id,
            );
            updateFacebookAssignment(current.id, { status: "sent", error: null });
          } catch (error) {
            updateFacebookAssignment(
              current.id,
              assignmentOutcomeAfterSendError(current.draft_id, error),
            );
          }
        },
        async () => {},
      );

      for (const post of activePosts) {
        if (roundItems.some((item) => item.post.id === post.id)) {
          updateRotationPostStatus(post);
        }
      }
      const finalByPair = new Map<string, FacebookAssignmentRow>();
      for (const post of activePosts) {
        for (const assignment of listFacebookAssignments(post.id)) {
          finalByPair.set(`${post.id}\0${assignment.device_id}`, assignment);
        }
      }
      const finalRoundAssignments = roundSlots
        .map((slot) => finalByPair.get(`${slot.post_id}\0${slot.device_id}`))
        .filter((assignment): assignment is FacebookAssignmentRow => Boolean(assignment));
      if (finalRoundAssignments.length !== roundSlots.length) {
        throw new AppError(
          "La ronda terminó con asignaciones faltantes.",
          500,
          "INVALID_ROTATION_PLAN",
        );
      }
      const disposition = getFacebookRoundDisposition(
        finalRoundAssignments.map(
          (assignment) => assignment.status as FacebookRoundAssignmentStatus,
        ),
      );
      if (disposition === "outcome_unknown") {
        const unknown = finalRoundAssignments.filter(
          (assignment) => assignment.status === "outcome_unknown",
        ).length;
        throw new AppError(
          `${unknown} dispositivos deben verificarse manualmente antes de continuar.`,
          409,
          "FACEBOOK_OUTCOME_UNKNOWN",
        );
      }
      const attemptedRetryable = finalRoundAssignments.filter(
        (assignment) =>
          attemptedAssignmentIds.has(assignment.id) && assignment.status === "approved",
      ).length;
      if (attemptedRetryable) {
        throw new AppError(
          `${attemptedRetryable} dispositivos no iniciaron la acción; reintenta este mismo paso.`,
          409,
          "FACEBOOK_EXECUTION_RETRYABLE",
        );
      }
      if (disposition === "retryable") {
        const pending = finalRoundAssignments.filter(
          (assignment) => assignment.status === "approved",
        ).length;
        const delaySeconds = randomInt(
          timing.minDelaySeconds,
          timing.maxDelaySeconds + 1,
        );
        setFacebookBatchNextExecutionAt(
          batchId,
          new Date(Date.now() + delaySeconds * 1_000).toISOString(),
        );
        if (!pending) {
          throw new AppError("La ronda no pudo programar su siguiente paso.", 500, "INVALID_ROTATION_PLAN");
        }
        return releaseAndSnapshot();
      }
      const failed = finalRoundAssignments.filter(
        (assignment) => assignment.status === "failed",
      ).length;
      if (failed) {
        throw new AppError(
          `${failed} comentarios no fueron enviados. Verifica y corrige la ronda antes de continuar.`,
          409,
          "FACEBOOK_ROUND_INCOMPLETE",
        );
      }

      batch = advanceFacebookBatchRound(
        batchId,
        roundIndex,
        roundIndex === posts.length - 1,
      );
      if (batch.current_round < posts.length) {
        const roundDelaySeconds = randomInt(
          timing.minRoundDelaySeconds,
          timing.maxRoundDelaySeconds + 1,
        );
        setFacebookBatchNextExecutionAt(
          batchId,
          new Date(Date.now() + roundDelaySeconds * 1_000).toISOString(),
        );
        return releaseAndSnapshot();
      }
    }

    for (const post of activePosts) updateRotationPostStatus(post);
    const failures = activePosts.flatMap((post) =>
      listFacebookAssignments(post.id),
    ).filter((assignment) => assignment.status === "failed").length;
    if (failures) {
      throw new AppError(
        `La rotación terminó con ${failures} acciones fallidas registradas.`,
        502,
        "FACEBOOK_EXECUTION_PARTIAL",
      );
    }
    return releaseAndSnapshot();
  } finally {
    if (releaseRequired) releaseFacebookBatchExecution(batchId);
  }
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
      : assignment.status === "failed" && Boolean(assignment.draft_id),
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

  for (const assignment of unknown) {
    const sent = byAssignment.get(assignment.id) === "sent";
    updateFacebookAssignment(assignment.id, {
      status: sent ? "sent" : "approved",
      error: null,
    });
    if (assignment.draft_id) {
      setDraftOutcome(
        assignment.draft_id,
        sent ? "sent" : "approved",
        null,
      );
    }
  }

  const reconciled = listFacebookAssignments(post.id);
  if (
    reconciled.some(
      (assignment) => !["approved", "sent", "failed"].includes(assignment.status),
    )
  ) {
    throw new AppError(
      "La verificación no resolvió todas las asignaciones.",
      409,
      "RECONCILIATION_INCOMPLETE",
    );
  }
  const approved = reconciled.filter(
    (assignment) => assignment.status === "approved",
  ).length;
  const notSent = reconciled.filter((assignment) => assignment.status === "failed").length;
  updateFacebookPost(post.id, {
    status: approved ? "approved" : notSent ? "partial_failed" : "completed",
    error: approved
      ? `${approved} dispositivos quedaron listos para reintentar.`
      : notSent
        ? `${notSent} dispositivos fueron verificados como no enviados.`
        : null,
  });
  if (!approved && !notSent) finishBatchIfNeeded(post.batch_id);
  return getFacebookBatchSnapshot();
}

export function skipFacebookPost(postId: string) {
  const post = currentPost(postId);
  const batch = getFacebookBatch(post.batch_id)!;
  if (
    batch.plan_version === "rotation_v1" &&
    (batch.current_round > 0 || hasFacebookBatchPublicActions(batch.id))
  ) {
    throw new AppError(
      "No se puede omitir una publicación después de iniciar la rotación.",
      409,
      "ROTATION_ALREADY_STARTED",
    );
  }
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
