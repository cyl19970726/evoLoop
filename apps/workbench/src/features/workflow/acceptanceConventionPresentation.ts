const target: Record<string, string> = {
  human: "指定的人", leader: "项目 Leader", business_session: "Leader 指派的独立业务 Session",
  named_agent: "声明的业务身份直接验收（不经验收接力）",
};
const form: Record<string, string> = { research: "研究结论", document: "文档", code: "代码", config: "配置", operation: "运维操作" };
const precondition: Record<string, string> = {
  none: "无，交付即可验收", refresh: "刷新后才可验收", release: "发布后才可验收", migration: "迁移后才可验收", config_restart: "改配置并重启后才可验收",
};

export interface ConventionFact { label: string; value: string }

/** The declared acceptance convention as labelled facts; fields the Task did not declare are left out, never shown as a default. */
export function acceptanceConventionFacts(proposal: { acceptanceTarget?: string | null; deliveryForm?: string | null; acceptancePrecondition?: string | null } | null | undefined): ConventionFact[] {
  if (!proposal) return [];
  return [
    proposal.acceptanceTarget ? { label: "验收者", value: target[proposal.acceptanceTarget] ?? proposal.acceptanceTarget } : null,
    proposal.deliveryForm ? { label: "交付形态", value: form[proposal.deliveryForm] ?? proposal.deliveryForm } : null,
    proposal.acceptancePrecondition ? { label: "验收前置", value: precondition[proposal.acceptancePrecondition] ?? proposal.acceptancePrecondition } : null,
  ].filter((fact): fact is ConventionFact => fact !== null);
}
