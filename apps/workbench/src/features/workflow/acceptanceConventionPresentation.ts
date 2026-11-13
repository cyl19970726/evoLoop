import { preconditionText } from "@evoloop/contracts/acceptance-convention";

const target: Record<string, string> = {
  human: "指定的人", leader: "项目 Leader", business_session: "Leader 指派的独立业务 Session",
  named_agent: "声明的业务身份直接验收（不经验收接力）",
};
const precondition: Record<string, string> = {
  none: "无，交付即可验收", refresh: "刷新后才可验收", release: "发布后才可验收", migration: "迁移后才可验收", config_restart: "改配置并重启后才可验收",
};

export interface ConventionFact { label: string; value: string }

/** The declared acceptance convention as labelled facts; fields the Task did not declare are left out, never shown as a default. */
export function acceptanceConventionFacts(proposal: { acceptanceTarget?: string | null; acceptancePrecondition?: string | null } | null | undefined): ConventionFact[] {
  if (!proposal) return [];
  return [
    proposal.acceptanceTarget ? { label: "验收者", value: target[proposal.acceptanceTarget] ?? proposal.acceptanceTarget } : null,
    proposal.acceptancePrecondition ? { label: "验收前置", value: precondition[proposal.acceptancePrecondition] ?? proposal.acceptancePrecondition } : null,
  ].filter((fact): fact is ConventionFact => fact !== null);
}

export interface PreconditionStatus {
  /** True while the declared precondition is not marked met for the current delivery: nothing may be accepted yet. */
  waiting: boolean;
  /** "前置：未满足（…）" or "前置：已满足（谁，何时）". */
  text: string;
  /** The evidence the mark was made on; null until marked. */
  evidence: string | null;
}

/**
 * Whether the current delivery's acceptance precondition is met, from the work index's convention block. Null when there is nothing to
 * say: no convention, no precondition (or `none`), or no delivery yet.
 */
export function preconditionStatus(convention: {
  acceptancePrecondition?: string | null; readiness?: string | null; preconditionMark?: { actorId: string; evidence: string; markedAt: string } | null;
} | null | undefined, formatDate: (value: string) => string, actorName: (actorId: string) => string = id => id): PreconditionStatus | null {
  const kind = convention?.acceptancePrecondition;
  if (!convention || !kind || kind === "none" || !convention.readiness) return null;
  const mark = convention.preconditionMark ?? null;
  if (convention.readiness === "waiting_precondition" && !mark)
    return { waiting: true, text: `前置：未满足（等待${preconditionText[kind as keyof typeof preconditionText] ?? kind}，尚未标记已满足）`, evidence: null };
  return { waiting: false, text: mark ? `前置：已满足（${actorName(mark.actorId)}，${formatDate(mark.markedAt)}）` : "前置：已满足", evidence: mark?.evidence ?? null };
}
