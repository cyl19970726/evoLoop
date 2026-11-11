import { DomainError } from "@evoloop/contracts/ports";
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
