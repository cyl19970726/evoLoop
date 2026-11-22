// Words for the time and the source of a round (Task f2d82dfe). The send time is what a message shows; when processing began is
// marked beside it and never replaces it.
import { date } from "../../shared/ui/shared";
import type { Round } from "./timelineRounds";

/** Processing that began within this long of the send is not worth a second time on the line. */
const closeEnough = 60_000;

export interface SentStarted { sent: string | null; started: string | null }
/** The two times a message line may show: when it was sent, and when processing began if that is a different moment. */
export function sentAndStarted(round: Pick<Round, "sentAt" | "startedAt">): SentStarted {
  const { sentAt: sent, startedAt: started } = round;
  if (!started) return { sent, started: null };
  if (sent && Math.abs(Date.parse(started) - Date.parse(sent)) < closeEnough) return { sent, started: null };
  return { sent, started };
}

/** "发出 …" with "开始处理 …" after it; without a send time (no record read) only the processing start is said, labelled as such. */
export function sentStartedText({ sent, started }: SentStarted): string {
  if (sent && started) return `发出 ${date(sent)} · 开始处理 ${date(started)}`;
  if (sent) return `发出 ${date(sent)}`;
  if (started) return `开始处理 ${date(started)}`;
  return "";
}

/** The one-line label of a Run's round: who dispatched it and for which Task. */
export function runSourceLabel(by: "me" | "leader", title: string | null): string {
  return `${by === "me" ? "你派发" : "统筹派发"} · 任务「${title || "标题待核对"}」`;
}
