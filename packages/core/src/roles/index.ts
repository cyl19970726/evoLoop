import type { Principal } from "@evoloop/contracts";
import { roleCommandSchema } from "@evoloop/contracts/roles";
import type { RoleCommand, RoleDecision, RoleHandoff, RoleHandoffEvent, RoleRecord, RoleRevision, RoleSessionBinding, RoleTransaction, RoleTrialReview } from "@evoloop/contracts/roles";

export class RoleRuleError extends Error {
  constructor(public readonly code: string, message: string, public readonly currentVersion?: number) { super(message); this.name = "RoleRuleError"; }
}
export interface RoleApplyContext { nowUtc: string; nextId(): string }
export interface RoleApplied { entityId: string; version: number; revisionId: string }
const fail = (code: string, message: string, version?: number): never => { throw new RoleRuleError(code, message, version); };
const date = (value: string) => Date.parse(value);

/** Execute inside the caller's journalled UnitOfWork transaction. No runtime call or Task owner mutation occurs here. */
export async function applyRole(tx: RoleTransaction, principal: Principal, input: RoleCommand, context: RoleApplyContext): Promise<RoleApplied> {
  const parsed = roleCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_COMMAND", parsed.error.message);
  const command = parsed.data;
  if (!principal.actorId || !principal.projectIds.includes(command.projectId) || !principal.permissions.includes("write")) return fail("FORBIDDEN", "project write permission required");
  if (command.type !== "role.propose" && !principal.permissions.includes("review")) return fail("FORBIDDEN", "role decision requires review permission");
  if (!Number.isFinite(date(context.nowUtc))) return fail("INVALID_TIME", "nowUtc must be a valid instant");

  if (command.type === "role.propose") {
    if (command.proposal.templateKey && !command.proposal.roleClass)
      return fail("INVALID_CLASS", "template association requires an explicit Role class");
    if (command.proposal.templateKey && command.proposal.roleClass &&
      (["lead","cognition","division"].includes(command.proposal.templateKey) ? "system" : "business") !== command.proposal.roleClass)
      return fail("INVALID_CLASS", "template class and Role class differ");
    if (date(command.proposal.reviewAtUtc) <= date(context.nowUtc) || date(command.proposal.reviewAtUtc) > date(context.nowUtc) + command.proposal.trialDays * 86_400_000) return fail("INVALID_TRIAL", "review date must fall inside the bounded trial");
    const first = await tx.getTask(command.proposal.firstTaskId);
    if (!first || first.state === "done" || first.state === "cancelled") return fail("INVALID_FIRST_TASK", "first trial task must exist and remain open");
    const revisionId = context.nextId();
    const record: RoleRecord = { projectId: command.projectId, id: command.roleId, version: 1, currentRevisionId: revisionId, state: "candidate", proposal: command.proposal, proposedBy: principal.actorId, createdAtUtc: context.nowUtc, trialStartedAtUtc: null, reviewAtUtc: command.proposal.reviewAtUtc, mergeTargetRoleId: null };
    await tx.createRole(record, makeRevision(record, principal.actorId, "evidence-backed proposal", context.nowUtc));
    return { entityId: record.id, version: record.version, revisionId };
  }

  const previous = await tx.getRole(command.roleId);
  if (!previous) return fail("NOT_FOUND", "role not found");
  if (previous.version !== command.expectedVersion) return fail("VERSION_CONFLICT", "role revision changed", previous.version);
  let state = previous.state, reviewAtUtc = previous.reviewAtUtc, mergeTargetRoleId = previous.mergeTargetRoleId, reason = "";
  if (command.type === "role.decide") {
    if (state !== "candidate" && state !== "deferred") return fail("INVALID_STATE", "only candidate or deferred proposals can be decided");
    if (command.decision === "accept-trial" && date(previous.reviewAtUtc) <= date(context.nowUtc)) return fail("INVALID_TRIAL", "trial review date must still be in the future at acceptance");
    state = command.decision === "accept-trial" ? "trial" : command.decision === "reject" ? "rejected" : "deferred";
    reason = command.reason;
  } else if (command.type === "role.review") {
    if (state !== "trial" && state !== "active") return fail("INVALID_STATE", "trial or active role required for review");
    if (command.decision === "continue-trial") {
      if (!command.nextReviewAtUtc || date(command.nextReviewAtUtc) <= date(context.nowUtc)) return fail("INVALID_REVIEW", "continuation requires a future review date");
      reviewAtUtc = command.nextReviewAtUtc;
    } else if (command.nextReviewAtUtc) return fail("INVALID_REVIEW", "next review date only applies to continuation");
    if (command.decision === "merge") {
      if (!command.mergeTargetRoleId || command.mergeTargetRoleId === command.roleId) return fail("INVALID_MERGE", "merge requires a distinct target role");
      const target = await tx.getRole(command.mergeTargetRoleId);
      if (!target || target.state !== "active") return fail("INVALID_MERGE", "merge target must be active in this project");
      mergeTargetRoleId = command.mergeTargetRoleId;
    } else if (command.mergeTargetRoleId) return fail("INVALID_MERGE", "merge target only applies to merge review");
    state = command.decision === "activate" ? "active" : command.decision === "continue-trial" ? "trial" : "retirement-pending";
    reason = command.reason;
  } else if (command.type === "role.handoff") {
    if (state !== "trial" && state !== "active" && state !== "retirement-pending") return fail("INVALID_STATE", "role is not in a handoff-capable state");
    if (command.targetRoleId === command.roleId) return fail("INVALID_HANDOFF", "handoff target must differ from source");
    const target = await tx.getRole(command.targetRoleId);
    if (!target || target.state !== "active") return fail("INVALID_HANDOFF", "target role must be active in this project");
    if (command.kind === "task") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(command.sourceRef)) return fail("INVALID_HANDOFF", "task handoff source must be a Task ID");
      const task = await tx.getTask(command.sourceRef);
      if (!task || task.owner !== command.roleId || !command.observedTaskVersion || task.version !== command.observedTaskVersion || task.state === "done" || task.state === "cancelled") return fail("TASK_BASELINE_CONFLICT", "task owner and observed version must match unfinished work");
    }
    reason = `prepared ${command.kind} handoff`;
  } else if (command.type === "role.ackHandoff") {
    const handoff = await tx.getHandoff(command.handoffId);
    if (!handoff || handoff.roleId !== command.roleId || handoff.state !== "prepared") return fail("INVALID_HANDOFF", "prepared handoff not found");
    if (handoff.kind === "task") {
      const task = await tx.getTask(handoff.sourceRef);
      if (!task || task.owner !== handoff.targetRoleId || task.version <= (handoff.observedTaskVersion ?? 0)) return fail("TASK_TRANSFER_UNCONFIRMED", "Task workflow must explicitly transfer owner at a newer revision before acknowledgement");
    }
    reason = "handoff acknowledged";
  } else if (command.type === "role.bindSession") {
    if (state !== "trial" && state !== "active") return fail("INVALID_STATE", "role must be trial or active to bind a session");
    const session = await tx.getRuntimeSession(command.sessionId);
    if (!session || session.roleId !== command.roleId || session.state !== "ready" || !session.nativeThreadId) return fail("SESSION_UNOWNED", "only a ready project-owned runtime session already reserved for this role may be bound");
    reason = "runtime session binding";
  } else if (command.type === "role.classify") {
    if (state === "retired" || state === "rejected") return fail("INVALID_STATE", "closed role cannot be classified");
    if (command.templateKey && (["lead","cognition","division"].includes(command.templateKey) ? "system" : "business") !== command.roleClass)
      return fail("INVALID_CLASS", "template class and Role class differ");
    if (previous.proposal.roleClass === command.roleClass &&
        (command.templateKey === undefined || (previous.proposal.templateKey ?? null) === command.templateKey))
      return fail("UNCHANGED", "role classification is already current");
    reason = command.reason;
  } else {
    if (state !== "retirement-pending") return fail("INVALID_STATE", "review must request retirement or merge first");
    const handoffs = await tx.listUnacknowledgedHandoffs(command.roleId);
    const tasks = await tx.listUnfinishedOwnedTasks(command.roleId);
    const sessions = await tx.listOpenRuntimeSessions(command.roleId);
    if (handoffs.length || tasks.length || sessions.length) return fail("RETIREMENT_BLOCKED", `retirement requires acknowledged handoffs and no unfinished owned tasks or open/unknown sessions (${handoffs.length}/${tasks.length}/${sessions.length})`);
    state = "retired";
    reason = `${command.reason}; knowledge: ${command.knowledgeDisposition}; runtime: ${command.runtimeDisposition}`;
  }
  const nextProposal = { ...previous.proposal };
  if (command.type === "role.classify") {
    nextProposal.roleClass = command.roleClass;
    if (command.templateKey === null) delete nextProposal.templateKey;
    else if (command.templateKey !== undefined) nextProposal.templateKey = command.templateKey;
  }
  const next: RoleRecord = { ...previous, version: previous.version + 1, currentRevisionId: context.nextId(), state, reviewAtUtc, mergeTargetRoleId,
    proposal: nextProposal,
    trialStartedAtUtc: command.type === "role.decide" && command.decision === "accept-trial" ? context.nowUtc : previous.trialStartedAtUtc };
  const revision = makeRevision(next, principal.actorId, reason, context.nowUtc);
  await tx.advanceRole(next, previous.version, revision);
  if (command.type === "role.decide") {
    const value: RoleDecision = { projectId: next.projectId, id: context.nextId(), roleId: next.id, revisionId: revision.id, decision: command.decision, actorId: principal.actorId, reason: command.reason, createdAtUtc: context.nowUtc };
    await tx.addDecision(value);
  } else if (command.type === "role.review") {
    const value: RoleTrialReview = { projectId: next.projectId, id: context.nextId(), roleId: next.id, revisionId: revision.id, decision: command.decision, effectEvidence: command.effectEvidence, effectEvidenceRefs: command.effectEvidenceRefs, costEvidence: command.costEvidence, costEvidenceRefs: command.costEvidenceRefs, baselineComparison: command.baselineComparison, actorId: principal.actorId, reason: command.reason, createdAtUtc: context.nowUtc };
    await tx.addReview(value);
  } else if (command.type === "role.handoff") {
    const handoff: RoleHandoff = { projectId: next.projectId, id: command.handoffId, roleId: next.id, kind: command.kind, sourceRef: command.sourceRef, targetRoleId: command.targetRoleId, observedTaskVersion: command.observedTaskVersion ?? null, state: "prepared", preparedAtUtc: context.nowUtc, acknowledgedAtUtc: null };
    const event: RoleHandoffEvent = { projectId: next.projectId, id: context.nextId(), handoffId: handoff.id, roleId: next.id, state: "prepared", actorId: principal.actorId, note: command.note, createdAtUtc: context.nowUtc };
    await tx.addHandoff(handoff, event);
  } else if (command.type === "role.ackHandoff") {
    const handoff = (await tx.getHandoff(command.handoffId))!;
    const acknowledged: RoleHandoff = { ...handoff, state: "acknowledged", acknowledgedAtUtc: context.nowUtc };
    const event: RoleHandoffEvent = { projectId: next.projectId, id: context.nextId(), handoffId: handoff.id, roleId: next.id, state: "acknowledged", actorId: principal.actorId, note: command.note, createdAtUtc: context.nowUtc };
    await tx.acknowledgeHandoff(acknowledged, event);
  } else if (command.type === "role.bindSession") {
    const value: RoleSessionBinding = { projectId: next.projectId, id: context.nextId(), roleId: next.id, sessionId: command.sessionId, roleRevisionId: revision.id, actorId: principal.actorId, note: command.note, createdAtUtc: context.nowUtc };
    await tx.addSessionBinding(value);
  }
  return { entityId: next.id, version: next.version, revisionId: revision.id };
}

function makeRevision(record: RoleRecord, actorId: string, reason: string, createdAtUtc: string): RoleRevision {
  return { projectId: record.projectId, roleId: record.id, id: record.currentRevisionId, version: record.version, state: record.state, proposal: record.proposal, actorId, reason, createdAtUtc, reviewAtUtc: record.reviewAtUtc, mergeTargetRoleId: record.mergeTargetRoleId };
}
