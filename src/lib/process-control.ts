import "server-only";

import { cancelOperation } from "@/lib/automation-service";
import { listActiveOperations } from "@/lib/db";
import { abortAllFacebookWork } from "@/lib/facebook-batch-service";
import { abortAllDraftGenerations } from "@/lib/messages";

export async function abortAllProcesses() {
  const operations = new Map(
    listActiveOperations().map((operation) => [operation.id, operation]),
  );
  const facebook = abortAllFacebookWork();
  const stoppedGenerations = abortAllDraftGenerations();
  for (const operation of listActiveOperations()) {
    operations.set(operation.id, operation);
  }
  const failures: string[] = [];
  let cancelledOperations = 0;

  for (const operation of operations.values()) {
    try {
      await cancelOperation(operation.id);
      cancelledOperations++;
    } catch (error) {
      failures.push(
        `${operation.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    cancelledOperations,
    stoppedGenerations: stoppedGenerations + facebook.stoppedGenerations,
    stoppedExtractions: facebook.stoppedExtractions,
    pausedBatches: facebook.pausedBatches,
    failures,
  };
}
