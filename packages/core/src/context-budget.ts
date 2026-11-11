import type { ContextBudgetConfig, ContextHandoffSummaryInput, ContextObservation, ContextPressure } from "@evoloop/contracts";

const validTokens = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Compare a Session's newest reported context with its configured ceiling. A missing observation stays
 * unknown instead of becoming zero; an exhausted context asks for a handoff, never native content.
 */
export function contextPressure(config: ContextBudgetConfig | null | undefined,
  observation: ContextObservation | null): ContextPressure {
  const warningRatio = config?.warningRatio ?? 0.8;
  const pauseOrdinaryTurns = config?.pauseOrdinaryTurns ?? true;
  if (!config?.enabled) return { configured: false, state: "unconfigured", inputTokens: observation?.inputTokens ?? null,
    limit: null, ratio: null, warningRatio, pauseOrdinaryTurns, observedAt: observation?.observedAt ?? null,
    reason: "未配置上下文交接阈值；长会话会继续把完整历史带入每一轮。" };
  const limit = validTokens(config.maxInputTokens) && config.maxInputTokens > 0 ? config.maxInputTokens : null;
  if (limit === null) return { configured: true, state: "unknown", inputTokens: observation?.inputTokens ?? null,
    limit: null, ratio: null, warningRatio, pauseOrdinaryTurns, observedAt: observation?.observedAt ?? null,
    reason: "上下文交接阈值不是可靠的 token 数。" };
  const used = observation?.inputTokens ?? null;
  if (!validTokens(used)) return { configured: true, state: "unknown", inputTokens: null, limit, ratio: null,
    warningRatio, pauseOrdinaryTurns, observedAt: observation?.observedAt ?? null,
    reason: "原生运行时没有报告当前上下文用量；不按 0 判断，也不据此暂停。" };
  const ratio = used / limit;
  const state = ratio >= 1 ? "handoff_required" : ratio >= warningRatio ? "warning" : "ok";
  return { configured: true, state, inputTokens: used, limit, ratio, warningRatio, pauseOrdinaryTurns,
    observedAt: observation?.observedAt ?? null,
    reason: state === "handoff_required"
      ? `上下文已到 ${used} 个词元（上限 ${limit}）；普通结果通知暂停，业务 Task Run 不受影响。请把责任交接到新线程并保留下面的摘要。`
      : state === "warning"
        ? `上下文已到上限的 ${Math.round(ratio * 100)}%，请准备交接新线程。`
        : null };
}

/** A bounded, human-readable handoff note; it cites fixed identifiers, not native conversation text. */
export function contextHandoffSummary(input: ContextHandoffSummaryInput): string {
  const pressure = input.pressure;
  const usage = pressure.inputTokens === null || pressure.limit === null
    ? "上下文用量未报告"
    : `交接时上下文 ${pressure.inputTokens} / ${pressure.limit} 个词元（${Math.round((pressure.ratio ?? 0) * 100)}%）`;
  return [
    "上下文交接摘要（由 evoLoop 在阈值处生成，不包含原生对话正文）",
    `原 Session：${input.sessionId}`,
    `职责：${input.roleId}`,
    `原生线程：${input.nativeThreadId ?? "未绑定"}`,
    `生成于：${input.generatedAt}`,
    usage,
    `新线程的第一责任：${input.nextResponsibility}`,
    "原线程的固定 Task、交付、验收与工作变化记录仍然是权威来源；未处理的结果通知仍保留在队列中，不会因交接而视为已读、已接受或已交付。",
  ].join("\n");
}
