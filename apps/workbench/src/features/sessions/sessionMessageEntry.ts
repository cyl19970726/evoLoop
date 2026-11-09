import type { OrdinaryMessageExecutionCapability, SessionCapabilities } from "@evoloop/contracts/session-work";

const executionLabels: Record<OrdinaryMessageExecutionCapability["state"], string> = {
  disabled: "未启用", blocked: "受限", unverified: "执行前待核验", manual: "需人工转交", unknown: "暂不可核实",
};
const executionFallbacks: Record<OrdinaryMessageExecutionCapability["state"], string> = {
  disabled: "普通自动回复未启用；保存后当前不会启动此会话。",
  blocked: "自动处理当前受限；保存后不能预期自动回复。",
  unverified: "自动处理条件尚未完成执行前核验；保存后不能预期自动回复。",
  manual: "消息需人工转交；保存后不会自动回复。",
  unknown: "自动处理状态暂不可核实；保存后不能预期自动回复。",
};

/** The optional read keeps older Session snapshot APIs explicitly unverified. */
export function sessionMessageEntry(kind: "owned" | "external", capabilities: SessionCapabilities) {
  const execution = capabilities.ordinaryExecution;
  const knownState = !!execution && Object.hasOwn(executionLabels, execution.state);
  const state = knownState ? execution.state : "unknown";
  const budget=knownState ? execution.messageBudget : undefined;
  const budgetLabel=budget && Number.isSafeInteger(budget.used) && budget.used>=0 &&
    (budget.limit===null || Number.isSafeInteger(budget.limit)&&budget.limit>0)
    ? budget.limit===null ? `普通回复已用 ${budget.used} 次 · 不限累计次数`
      : `普通回复已用 ${budget.used} / ${budget.limit} 次 · 剩余 ${budget.remaining} 次`
    : null;
  return {
    canSave: capabilities.send.available,
    actionTitle: kind === "external" ? "保存人工转交" : "保存待处理",
    introduction: kind === "external"
      ? capabilities.send.available
        ? "外部会话需人工转交；保存消息不代表原会话已收到或阅读。"
        : "此处不能向当前外部会话保存或转交消息；请核对连接状态与权限。"
      : "消息先保存为这个智能体的待处理消息；实际处理时沿原对话线程、按它已核实的配置逐条进行。记录中的“待派发”不表示已送达、已读或已回复。",
    executionLabel: executionLabels[state],
    executionReason: knownState ? execution.reason?.trim() || executionFallbacks[state] : executionFallbacks.unknown,
    executionObservedAt: knownState ? execution.observedAt || null : null,
    budgetLabel,
    sendReason: capabilities.send.reason?.trim() || null,
  };
}
