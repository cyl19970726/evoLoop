import type { AppliedResult, CommandResult, Operation, OutboxEvent, Principal, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { DocumentSource, GitSourceRef } from "@evoloop/contracts/sources";
import { formalSourceDecisionSchema, registerGitReferenceSchema, taskExternalReferenceSchema } from "@evoloop/contracts/references";
import type { FormalSourceDecisionCommand, ReferenceTransaction, ReferenceUnitOfWork, RegisterGitReference,
  TaskExternalReferenceCommand, TaskExternalReferenceRecord, ExternalReferenceKind, StudyReferenceProvenance } from "@evoloop/contracts/references";
import { currentRetentions } from "../runtime/basis.js";

export interface ExternalReferenceObservation {
  status: "reachable" | "unavailable" | "withdrawn" | "needs_review";
  revision: string; contentHash: string;
  currentRevision: string; currentHash: string; currentValidity: "valid" | "needs_review" | "withdrawn" | "unavailable";
}
export interface ReferenceDependencies {
  uow: ReferenceUnitOfWork; git: DocumentSource;
  observeExternal(principal: Principal, projectId: string, kind: ExternalReferenceKind, referenceId: string,
    revision: string, contentHash: string): Promise<ExternalReferenceObservation>;
  hashText(value: string): string; nextId(): string; now(): string;
}
/** A Run reference identifies the frozen input, not a hash of its mutable native transcript. */
export function fixedRunMatches(projectId: string, run: RuntimeRunRecord | null, session: RuntimeSessionRecord | null,
  referenceId: string, revision: string, contentHash: string): boolean {
  return !!run && !!session && run.projectId === projectId && session.projectId === projectId &&
    run.id === referenceId && run.taskRevisionId === revision && run.inputHash === contentHash &&
    ["completed", "failed", "interrupted"].includes(run.state) && !!run.nativeTurnId &&
    run.sessionId === session.id && session.state === "ready" && !!session.nativeThreadId && !!session.nativeSessionId;
}
type ReferenceCommand = RegisterGitReference | FormalSourceDecisionCommand | TaskExternalReferenceCommand;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  value && typeof value === "object" ? `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}` : JSON.stringify(value);

const studyIntentId = (hash: (value: string) => string, ...parts: string[]): string => {
  const hex = hash(JSON.stringify(parts));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
function authority(principal: Principal, command: ReferenceCommand, permission: "write" | "review"): void {
  if (!principal.actorId || principal.actorId !== command.actorId || !principal.projectIds.includes(command.projectId) ||
      !principal.permissions.includes(permission)) throw new DomainError("FORBIDDEN", "Project reference authority is required");
}
function replay(prior: Operation, principal: Principal, hash: string): CommandResult {
  if (prior.actorId !== principal.actorId || prior.commandHash !== hash)
    throw new DomainError("OPERATION_REUSED", "Operation ID was used for another reference decision");
  return prior.result;
}
async function journal(deps: ReferenceDependencies, principal: Principal, command: ReferenceCommand,
  type: "reference.git" | "reference.formal" | "reference.task", entityId: string,
  apply: (tx: ReferenceTransaction) => Promise<AppliedResult>, provenance?: StudyReferenceProvenance): Promise<CommandResult> {
  const commandHash = deps.hashText(canonical({ command, actorId: principal.actorId, ...(provenance ? {provenance} : {}) }));
  return deps.uow.transaction(command.projectId, async tx => {
    const prior = await tx.getOperation(command.operationId);
    if (prior) return replay(prior, principal, commandHash);
    let result: CommandResult;
    try { result = await tx.savepoint(() => apply(tx)); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      result = { status: "rejected", operationId: command.operationId, code: error.code, message: error.message,
        ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) };
    }
    const createdAt = deps.now();
    const operation: Operation = { projectId: command.projectId, id: command.operationId,
      actorId: principal.actorId, commandHash, commandType: type, result, createdAt };
    await tx.insertOperation(operation);
    if (result.status === "applied") {
      const event: OutboxEvent = { projectId: command.projectId, id: deps.nextId(), operationId: command.operationId,
        effectKey: `${command.projectId}:${type}:${entityId}`, kind: type, entityId,
        version: result.version ?? 1, createdAt };
      await tx.appendOutbox(event);
    }
    return result;
  });
}

/** The adapter validates full commit, allowlisted path, permissions and SHA before metadata enters PG. */
export async function registerFixedGitReference(deps: ReferenceDependencies, principal: Principal, input: unknown): Promise<CommandResult> {
  const command = registerGitReferenceSchema.parse(input);
  authority(principal, command, "write");
  const existing = await deps.uow.read(command.projectId, reader => reader.getOperation(command.operationId));
  const commandHash = deps.hashText(canonical({ command, actorId: principal.actorId }));
  if (existing) return replay(existing, principal, commandHash);
  const ref: GitSourceRef = { projectId: command.projectId, repositoryId: command.repositoryId,
    path: command.path, commit: command.commit, contentHash: command.contentHash };
  const observed = await deps.git.read(ref);
  if (observed.status !== "available") return journal(deps, principal, command, "reference.git", command.referenceId,
    async () => { throw new DomainError("BASIS_UNAVAILABLE", `Fixed Git original is unavailable: ${observed.reason}`); });
  return journal(deps, principal, command, "reference.git", command.referenceId, async tx => {
    if (await tx.getGitSourceRef(command.referenceId)) throw new DomainError("ALREADY_EXISTS", "Git reference ID exists");
    await tx.insertGitSourceRef(command.referenceId, ref, "reachable", observed.observedAt);
    return { status: "applied", operationId: command.operationId, entityId: command.referenceId, version: 1 };
  });
}

export async function recordFormalSourceDecision(deps: ReferenceDependencies, principal: Principal, input: unknown): Promise<CommandResult> {
  const command = formalSourceDecisionSchema.parse(input);
  authority(principal, command, "review");
  const prior = await deps.uow.read(command.projectId, reader => reader.getOperation(command.operationId));
  const commandHash = deps.hashText(canonical({ command, actorId: principal.actorId }));
  if (prior) return replay(prior, principal, commandHash);
  const registered = await deps.uow.read(command.projectId, reader => reader.getGitSourceRef(command.gitReferenceId));
  if (!registered || registered.state !== "reachable") return journal(deps, principal, command, "reference.formal", command.decisionId,
    async () => { throw new DomainError("NOT_FOUND", "Fixed Git reference was not registered"); });
  // The byte check proves reachability and identity only. Adoption/incorporation is the reviewer's attributed claim.
  const observed = await deps.git.read(registered.ref);
  if (observed.status !== "available") return journal(deps, principal, command, "reference.formal", command.decisionId,
    async () => { throw new DomainError("BASIS_UNAVAILABLE", "Fixed Git original is unavailable"); });
  return journal(deps, principal, command, "reference.formal", command.decisionId, async tx => {
    const source = await tx.getGitSourceRef(command.gitReferenceId);
    if (!source || source.state !== "reachable" || source.ref.projectId !== command.projectId)
      throw new DomainError("NOT_FOUND", "Fixed Git reference was not registered and reachable");
    const document = await tx.getDocument(command.documentId);
    const revision = await tx.getDocumentPayloadRevision(command.documentId, command.documentRevisionId);
    if (!document || !revision || revision.projectId !== command.projectId)
      throw new DomainError("NOT_FOUND", "Process document revision was not found");
    if (command.decision === "incorporated" && document.adoptedRevisionId !== revision.id)
      throw new DomainError("BASIS_CHANGED", "Incorporation requires the adopted process revision");
    await tx.insertFormalSourceDecision({ projectId: command.projectId, id: command.decisionId,
      gitReferenceId: command.gitReferenceId, documentId: command.documentId,
      documentRevisionId: command.documentRevisionId, decision: command.decision,
      actorId: principal.actorId, reason: command.reason, createdAt: deps.now() });
    return { status: "applied", operationId: command.operationId, entityId: command.decisionId, version: 1 };
  });
}

export async function decideTaskExternalReference(deps: ReferenceDependencies, principal: Principal, input: unknown): Promise<CommandResult> {
  return decideReference(deps, principal, input);
}

/** Managed runner entry; current authority is resolved from trusted PG facts in the reference transaction. */
export async function applyDeclaredStudyReference(deps: ReferenceDependencies, principal: Principal,
  input: unknown, provenance: StudyReferenceProvenance): Promise<CommandResult> {
  return decideReference(deps, principal, input, provenance);
}

async function decideReference(deps: ReferenceDependencies, principal: Principal, input: unknown,
  provenance?: StudyReferenceProvenance): Promise<CommandResult> {
  const command = taskExternalReferenceSchema.parse(input);
  authority(principal, command, provenance ? "write" : "review");
  if (provenance && (command.kind !== "run" || command.decision !== "adopt" ||
    command.expectedHeadVersion !== 0 || !principal.permissions.includes("read")))
    throw new DomainError("STUDY_AUTHORITY_DENIED", "Study material may only adopt one declared Run into a fresh slot");
  if (provenance) {
    const parts = [provenance.declarationId, provenance.inboxId, provenance.sourceDecisionId];
    if (command.operationId !== studyIntentId(deps.hashText, ...parts, "reference") ||
      command.decisionId !== studyIntentId(deps.hashText, ...parts, "decision") ||
      command.slotId !== studyIntentId(deps.hashText, ...parts, "slot"))
      throw new DomainError("STUDY_AUTHORITY_DENIED", "Study copy requires the runner's exact operation, decision and slot identities");
  }
  const prior = await deps.uow.read(command.projectId, reader => reader.getOperation(command.operationId));
  const commandHash = deps.hashText(canonical({ command, actorId: principal.actorId, ...(provenance ? {provenance} : {}) }));
  if (prior) return replay(prior, principal, commandHash);
  const observed = await deps.observeExternal(principal, command.projectId, command.kind, command.referenceId,
    command.revision, command.contentHash);
  if (observed.status !== "reachable" || observed.revision !== command.revision || observed.contentHash !== command.contentHash ||
      observed.currentValidity !== "valid" ||
      command.decision !== "retain" && (observed.currentRevision !== command.revision || observed.currentHash !== command.contentHash))
    return journal(deps, principal, command, "reference.task", command.taskId,
      async () => { throw new DomainError("BASIS_UNAVAILABLE", "External reference is changed, withdrawn or unavailable"); }, provenance);
  return journal(deps, principal, command, "reference.task", command.taskId, async tx => {
    if (provenance) {
      const source = await tx.resolveStudyReferenceAuthority(provenance, command.taskId, principal.actorId);
      if (!source || source.kind !== "run" || source.id !== provenance.sourceDecisionId ||
        source.referenceId !== command.referenceId || source.revision !== command.revision ||
        source.contentHash !== command.contentHash)
        throw new DomainError("STUDY_AUTHORITY_DENIED", "Current declaration, source and target Task do not match");
    }
    const task = await tx.getTask(command.taskId);
    const revision = await tx.getTaskRevision(command.taskId, command.taskRevisionId);
    if (!task || !revision || task.currentRevisionId !== command.taskRevisionId || task.version !== command.expectedTaskVersion)
      throw new DomainError("VERSION_CONFLICT", "Task changed before reference decision", task?.version);
    if (task.state === "done" || task.state === "cancelled")
      throw new DomainError("INVALID_STATE", "Closed Task cannot adopt another external reference");
    if ((await tx.listImpacts(task.id)).some(impact => impact.state === "pending"))
      throw new DomainError("PENDING_BASIS_REVIEW", "Review pending process document impacts before external adoption");
    if (command.kind === "git") {
      const git = await tx.getGitSourceRef(command.referenceId);
      if (!git || git.state !== "reachable" || git.ref.commit !== command.revision || git.ref.contentHash !== command.contentHash)
        throw new DomainError("BASIS_UNAVAILABLE", "Git reference is not the registered fixed original");
    }
    if (command.kind === "run") {
      const run = await tx.getRuntimeRun(command.referenceId);
      const session = run ? await tx.getRuntimeSession(run.sessionId) : null;
      if (!fixedRunMatches(command.projectId, run, session, command.referenceId, command.revision, command.contentHash))
        throw new DomainError("BASIS_UNAVAILABLE", "Run no longer has a bound terminal owned input");
    }
    const head = await tx.getTaskExternalHead(command.taskId, command.slotId);
    if ((head?.version ?? 0) !== command.expectedHeadVersion)
      throw new DomainError("VERSION_CONFLICT", "External reference slot changed", head?.version ?? 0);
    if (command.decision === "adopt" && head || command.decision !== "adopt" && !head)
      throw new DomainError("INVALID_COMMAND", "Adopt requires a new slot; retain/replace require an existing slot");
    if (command.decision === "retain" && head) {
      const history = await tx.listTaskExternalReferences(command.taskId);
      const previous = history.find(entry => entry.id === head.decisionId);
      if (!previous || previous.kind !== command.kind || previous.referenceId !== command.referenceId || previous.revision !== command.revision ||
          previous.contentHash !== command.contentHash)
        throw new DomainError("INVALID_COMMAND", "Retain must keep the exact fixed reference; use replace for a new source");
    }
    const value: TaskExternalReferenceRecord = { projectId: command.projectId, id: command.decisionId,
      taskId: command.taskId, taskRevisionId: command.taskRevisionId, slotId: command.slotId,
      version: command.expectedHeadVersion + 1, decision: command.decision, kind: command.kind,
      referenceId: command.referenceId, revision: command.revision, contentHash: command.contentHash,
      reason: command.reason, actionImpact: command.actionImpact, actorId: principal.actorId, createdAt: deps.now(),
      observedCurrentRevision: observed.currentRevision, observedCurrentHash: observed.currentHash,
      observedCurrentValidity: "valid", ...(provenance ? {studyProvenance: provenance} : {}) };
    await tx.insertTaskExternalDecision(value);
    if (!await tx.advanceTaskExternalHead({ projectId: command.projectId, taskId: command.taskId,
      slotId: command.slotId, version: value.version, decisionId: value.id }, command.expectedHeadVersion))
      throw new DomainError("VERSION_CONFLICT", "External reference slot changed");
    const nextRevisionId = deps.nextId();
    const nextBasisId = revision.basisSetId ? deps.nextId() : null;
    const nextRevision = { ...revision, id: nextRevisionId, version: task.version + 1, state: task.state,
      basisSetId: nextBasisId, actorId: principal.actorId,
      reason: `External reference ${command.decision}: ${command.reason}`, createdAt: deps.now() };
    await tx.insertTaskRevision(nextRevision);
    if (revision.basisSetId && nextBasisId) {
      const basis = await tx.getBasisSet(task.id, revision.id, revision.basisSetId);
      if (!basis || !basis.sealed) throw new DomainError("BASIS_UNAVAILABLE", "Current process basis is unavailable");
      const retentions = await currentRetentions(tx, basis);
      await tx.insertSealedBasisSet({ projectId: basis.projectId, taskId: basis.taskId, sealed: true,
        id: nextBasisId, taskRevisionId: nextRevisionId, members: basis.members.map(item => ({ ...item })),
        ...(retentions ? { retentions } : {}) });
    }
    await tx.updateTask({ ...task, version: nextRevision.version, currentRevisionId: nextRevisionId }, task.version);
    return { status: "applied", operationId: command.operationId, entityId: command.taskId,
      version: nextRevision.version, revisionId: nextRevisionId, decisionId: command.decisionId };
  }, provenance);
}
