export type FacebookRotationSlot = {
  postPosition: number;
  deviceId: string;
  roundIndex: number;
  sequenceIndex: number;
};

export type FacebookRoundAssignmentStatus =
  | "approved"
  | "sent"
  | "failed"
  | "outcome_unknown";

export function getFacebookRoundDisposition(
  statuses: readonly FacebookRoundAssignmentStatus[],
) {
  if (!statuses.length) {
    throw new Error("La ronda no contiene asignaciones.");
  }
  if (statuses.includes("outcome_unknown")) return "outcome_unknown" as const;
  if (statuses.includes("approved")) return "retryable" as const;
  if (statuses.includes("failed")) return "failed" as const;
  if (statuses.every((status) => status === "sent")) return "complete" as const;
  throw new Error("La ronda contiene un estado inválido.");
}

export function buildFacebookRotationPlan(
  deviceGroups: readonly (readonly string[])[],
) {
  if (!deviceGroups.length) {
    throw new Error("La rotación debe contener al menos un grupo.");
  }

  const slots: FacebookRotationSlot[] = [];
  for (let roundIndex = 0; roundIndex < deviceGroups.length; roundIndex++) {
    for (const [groupIndex, deviceIds] of deviceGroups.entries()) {
      const postPosition = (groupIndex + roundIndex) % deviceGroups.length;
      for (const [sequenceIndex, deviceId] of deviceIds.entries()) {
        slots.push({ postPosition, deviceId, roundIndex, sequenceIndex });
      }
    }
  }
  return slots.sort(
    (left, right) =>
      left.roundIndex - right.roundIndex ||
      left.postPosition - right.postPosition ||
      left.sequenceIndex - right.sequenceIndex,
  );
}

export async function runFacebookRound<T>(
  lanes: readonly (readonly T[])[],
  execute: (item: T) => Promise<void>,
  pauseBetweenItems: () => Promise<void>,
) {
  const results = await Promise.allSettled(
    lanes.map(async (lane) => {
      for (const [index, item] of lane.entries()) {
        await execute(item);
        if (index < lane.length - 1) await pauseBetweenItems();
      }
    }),
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
}
