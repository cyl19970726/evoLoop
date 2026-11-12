import { DomainError } from "@evoloop/contracts/ports";
import { selectMaterialCli, type MaterialCliBinding } from "../configuration.js";
import { PreflightError } from "./preflight-report.js";

/** Independent acceptance needs a fixed signer before a native Turn consumes work. */
export function requireOrdinaryRecipient(
  acceptanceMode: string | null | undefined, recipient: string | null,
  cliActorId: string | null, taskId: string, taskRevisionId: string,
): void {
  if (acceptanceMode && (!recipient || cliActorId !== recipient))
    throw new PreflightError("RECIPIENT_UNBOUND", { kind: "task", id: taskId, revisionId: taskRevisionId });
}

/** A direct Run may fix its signer through the owned Session assignment. */
export function materialCliRecipientMatches(
  channelRecipients: string[], cliActorId: string,
  sessionActorId: string, fixedRecipient: string | null,
): boolean {
  if (channelRecipients.length > 1) return false;
  if (channelRecipients.length === 1) return channelRecipients[0] === cliActorId;
  return cliActorId === sessionActorId || fixedRecipient === cliActorId;
}

/** The facts runtime.run.reserve needs, read before any Run exists. */
export interface ReserveRecipientFacts {
  acceptanceMode: string | null | undefined;
  taskRevisionId: string;
  assignment: { state: string; taskRevisionId: string; recipientActorId: string | null } | null;
  /** Business CLI identity configured for this Session; null when it is not known before the Run starts. */
  cliActorId: string | null;
}

/**
 * Refuse a reservation that the preflight would only fail later, so no failed Run and no blocked
 * Session gate is left behind. Each message names the one missing item and the order that fixes it.
 */
export function requireReservableRecipient(facts: ReserveRecipientFacts): void {
  if (!facts.acceptanceMode) return;
  const order = "顺序：task.start → task.assignment.set（接收者写 Session 实际使用的业务 CLI 身份）→ 接手确认 → runtime.run.reserve。";
  const { assignment } = facts;
  if (!assignment || assignment.state === "released")
    throw new DomainError("ASSIGNMENT_MISSING", `该 Task 要求独立验收，但当前没有有效的具体分派；未创建 Run。${order}`);
  if (assignment.taskRevisionId !== facts.taskRevisionId)
    throw new DomainError("ASSIGNMENT_STALE", `分派仍指向旧的 Task 修订（task.start 会使既有分派过期）；未创建 Run。请重新 task.assignment.set。${order}`);
  if (!assignment.recipientActorId)
    throw new DomainError("RECIPIENT_UNBOUND", `分派没有固定执行接收者；未创建 Run。${order}`);
  if (facts.cliActorId && facts.cliActorId !== assignment.recipientActorId)
    throw new DomainError("RECIPIENT_UNBOUND",
      `分派接收者 ${assignment.recipientActorId} 不是该 Session 实际签署交付的业务 CLI 身份 ${facts.cliActorId}（不要写成 Session 创建者身份）；未创建 Run。${order}`);
}

/** What the reserve guard needs from outside: a read of the project data and the Session's configured business CLI identity. */
export interface RunRecipientGuardDeps {
  read<T>(projectId: string, fn: (reader: {
    getTask(taskId: string): Promise<{ id: string; currentRevisionId: string } | null>;
    getTaskProposal(taskId: string, revisionId?: string): Promise<{ acceptanceMode?: string | null } | null>;
    sessionAssignments?: { getTaskSessionAssignment(taskId: string): Promise<{ state: string; taskRevisionId: string; recipientActorId: string | null } | null> };
  }) => Promise<T>): Promise<T>;
  /** The business CLI identity configured for this Session and Task, or null when none is known before the Run starts (a brokered Session). */
  cliActorId(command: { projectId: string; taskId: string }, session: { id: string; actorId: string; roleId: string }): Promise<string | null>;
}

/**
 * The check the coordinator runs on runtime.run.reserve after authorization and before the command is executed: it reads the Task's
 * current revision, its acceptance mode and its assignment, and the Session's configured CLI identity, then applies
 * {@link requireReservableRecipient}. A missing Task is left to the command itself to refuse.
 */
export function createRunRecipientGuard(deps: RunRecipientGuardDeps) {
  return async (command: { projectId: string; taskId: string }, session: { id: string; actorId: string; roleId: string }): Promise<void> => {
    const facts = await deps.read(command.projectId, async reader => {
      const task = await reader.getTask(command.taskId);
      if (!task) return null;
      const proposal = await reader.getTaskProposal(task.id, task.currentRevisionId);
      const assignment = await reader.sessionAssignments?.getTaskSessionAssignment(task.id) ?? null;
      return { acceptanceMode: proposal?.acceptanceMode, taskRevisionId: task.currentRevisionId, assignment: assignment
        ? { state: assignment.state, taskRevisionId: assignment.taskRevisionId, recipientActorId: assignment.recipientActorId } : null };
    });
    if (!facts) return;
    requireReservableRecipient({ ...facts, cliActorId: await deps.cliActorId(command, session) });
  };
}

/**
 * The Session's configured business CLI identity, from the private configuration read at call time. Null when the runtime is off or no
 * material-CLI entry matches (a brokered Session gets its identity when its Run starts), so nothing is compared before then.
 */
export function configuredCliActorId(load: () => Promise<{ runtime?: { enabled: boolean; materialCli: MaterialCliBinding[] } | null | undefined }>):
  RunRecipientGuardDeps["cliActorId"] {
  return async (command, session) => {
    const current = await load();
    return (current.runtime?.enabled ? selectMaterialCli(current.runtime.materialCli, command.projectId, session.id, session.actorId, command.taskId, session.roleId) : null)?.cliActorId ?? null;
  };
}

/**
 * The `requireRunRecipient` callback the coordinator passes to buildServer, assembled from the two real dependencies main.ts owns: the
 * PostgreSQL unit of work and the private-configuration loader. main.ts calls this and nothing else, so the real-entry test runs the same code.
 */
export function createReserveRecipientCheck(deps: {
  uow: { read<T>(projectId: string, fn: (reader: any) => Promise<T>): Promise<T> };
  loadIntegrations: Parameters<typeof configuredCliActorId>[0];
}) {
  const guard = createRunRecipientGuard({ read: (projectId, fn) => deps.uow.read(projectId, reader => fn(reader as never)),
    cliActorId: configuredCliActorId(deps.loadIntegrations) });
  return async (_principal: unknown, command: { projectId: string; taskId: string }, session: { id: string; actorId: string; roleId: string }): Promise<void> => guard(command, session);
}
