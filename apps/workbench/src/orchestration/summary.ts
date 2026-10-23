import type { TaskDetail } from "@evoloop/contracts";
import type { OrchestrationDispatch, OrchestrationEvent, OrchestrationInbox, OrchestrationSourceFact, OrchestrationSubmission, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";
import type { TaskLoopContext } from "./client";

export function inTaskContext(dispatch: OrchestrationDispatch, context: TaskLoopContext): boolean {
  return context.dispatchIds.includes(dispatch.id) || context.parentDispatchIds.includes(dispatch.id);
}

/** Use recorded time for peers and explicit loaded cause edges for successors. */
export function orderDispatches(dispatches: OrchestrationDispatch[], sources: OrchestrationSourceFact[],
  submissions: OrchestrationSubmission[]) {
  const byId = new Map(dispatches.map(item => [item.id,item]));
  const bySource = new Map(sources.map(item => [item.id,item]));
  const byDelivery = new Map(submissions.filter(item => item.state === "sealed" && item.deliveryId)
    .map(item => [item.deliveryId!,item.dispatchId]));
  const parents = new Map(dispatches.map(item => {
    const source = bySource.get(item.sourceEventId);
    const candidates = [item.parentDispatchId,
      source?.kind === "worker.outcome" || source?.kind === "dispatch.gap" ? source.originDispatchId : null,
      source?.kind === "observation.record" && source.deliveryId ? byDelivery.get(source.deliveryId) : null];
    return [item.id,new Set(candidates.filter((id): id is string => !!id && id !== item.id && byId.has(id)))] as const;
  }));
  const hasLater = new Set([...parents.values()].flatMap(ids => [...ids]));
  const compare = (a: OrchestrationDispatch,b: OrchestrationDispatch) =>
    a.createdAtUtc.localeCompare(b.createdAtUtc) || a.id.localeCompare(b.id);
  const remaining = new Map(byId), ordered: OrchestrationDispatch[] = [];
  while (remaining.size) {
    const available = [...remaining.values()].filter(item => [...parents.get(item.id)!].every(id => !remaining.has(id))).sort(compare);
    if (!available.length) { ordered.push(...[...remaining.values()].sort(compare)); break; }
    const next = available[0]!;
    ordered.push(next); remaining.delete(next.id);
  }
  return {ordered,hasLater};
}

/** A terminal gap is an observed event, never inferred merely from an absent submission page. */
export function hasTerminalIntentGap(dispatchId: string, events: OrchestrationEvent[],
  submission: OrchestrationSubmission | undefined, decision: OrchestrationWorkerDecision | undefined): boolean {
  return !submission && !decision && events.some(value => value.kind === "dispatch.gap" && value.entityId === dispatchId);
}

export function readableOutcome(dispatch: OrchestrationDispatch, submission: OrchestrationSubmission | undefined,
  detail: TaskDetail | undefined): string {
  if (dispatch.state === "unknown") return "派发结果未知，需回查原运行；不能认定没有执行。";
  if (dispatch.outcome === "no_action") return "决定无后续动作；请核对决定理由。";
  if (dispatch.outcome === "waiting") return "决定等待；请核对等待条件和理由。";
  if (dispatch.outcome === "failed") return "本次处理失败；保留原因和下一步核对。";
  if (submission?.state === "unknown") return "交付封存结果未知；按原操作记录核对。";
  if (submission?.state === "sealed" && submission.deliveryId) {
    const delivery = detail?.deliveries?.find(item => item.id === submission.deliveryId);
    if (!delivery) return "已封存正式交付；交付详情尚未读回。";
    const observations = detail?.observations?.filter(item => item.deliveryId === delivery.id) ?? [];
    const humanUse = observations.some(item => item.observerKind === "human" && item.result === "used");
    return `已封存正式交付；技术检查${delivery.technicalResult === "passed" ? "通过" : "未通过"}。${humanUse ? "有人记录实际使用；仍需查看使用证据和任务验收。" : "尚无可确认的人类使用记录；不等于任务验收。"}`;
  }
  if (submission) return "Worker 已提交交付意图，等待正式封存。";
  if (dispatch.runtimeRunId) return "已绑定运行；尚无可确认的正式交付或决定。";
  return "等待派发或运行结果。";
}

export function nextAction(inbox: OrchestrationInbox | undefined, dispatch: OrchestrationDispatch | undefined,
  submission: OrchestrationSubmission | undefined): string {
  if (inbox?.state === "pending") return "接收职责核对入站来源并作出处理决定。";
  if (inbox?.state === "acknowledged" && !dispatch) return "接收职责已确认入站，等待登记处理或派发。";
  if (!dispatch) return "当前读取范围尚无后续派发；核对完整记录。";
  if (dispatch.state === "unknown") return "按原派发与 Run 记录核对未知结果。";
  if (submission?.state === "unknown") return "按原交付操作 ID 核对封存结果。";
  if (submission?.state === "submitted" || submission?.state === "sealing") return "等待交付封存，之后核对使用与任务验收。";
  if (submission?.state === "sealed") return "查看正式交付，再核对使用反馈与任务验收。";
  if (dispatch.outcome === "waiting") return "核对等待条件；有新事实后再判断。";
  if (dispatch.outcome === "failed") return "核对失败证据并决定是否重试。";
  if (dispatch.outcome === "no_action") return "核对无动作的理由与适用范围。";
  return "跟进运行与署名结果，不以运行结束代替交付。";
}

/** A card records its own past next step; a loaded successor does not make that old step current. */
export function storyNextAction(inbox: OrchestrationInbox | undefined, dispatch: OrchestrationDispatch,
  submission: OrchestrationSubmission | undefined, hasLoadedSuccessor: boolean): string {
  if (hasLoadedSuccessor) return "已有正式来源或父子派发接续；继续读后续记录，不把当时等待当作当前责任。";
  if (dispatch.outcome === "waiting") return "当时记录为等待；当前条件须核对完整来源与署名理由。";
  return nextAction(inbox,dispatch,submission);
}
