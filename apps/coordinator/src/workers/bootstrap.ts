import { isAbsolute } from "node:path";
import type { IssuedWorker, WorkerScope } from "./types.js";

export function workerBootstrap(input: { issued: IssuedWorker; scope: WorkerScope; skillPaths: string[];
  fixedContext: string; taskInstruction: string; waitUntilUtc: string }): string {
  if (!isAbsolute(input.issued.wrapperPath) || input.skillPaths.some(path => !isAbsolute(path)) ||
      input.issued.metadataWithoutSecret.scope.runId !== input.scope.runId) throw new Error("Invalid worker bootstrap scope");
  return [
    "You are a managed evoLoop worker. Use the CLI wrapper for authorized reads and submissions.",
    `CLI wrapper: ${input.issued.wrapperPath}`,
    `Project: ${input.scope.projectId}; Loop: ${input.scope.loopId}; Task: ${input.scope.taskId}; Run: ${input.scope.runId}; Session: ${input.scope.sessionId}.`,
    `Actor: ${input.issued.principal.actorId}; role: ${input.scope.roleId}; kind: ${input.scope.kind}.`,
    `Business skills: ${input.skillPaths.join(", ") || "none"}.`,
    `Fixed context: ${input.fixedContext}`,
    `Task instruction: ${input.taskInstruction}`,
    "Read the fixed Task context and original materials before acting. Preserve revision IDs, hashes, sources, operation IDs and CLI receipts.",
    "Submit formal changes with the CLI wrapper using command/request JSON. A completed Run is not a Delivery, and Delivery is not observed use.",
    "For an unknown write result, reconcile the same receipt and operation ID; do not send a new operation as a guess.",
    `Wait only until ${input.waitUntilUtc}; on missing authority, expired credential, unavailable material or uncertain result, stop and report the boundary.`,
  ].join("\n");
}
