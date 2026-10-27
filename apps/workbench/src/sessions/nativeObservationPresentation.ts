import type { NativeProgressView } from "./NativeSessionPanel";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const time = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const metric = (value: unknown): value is number | null => value === null ||
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const turnStates = new Set(["inProgress", "completed", "interrupted", "failed", "unknown"]);
const itemStates = new Set(["inProgress", "completed", "failed", "declined"]);
const itemKinds = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"]);
const planStates = new Set(["pending", "inProgress", "completed"]);
const statuses = new Set(["notLoaded", "idle", "systemError", "active"]);
const invalid = (reason: string) => ({ progress: null, error: `原生进度${reason}，请重新读取。` });

function usageBreakdown(value: unknown): value is NonNullable<NativeProgressView["usage"]>["total"] {
  return object(value) && ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]
    .every(key => metric(value[key]));
}

/** Only project/session-bound, bounded facts are admitted to the progress card. */
export function nativeObservationPresentation(value: unknown, projectId: string, sessionId: string):
  { progress: NativeProgressView | null; error: string | null } {
  if (value === undefined || value === null) return { progress: null, error: null };
  if (!object(value) || Object.hasOwn(value, "connectionId") ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 24576 ||
    value.projectId !== projectId || value.sessionId !== sessionId || !text(value.threadId) || !value.threadId ||
    value.version !== undefined && (!Number.isSafeInteger(value.version) || Number(value.version) < 1) ||
    !time(value.observedAt) || !time(value.lastEventAt) ||
    !["live", "stale"].includes(String(value.freshness)) || !nullableText(value.staleReason) ||
    value.status !== null && !statuses.has(String(value.status))) return invalid("身份或新鲜度无法核实");
  const turn = value.currentTurn;
  if (turn !== null && (!object(turn) || !text(turn.id) || !turn.id || !turnStates.has(String(turn.status)) ||
    turn.source !== null && (!object(turn.source) || !text(turn.source.operationId) || !text(turn.source.actorId) ||
      (turn.source.kind === "run" ? !text(turn.source.runId) || !text(turn.source.taskId) ||
        !text(turn.source.taskRevisionId) : turn.source.kind === "message" ?
          !text(turn.source.messageId) || !text(turn.source.processingId) : true))))
    return invalid("Turn 来源无法核实");
  if (!Array.isArray(value.items) || value.items.length > 10) return invalid("工具活动超出已读范围");
  const items: NativeProgressView["items"] = [];
  for (const item of value.items) {
    if (!object(item) || !text(item.id) || !itemKinds.has(String(item.kind)) || !text(item.name) ||
      !itemStates.has(String(item.status)) || !text(item.summary) || typeof item.truncated !== "boolean")
      return invalid("工具活动无法核实");
    items.push(item as unknown as NativeProgressView["items"][number]);
  }
  const plan = value.plan;
  if (plan !== null && (!object(plan) || !text(plan.turnId) || !Array.isArray(plan.steps) || plan.steps.length > 20 ||
    !nullableText(plan.explanation) || typeof plan.truncated !== "boolean" || !time(plan.observedAt) ||
    plan.steps.some(step => !object(step) || !text(step.step) || !planStates.has(String(step.status)))))
    return invalid("计划变化无法核实");
  const diff = value.diff;
  if (diff !== null && (!object(diff) || !text(diff.turnId) || !text(diff.text) ||
    new TextEncoder().encode(diff.text).byteLength > 8192 || typeof diff.truncated !== "boolean" || !time(diff.observedAt)))
    return invalid("变更预览无法核实");
  const usage = value.usage;
  if (usage !== null && (!object(usage) || !text(usage.turnId) || !usageBreakdown(usage.total) ||
    !usageBreakdown(usage.last) || !metric(usage.modelContextWindow) || !time(usage.observedAt)))
    return invalid("Token 用量无法核实");
  if (turn === null && (items.length || plan !== null || diff !== null || usage !== null) ||
    turn !== null && [plan, diff, usage].some(part => part !== null && part.turnId !== turn.id))
    return invalid("Turn 与事件范围不一致");
  const source = turn && object(turn.source) ? turn.source : null;
  return { progress: {
    projectId, sessionId, threadId: value.threadId, observedAt: value.observedAt,
    lastEventAt: value.lastEventAt, freshness: value.freshness as NativeProgressView["freshness"],
    staleReason: value.staleReason, status: value.status as NativeProgressView["status"],
    turn: turn === null ? null : { id: turn.id as string, status: turn.status as NonNullable<NativeProgressView["turn"]>["status"],
      source: source === null ? null : { kind: source.kind as "run" | "message",
        id: String(source.kind === "run" ? source.runId : source.messageId),
        taskId: source.kind === "run" && text(source.taskId) ? source.taskId : null } },
    items, plan: plan as NativeProgressView["plan"],
    diff: diff === null ? null : { turnId: diff.turnId as string, hasContent: !!(diff.text as string).trim(),
      truncated: diff.truncated as boolean, observedAt: diff.observedAt as string },
    usage: usage as NativeProgressView["usage"],
  }, error: null };
}
