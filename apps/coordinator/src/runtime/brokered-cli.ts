import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import type { WorkerCredentialBroker } from "../workers/credentials.js";
import type { CliBootstrap } from "./lightweight-input.js";

/** Reuse only the worker credential issued for this exact managed Run and Task. */
export async function brokeredCliForRun(broker: Pick<WorkerCredentialBroker, "lookup"> | null,
  session: RuntimeSessionRecord | null, run: RuntimeRunRecord): Promise<CliBootstrap | null> {
  if (!broker || !session || session.id !== run.sessionId || session.projectId !== run.projectId ||
      session.state !== "ready") return null;
  const issued = await broker.lookup(run.id);
  if (!issued || issued.metadataWithoutSecret.scope.projectId !== run.projectId ||
      issued.metadataWithoutSecret.scope.taskId !== run.taskId ||
      issued.metadataWithoutSecret.scope.sessionId !== run.sessionId ||
      issued.metadataWithoutSecret.scope.runId !== run.id ||
      issued.metadataWithoutSecret.actorId !== issued.principal.actorId) return null;
  return { command: issued.wrapperPath, actorId: issued.principal.actorId };
}
