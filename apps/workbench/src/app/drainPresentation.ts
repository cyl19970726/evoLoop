// Drain mode on every page: while an instance is being drained for a release, say so, what is still in flight and when
// it is safe to stop. Pure text, so the wording is tested without a browser.
import type { InstanceDrainView } from "@evoloop/contracts/instance-drain";

export interface DrainNotice { key: "drain"; tone: "waiting" | "info"; text: string; detail?: string }

/** The notice for a project page, or null when the instance is not being drained. */
export function drainNotice(view: Pick<InstanceDrainView, "state" | "actorId" | "reason" | "changedAt" | "inFlight" | "queued"> | null | undefined, when: (iso: string) => string = iso => iso): DrainNotice | null {
  // Anything that is not a drain state (an older service answers this path with an empty page) says nothing.
  if (!view || (view.state !== "draining" && view.state !== "drained")) return null;
  const who = `${view.actorId ?? "维护者"} 于 ${when(view.changedAt)} 开启${view.reason ? `：${view.reason}` : ""}`;
  const queued = view.queued.messages + view.queued.runs;
  if (view.state === "drained")
    return { key: "drain", tone: "info", text: `实例已排空，可以停服：没有在途的 Run 和消息 Turn。排队中的 ${view.queued.messages} 条消息和 ${view.queued.runs} 个 Run 在解除排空后按原顺序继续。`, detail: who };
  const { runs, messageTurns, total } = view.inFlight.counts;
  return { key: "drain", tone: "waiting", text: `实例排空中：不再启动新的 Run 和消息 Turn（新消息照常保存并排队${queued ? `，已排队 ${view.queued.messages} 条消息、${view.queued.runs} 个 Run` : ""}）。还有 ${total} 项在途（${runs} 个 Run、${messageTurns} 个消息 Turn），全部完成后显示“已排空”。`, detail: who };
}
