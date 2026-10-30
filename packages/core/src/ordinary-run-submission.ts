import type { Principal, RuntimeRunRecord } from "@evoloop/contracts";
import { ordinaryRunSubmissionSchema, type OrdinaryRunSubmissionCommand,
  type OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import { DomainError } from "@evoloop/contracts/ports";
import { ArtifactReferenceError, parseArtifactReference } from "@evoloop/contracts/artifact-reference";
import type { ContentHasher } from "@evoloop/contracts/ports";
import { canonicalJson } from "./index.js";

/** The caller supplies one project transaction for every read and the first insert. */
export interface OrdinaryRunSubmissionStore {
  get(runId: string): Promise<OrdinaryRunSubmissionRecord | null>;
  getByOperationId(operationId: string): Promise<OrdinaryRunSubmissionRecord | null>;
  hasWorkflowOperation(operationId: string): Promise<boolean>;
  getRun(runId: string): Promise<RuntimeRunRecord | null>;
  getFixedRecipient(runId: string): Promise<string | null>;
  getDocumentRevisionHash(documentId: string, revisionId: string): Promise<string | null>;
  hasManagedDispatch(runId: string): Promise<boolean>;
  insert(record: OrdinaryRunSubmissionRecord): Promise<void>;
}

const authorized = (principal: Principal, projectId: string): boolean =>
  !!principal.actorId && principal.projectIds.includes(projectId) && principal.permissions.includes("write");

/** No terminal text, Run creator, or caller-supplied actor can sign this intent. */
export async function submitOrdinaryRun(
  store: OrdinaryRunSubmissionStore, principal: Principal, input: OrdinaryRunSubmissionCommand,
  nowUtc: string, hasher: ContentHasher,
): Promise<OrdinaryRunSubmissionRecord> {
  const parsed = ordinaryRunSubmissionSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("INVALID_COMMAND", parsed.error.message);
  const command = parsed.data;
  if (!authorized(principal, command.projectId)) throw new DomainError("FORBIDDEN", "Project write permission is required");
  if (command.operationId === command.deliveryOperationId)
    throw new DomainError("OPERATION_REUSED", "Submission and Delivery need separate fixed operation IDs");
  const commandHash = hasher.hash(canonicalJson({ actorId: principal.actorId, command }));
  const byOperation = await store.getByOperationId(command.operationId);
  if (byOperation && (byOperation.runId !== command.runId || byOperation.commandHash !== commandHash ||
    byOperation.submittedBy !== principal.actorId))
    throw new DomainError("OPERATION_REUSED", "Operation ID was used for another submission");
  const prior = await store.get(command.runId);
  if (prior) {
    if (prior.operationId !== command.operationId || prior.commandHash !== commandHash ||
      prior.submittedBy !== principal.actorId)
      throw new DomainError("SUBMISSION_EXISTS", "Run already has a different signed result intent");
    return prior; // The original write may have succeeded before its response was lost.
  }
  if (await store.hasWorkflowOperation(command.deliveryOperationId))
    throw new DomainError("OPERATION_REUSED", "Delivery operation ID already belongs to a workflow command");
  const run = await store.getRun(command.runId);
  if (!run || run.projectId !== command.projectId || run.taskId !== command.taskId ||
    run.sessionId !== command.sessionId || run.taskRevisionId !== command.taskRevisionId ||
    run.inputHash !== command.runInputHash)
    throw new DomainError("RUN_MISMATCH", "Submission does not match the fixed Run input");
  if (!(["requested", "dispatching", "running"] as string[]).includes(run.state))
    throw new DomainError("RUN_NOT_ACTIVE", "First submission must be saved before terminal or unknown Run state");
  if (await store.hasManagedDispatch(run.id))
    throw new DomainError("MANAGED_RUN", "Managed Loop Runs use their brokered worker submission");
  const recipient = await store.getFixedRecipient(run.id);
  if (!recipient || recipient !== principal.actorId)
    throw new DomainError("FORBIDDEN", "Only the fixed recipient of this Run may submit its result");
  let artifact: ReturnType<typeof parseArtifactReference>;
  try { artifact = parseArtifactReference(command.deliveryIntent.artifactRef,
    command.deliveryIntent.artifactRevision, command.projectId); }
  catch (error) {
    if (error instanceof ArtifactReferenceError) throw new DomainError(error.code, error.message);
    throw error;
  }
  if (artifact.kind === 'document') {
    const actualHash = await store.getDocumentRevisionHash(artifact.documentId, artifact.revisionId);
    if (!actualHash) throw new DomainError('ARTIFACT_DOCUMENT_NOT_FOUND',
      'Read the exact Document revision in this project before submitting its fixed route');
    if (actualHash.toLowerCase() !== command.deliveryIntent.contentHash.toLowerCase())
      throw new DomainError('ARTIFACT_HASH_MISMATCH',
        'contentHash must equal the saved Document revision SHA-256; read that revision and retry');
  }
  const record: OrdinaryRunSubmissionRecord = {
    projectId: command.projectId, id: command.submissionId, runId: run.id,
    taskId: run.taskId, sessionId: run.sessionId, taskRevisionId: run.taskRevisionId,
    runInputHash: run.inputHash, operationId: command.operationId, commandHash,
    deliveryOperationId: command.deliveryOperationId, deliveryCommandHash: null,
    deliveryIntent: { ...command.deliveryIntent, artifactRef: artifact.artifactRef },
    submittedBy: principal.actorId, state: "submitted", version: 1,
    expectedTaskVersion: null, terminalRunVersion: null, sealedBy: null,
    deliveryId: null, reason: null, createdAtUtc: nowUtc, updatedAtUtc: nowUtc,
  };
  await store.insert(record);
  return record;
}
