// Words for the time and the source of a round (Task f2d82dfe). The send time is what a message shows; when processing began is
// marked beside it and never replaces it.
import { date } from "../../shared/ui/shared";
import type { RunDispatch } from "@evoloop/contracts/session-timeline";
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

/**
 * How a round got into the Session's line, in words (Task c58b83e2). The reader's own identity is "你派发"; the line's controller
 * is "Leader 派发"; any other identity that queued it (the requirements Session while the Leader is stopped) is named, "代派";
 * a schedule is named by its title; a return after a failed acceptance is "验收退回后返工". Nothing read: "来源待核对" — never a guess.
 */
export function dispatchLabel(dispatch: RunDispatch | null | undefined, me: string | null): string {
  if (!dispatch) return "来源待核对";
  if (dispatch.source === "schedule") return `日程触发 · ${dispatch.scheduleTitle?.trim() || "日程名待核对"}`;
  if (dispatch.source === "rework") return "验收退回后返工";
  if (me !== null && dispatch.actorId === me) return "你派发";
  return dispatch.viaController ? "Leader 派发" : `${dispatch.actorId} 代派`;
}

/** The one-line label of a Run's round: how it was dispatched and for which Task. */
export function runSourceLabel(label: string, title: string | null): string {
  return `${label} · 任务「${title || "标题待核对"}」`;
}

/**
 * Where a rework round's "查看退回意见" goes: the task's 交付 tab, at the return opinion the round records (`observation`), with the
 * delivery it belongs to as the fallback when the opinion is not on the page. A round that names neither goes to the tab alone.
 */
export function reworkHref(taskHref: string, dispatch: RunDispatch): string {
  const [path, query = ""] = taskHref.split("?");
  const params = new URLSearchParams(query);
  params.set("tab", "delivery");
  if (dispatch.reworkDeliveryId) params.set("delivery", dispatch.reworkDeliveryId);
  if (dispatch.reworkObservationId) params.set("observation", dispatch.reworkObservationId);
  return `${path}?${params.toString()}`;
}
