import { DomainError } from "@evoloop/contracts/ports";

/** What the database says about the arranged message when an Agent recipient links an observation. */
export interface ObservationLinkFacts {
  state: string;
  nativeTurnId: string | null;
  sessionId: string;
  /** Set only when the recipient's own read receipt exists. */
  readReceiptActorId: string | null;
  /** The observation was recorded at or after that read receipt. */
  afterRead: boolean;
}

/**
 * Rule: an observation counts as use of the arranged message when its recipient recorded it after reading the message,
 * whether during the arranged turn or after it; the link is made once the processing has completed. Recording it
 * during the turn is the natural moment (the recipient has just used the Delivery), so completion of the processing is
 * required when linking, not when observing. Each failure names the one missing condition.
 */
export function observationLinkProblem(facts: ObservationLinkFacts | undefined, arrangedSessionId: string): DomainError | null {
  const refuse = (message: string) => new DomainError("ACCEPTANCE_NOT_USED", message);
  if (!facts) return refuse("收件消息还没有处理记录；等它被收件 Session 处理后再关联观察。");
  if (facts.sessionId !== arrangedSessionId) return refuse("这条消息不是由被安排的 Session 处理的，不能用来关联此安排。");
  if (facts.state !== "completed")
    return refuse(`收件消息的处理尚未完成（当前 ${facts.state}）。观察可以在处理期间记录，待本轮处理完成后再关联。`);
  if (!facts.nativeTurnId) return refuse("收件消息的处理没有保存对应的原生 Turn，不能证明本人使用。");
  if (!facts.readReceiptActorId) return refuse("收件人还没有用 session.message.receipt 记录已读；先记已读，再留 observation 并关联。");
  if (!facts.afterRead) return refuse("这条 observation 早于本人的已读回执；请在记录已读之后再留 observation。");
  return null;
}
