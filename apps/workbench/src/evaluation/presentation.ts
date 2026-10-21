import type { EvaluationAssessment, EvaluationAttempt, EvaluationCost, EvaluationFixedRef, EvaluationRevision } from "@evoloop/contracts";

export const evaluationHref = (projectId: string, evaluationId?: string, revisionId?: string) =>
  `#/p/${projectId}/evaluations${evaluationId ? `/${evaluationId}${revisionId ? `?revision=${encodeURIComponent(revisionId)}` : ""}` : ""}`;

/** Filtered listings may return a historical matching definition rather than today's head. */
export const evaluationListHref = (projectId: string, item: Pick<EvaluationRevision, "evaluationId" | "id">) =>
  evaluationHref(projectId, item.evaluationId, item.id);

export type NextActionRef = EvaluationFixedRef | { kind: "task"; taskId: string; taskRevisionId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseNextActionRef(value: string): NextActionRef | null {
  const input = value.trim();
  if (!input) return null;
  if (input.includes("\n") || input.includes("\r")) throw new Error("后续动作只能是一项固定引用。");
  const parts = input.split("|").map(part => part.trim());
  if (parts[0] === "task") {
    if (parts.length !== 3 || !uuid.test(parts[1] ?? "") || !uuid.test(parts[2] ?? ""))
      throw new Error("Task 后续动作应为 task | Task ID | Task 固定修订 ID，不需要内容哈希。");
    return { kind: "task", taskId: parts[1]!, taskRevisionId: parts[2]! };
  }
  const fixed = parseFixedRefLines(input, ["document", "git", "wiki", "delivery", "evidence"]);
  if (fixed.length !== 1) throw new Error("后续动作只能是一项固定引用。");
  return fixed[0]!;
}

export function nextActionHref(projectId: string, value: NextActionRef): string | null {
  return value.kind === "task" && uuid.test(value.taskId) && uuid.test(value.taskRevisionId)
    ? `#/p/${projectId}/tasks/${value.taskId}?revision=${encodeURIComponent(value.taskRevisionId)}` : null;
}

export function parseFixedRefLines(value: string, allowed: readonly EvaluationFixedRef["kind"][]): EvaluationFixedRef[] {
  const lines = value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  return lines.map(line => {
    const parts = line.split("|").map(item => item.trim());
    if (parts.length !== 4 || !allowed.includes(parts[0] as EvaluationFixedRef["kind"]) || !parts[1] || !parts[2] || !/^[a-f0-9]{64}$/.test(parts[3]!))
      throw new Error("固定引用每行应为 kind | ID | revision | 64位SHA-256");
    return { kind: parts[0] as EvaluationFixedRef["kind"], id: parts[1]!, revision: parts[2]!, contentHash: parts[3]! };
  });
}

export const formatFixedRefs = (refs: EvaluationFixedRef[]) => refs.map(ref => `${ref.kind} | ${ref.id} | ${ref.revision} | ${ref.contentHash}`).join("\n");

export function parseCostLines(value: string): EvaluationCost[] {
  const lines = value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  return lines.map(line => {
    const parts = line.split("|").map(item => item.trim());
    if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[3]) throw new Error("成本每行应为 阶段 | 单位 | 数值或未测 | 来源");
    const amount = parts[2] === "未测" ? null : Number(parts[2]);
    if (amount !== null && (!parts[2] || !Number.isFinite(amount) || amount < 0)) throw new Error("成本数值必须为非负有限数或未测；0 只表示确实测得零。");
    return { phase: parts[0]!, unit: parts[1]!, amount, source: parts[3]!, evidence: null };
  });
}

export const formatCosts = (costs: EvaluationCost[]) => costs.map(item => `${item.phase} | ${item.unit} | ${item.amount ?? "未测"} | ${item.source}`).join("\n");

/** Corrections append; only the last un-superseded assessment per attempt is current. */
export function currentAssessments(assessments: EvaluationAssessment[]): EvaluationAssessment[] {
  const superseded = new Set(assessments.map(item => item.supersedesId).filter((id): id is string => !!id));
  return assessments.filter(item => !superseded.has(item.id));
}

export function attemptsForCondition(revision: EvaluationRevision, attempts: EvaluationAttempt[], conditionId: string): EvaluationAttempt[] {
  return attempts.filter(item => item.evaluationId === revision.evaluationId && item.revisionId === revision.id
    && item.caseId === revision.definition.case.id && item.conditionId === conditionId)
    .sort((a, b) => a.ordinal - b.ordinal || a.createdAt.localeCompare(b.createdAt));
}

export function costText(cost: EvaluationCost): string {
  return `${cost.phase} · ${cost.amount === null ? "未测" : cost.amount} ${cost.unit} · 来源：${cost.source}`;
}

/** The first slice cannot prove full phase costs or tool-access isolation. */
export const conclusionComparabilityOptions = [
  { value: "with_limits", label: "有限比较（首片仍有成本阶段与工具隔离限制）" },
  { value: "unknown", label: "未知" },
] as const;

export const assessmentLabels = {
  sourceFidelity: { qualified: "符合固定来源", failed: "不符合固定来源", unknown: "未知", needs_review: "待复核" },
  knowledgeAdoption: { correct: "正确采用", misused: "误用", not_used: "未采用", not_observed: "未观察到", not_applicable: "不适用", needs_review: "待复核" },
  deliveryQuality: { qualified: "交付合格", failed: "交付失败", unknown: "未知", needs_review: "待复核" },
  humanEffect: { observed: "已观察到真人后果", unknown: "未知", needs_review: "待复核" },
} as const;
