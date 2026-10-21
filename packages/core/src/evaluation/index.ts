import type { AppliedResult, BasisSet, Principal, Task } from "@evoloop/contracts";
import type { EvaluationAttempt, EvaluationCommand, EvaluationDefinition, EvaluationSourceSignature } from "@evoloop/contracts/evaluation";
import { DomainError, type Reader, type Transaction } from "@evoloop/contracts/ports";

const need = <T>(value: T | null, name: string): T => {
  if (value === null) throw new DomainError("NOT_FOUND", `${name} not found`);
  return value;
};
export function canonicalEvaluationJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvaluationJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalEvaluationJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonicalEvaluationJson(a) === canonicalEvaluationJson(b);
const fixedOrder = <T>(items: T[], key: (item: T) => string) => [...items].sort((a, b) => key(a).localeCompare(key(b)));

export async function taskSignature(tx: Reader, task: Task, revisionId = task.currentRevisionId): Promise<EvaluationSourceSignature> {
  const revision = need(await tx.getTaskRevision(task.id, revisionId), "source Task revision");
  const basis = need(revision.basisSetId ? await tx.getBasisSet(task.id, revision.id, revision.basisSetId) : null, "source sealed basis");
  const external = await tx.listTaskExternalSnapshot(task.id, revision.id);
  const members = await Promise.all(basis.members.map(async item => {
    const source = need(await tx.getDocumentRevision(item.documentId, item.revisionId), "source basis document");
    return { ...item, contentHash: source.contentHash };
  }));
  // Older basis rows have no retention list; new rows preserve explicit old-version decisions.
  const withRetentions = basis as BasisSet & { retentions?: EvaluationSourceSignature["retentions"] };
  return { title: revision.title, contentDocumentId: revision.contentDocumentId,
    contentRevisionId: revision.contentRevisionId, acceptance: revision.acceptance,
    owner: revision.owner, kind: revision.kind ?? "unclassified",
    basis: fixedOrder(members, item => item.documentId),
    retentions: fixedOrder(withRetentions.retentions ?? [], item => item.documentId),
    external: fixedOrder(external.map(item => ({ slotId: item.slotId, kind: item.kind,
      referenceId: item.referenceId, revision: item.revision, contentHash: item.contentHash })), item => item.slotId) };
}

async function validateDefinition(tx: Transaction, definition: EvaluationDefinition, requireCurrentSource: boolean): Promise<void> {
  need(await tx.getTask(definition.ownerTaskId), "evaluation owner Task");
  const task = need(await tx.getTask(definition.case.taskId), "case Task");
  if (task.state !== "in_progress" || requireCurrentSource && task.currentRevisionId !== definition.case.sourceTaskRevisionId)
    throw new DomainError("EVALUATION_SOURCE_CHANGED", "Case Task must have a current in-progress source revision");
  if (!same(await taskSignature(tx, task, definition.case.sourceTaskRevisionId), definition.case.sourceSignature))
    throw new DomainError("EVALUATION_SOURCE_CHANGED", "Frozen source Task revision does not match its declared signature");
  const signature = await taskSignature(tx, task);
  if (!same(signature, definition.case.sourceSignature))
    throw new DomainError("EVALUATION_SIGNATURE_MISMATCH", "Frozen case signature does not match the current Task basis");
  if (signature.external.some(item => item.kind === "wiki"))
    throw new DomainError("WIKI_REQUIRED_BY_TASK", "Direct condition cannot omit Wiki required by the source Task");
  const [direct, wiki] = definition.conditions;
  if (direct.kind !== "direct" || direct.wikiRefs !== null || wiki.kind !== "wiki" || !wiki.wikiRefs?.length || direct.id === wiki.id)
    throw new DomainError("INVALID_EVALUATION_CONDITIONS", "One direct and one fixed-Wiki condition are required");
  if (direct.model !== wiki.model || !same(direct.environment, wiki.environment))
    throw new DomainError("CONDITION_MISMATCH", "Comparison conditions require identical declared model and environment");
  if (wiki.wikiRefs.some(ref => ref.kind !== "wiki") || new Set(wiki.wikiRefs.map(ref => `${ref.id}:${ref.revision}`)).size !== wiki.wikiRefs.length)
    throw new DomainError("INVALID_WIKI_REFS", "Wiki condition requires unique fixed Wiki revisions");
  for (const ref of [definition.protocol, ...definition.case.materials]) {
    if (ref.kind !== "document" && ref.kind !== "git")
      throw new DomainError("INVALID_COMMON_SOURCE", "Protocol and common materials must be fixed Document or Git sources");
    if (ref.kind === "document") {
      const source = need(await tx.getDocumentRevision(ref.id, ref.revision), "fixed document");
      if (source.contentHash !== ref.contentHash) throw new DomainError("SOURCE_HASH_MISMATCH", "Document source hash changed");
    } else if (ref.kind === "git") {
      const source = need(await tx.getGitSourceRef(ref.id), "fixed Git source");
      if (source.ref.contentHash !== ref.contentHash || source.ref.commit !== ref.revision || source.state !== "reachable")
        throw new DomainError("SOURCE_UNAVAILABLE", "Fixed Git source is unavailable or mismatched");
    }
  }
}

type Context = { tx: Transaction; command: EvaluationCommand; principal: Principal; now: string };
export async function applyEvaluation({ tx, command, principal, now }: Context): Promise<{ result: AppliedResult; effects: Array<{ kind: string; entityId: string; version: number }> }> {
  const base = { status: "applied" as const, operationId: command.operationId, entityId: command.evaluationId };
  if (command.type === "evaluation.create" || command.type === "evaluation.revise") {
    const current = await tx.getEvaluation(command.evaluationId);
    if (command.type === "evaluation.create" && current) throw new DomainError("ALREADY_EXISTS", "Evaluation exists");
    if (command.type === "evaluation.revise" && (!current || current.version !== command.expectedVersion))
      throw new DomainError("VERSION_CONFLICT", "Evaluation definition changed", current?.version);
    await validateDefinition(tx, command.definition, command.type === "evaluation.create");
    if (current && current.definition.case.taskId !== command.definition.case.taskId)
      throw new DomainError("EVALUATION_TASK_CHANGED", "A revision cannot move the evaluation to another case Task");
    if (await tx.getEvaluation(command.evaluationId, command.revisionId)) throw new DomainError("ALREADY_EXISTS", "Revision exists");
    const version = (current?.version ?? 0) + 1;
    await tx.insertEvaluationRevision({ projectId: command.projectId, evaluationId: command.evaluationId,
      id: command.revisionId, version, definition: command.definition, actorId: principal.actorId,
      reason: command.type === "evaluation.create" ? "Initial frozen definition" : command.reason, createdAt: now });
    return { result: { ...base, version, revisionId: command.revisionId }, effects: [{ kind: "evaluation", entityId: command.evaluationId, version }] };
  }
  const revision = need(await tx.getEvaluation(command.evaluationId, command.revisionId), "evaluation revision");
  if (command.type === "evaluation.assessment.record") {
    const attempts = await tx.listEvaluationAttempts(command.evaluationId, command.revisionId);
    const attempt = need(attempts.find(item => item.id === command.attemptId) ?? null, "evaluation attempt");
    const run = need(await tx.getRuntimeRun(attempt.runId), "attempt Run");
    if (run.projectId !== command.projectId || run.taskId !== revision.definition.case.taskId ||
      run.taskRevisionId !== attempt.actualTaskRevisionId || run.evaluationBinding?.attemptId !== attempt.id)
      throw new DomainError("ATTEMPT_RUN_MISMATCH", "Attempt and Run do not share the frozen execution revision");
    const delivery = command.deliveryId ? need(await tx.getDelivery(command.deliveryId), "delivery") : null;
    if (delivery && (delivery.projectId !== command.projectId || delivery.taskId !== run.taskId || delivery.taskRevisionId !== run.taskRevisionId))
      throw new DomainError("DELIVERY_MISMATCH", "Delivery is not from this attempt's Task revision");
    const observation = command.observationId
      ? need((await tx.listObservations(run.taskId)).find(item => item.id === command.observationId) ?? null, "consumer observation") : null;
    if (observation && (!delivery || observation.deliveryId !== delivery.id || observation.taskId !== run.taskId))
      throw new DomainError("OBSERVATION_MISMATCH", "Observation is not tied to this attempt's delivery");
    if (command.values.humanEffect === "observed" && (!observation || observation.observerKind !== "human"))
      throw new DomainError("HUMAN_EFFECT_UNOBSERVED", "Agent use alone cannot prove human effect");
    const condition = need(revision.definition.conditions.find(item => item.id === attempt.conditionId) ?? null, "attempt condition");
    if (condition.kind === "direct" && command.values.knowledgeAdoption !== "not_applicable")
      throw new DomainError("DIRECT_WIKI_NOT_APPLICABLE", "Direct condition has no Wiki adoption");
    if ((command.values.sourceFidelity === "qualified" || command.values.sourceFidelity === "failed" ||
      command.values.knowledgeAdoption === "correct" || command.values.knowledgeAdoption === "misused") && !command.evidence.length)
      throw new DomainError("ASSESSMENT_EVIDENCE_REQUIRED", "Determinate source or adoption findings require fixed evidence");
    if (command.values.deliveryQuality === "qualified" && (!delivery || delivery.technicalResult !== "passed"))
      throw new DomainError("DELIVERY_UNVERIFIED", "Qualified delivery requires a passed fixed delivery");
    const assessments = await tx.listEvaluationAssessments(command.evaluationId, command.revisionId);
    const old = command.supersedesId ? need(assessments.find(item => item.id === command.supersedesId) ?? null, "superseded assessment") : null;
    if (old && old.attemptId !== attempt.id) throw new DomainError("SUPERSEDES_SCOPE", "Correction must stay on the same attempt");
    if (!old && assessments.some(item => item.attemptId === attempt.id))
      throw new DomainError("CORRECTION_REQUIRED", "A later assessment must supersede the previous attempt assessment");
    if (assessments.some(item => item.id === command.assessmentId || item.supersedesId === command.supersedesId && command.supersedesId))
      throw new DomainError("ALREADY_EXISTS", "Assessment or correction already exists");
    await tx.insertEvaluationAssessment({ projectId: command.projectId, id: command.assessmentId,
      evaluationId: command.evaluationId, revisionId: command.revisionId, attemptId: attempt.id,
      deliveryId: command.deliveryId, observationId: command.observationId, supersedesId: command.supersedesId,
      values: command.values, costs: command.costs, evidence: command.evidence,
      assessorKind: command.assessorKind, actorId: principal.actorId, reason: command.reason, createdAt: now });
    return { result: { ...base, version: revision.version }, effects: [{ kind: "evaluation.assessment", entityId: command.assessmentId, version: 1 }] };
  }
  const assessments = await tx.listEvaluationAssessments(command.evaluationId, command.revisionId);
  const selected = command.assessmentIds.map(id => need(assessments.find(item => item.id === id) ?? null, "included assessment"));
  if (new Set(command.assessmentIds).size !== command.assessmentIds.length ||
    new Set(selected.map(item => item.attemptId)).size !== selected.length)
    throw new DomainError("DUPLICATE_ASSESSMENT", "Conclusion must select one assessment per attempt");
  const attempts = await tx.listEvaluationAttempts(command.evaluationId, command.revisionId);
  if (selected.length !== attempts.length || selected.some(item => !attempts.some(attempt => attempt.id === item.attemptId)))
    throw new DomainError("ATTEMPTS_UNASSESSED", "Conclusion must include one assessment for every recorded attempt, including failures");
  if (selected.some(item => assessments.some(other => other.supersedesId === item.id)))
    throw new DomainError("SUPERSEDED_ASSESSMENT", "Conclusion must use the latest corrected assessment for each attempt");
  if (command.comparability === "comparable")
    throw new DomainError("COMPARABILITY_UNPROVEN", "First-slice cost coverage and technical isolation do not establish full comparability");
  if (command.nextActionRef?.kind === "task") {
    const nextTask = need(await tx.getTask(command.nextActionRef.taskId), "next action Task");
    const nextRevision = need(await tx.getTaskRevision(command.nextActionRef.taskId,
      command.nextActionRef.taskRevisionId), "next action Task revision");
    if (nextTask.projectId !== command.projectId || nextRevision.projectId !== command.projectId ||
      nextRevision.taskId !== nextTask.id || nextRevision.id !== command.nextActionRef.taskRevisionId)
      throw new DomainError("NEXT_ACTION_TASK_MISMATCH", "Next action must reference a revision of this project's Task");
  }
  const conclusions = await tx.listEvaluationConclusions(command.evaluationId, command.revisionId);
  if (command.supersedesId) need(conclusions.find(item => item.id === command.supersedesId) ?? null, "superseded conclusion");
  if (!command.supersedesId && conclusions.length)
    throw new DomainError("CORRECTION_REQUIRED", "A later conclusion must supersede the previous conclusion");
  if (conclusions.some(item => item.id === command.conclusionId || item.supersedesId === command.supersedesId && command.supersedesId))
    throw new DomainError("ALREADY_EXISTS", "Conclusion or correction already exists");
  await tx.insertEvaluationConclusion({ projectId: command.projectId, id: command.conclusionId,
    evaluationId: command.evaluationId, revisionId: command.revisionId, assessmentIds: command.assessmentIds,
    supersedesId: command.supersedesId, finding: command.finding, limits: command.limits,
    comparability: command.comparability, comparabilityReason: command.comparabilityReason,
    nextChoice: command.nextChoice, affectedRefs: command.affectedRefs, nextActionRef: command.nextActionRef,
    actorId: principal.actorId, createdAt: now });
  return { result: { ...base, version: revision.version }, effects: [{ kind: "evaluation.conclusion", entityId: command.conclusionId, version: 1 }] };
}

export function nextAttemptOrdinal(attempts: EvaluationAttempt[], caseId: string, conditionId: string): number {
  return attempts.filter(item => item.caseId === caseId && item.conditionId === conditionId).length + 1;
}
