import type { ConsumerObservation, Delivery, Document, DocumentRevision, EvaluationAssessment, EvaluationAttempt, EvaluationCondition, EvaluationConclusion, EvaluationCost, EvaluationFixedRef, EvaluationRevision, RuntimeRunRecord, RuntimeRunState, TaskState } from "@evoloop/contracts";
import type { StatusTone } from "@evoloop/ui";

export const evaluationHref = (projectId: string, evaluationId?: string, revisionId?: string) =>
  `/p/${projectId}/evaluations${evaluationId ? `/${evaluationId}${revisionId ? `?revision=${encodeURIComponent(revisionId)}` : ""}` : ""}`;

/** Filtered listings may return a historical matching definition rather than today's head. */
export const evaluationListHref = (projectId: string, item: Pick<EvaluationRevision, "evaluationId" | "id">) =>
  evaluationHref(projectId, item.evaluationId, item.id);

const routeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function fixedRefHref(projectId: string, value: EvaluationFixedRef): string | null {
  if (!routeUuid.test(value.id) || !routeUuid.test(value.revision)) return null;
  if (value.kind === "document") return `/p/${encodeURIComponent(projectId)}/documents/${value.id}?revision=${value.revision}`;
  if (value.kind === "wiki") return `/p/${encodeURIComponent(projectId)}/knowledge?knowledgeId=${value.id}&knowledgeRevision=${value.revision}`;
  return null;
}

/** The present document name is a reading aid only after the exact cited revision and hash are authorized and read. */
export function verifiedFixedDocumentTitle(ref: EvaluationFixedRef, projectId: string, document: Document, revision: DocumentRevision): string | null {
  if (ref.kind !== "document" || document.projectId !== projectId || revision.projectId !== projectId
    || document.id !== ref.id || revision.documentId !== ref.id || revision.id !== ref.revision
    || revision.contentHash.toLowerCase() !== ref.contentHash.toLowerCase()) return null;
  return document.title.trim() || null;
}

export type NextActionRef = EvaluationFixedRef | { kind: "task"; taskId: string; taskRevisionId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseNextActionRef(value: string): NextActionRef | null {
  const input = value.trim();
  if (!input) return null;
  if (input.includes("\n") || input.includes("\r")) throw new Error("后续动作只能是一项固定引用。");
  const parts = input.split("|").map(part => part.trim());
  if (parts[0] === "task") {
    if (parts.length !== 3 || !uuid.test(parts[1] ?? "") || !uuid.test(parts[2] ?? ""))
      throw new Error("任务后续动作应为 task | 任务标识 | 任务固定修订，不需要内容哈希。");
    return { kind: "task", taskId: parts[1]!, taskRevisionId: parts[2]! };
  }
  const fixed = parseFixedRefLines(input, ["document", "git", "wiki", "delivery", "evidence"]);
  if (fixed.length !== 1) throw new Error("后续动作只能是一项固定引用。");
  return fixed[0]!;
}

export function nextActionHref(projectId: string, value: NextActionRef): string | null {
  return value.kind === "task" && uuid.test(value.taskId) && uuid.test(value.taskRevisionId)
    ? `/p/${projectId}/tasks/${value.taskId}?revision=${encodeURIComponent(value.taskRevisionId)}` : null;
}

export function parseFixedRefLines(value: string, allowed: readonly EvaluationFixedRef["kind"][]): EvaluationFixedRef[] {
  const lines = value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  return lines.map(line => {
    const parts = line.split("|").map(item => item.trim());
    if (parts.length !== 4 || !allowed.includes(parts[0] as EvaluationFixedRef["kind"]) || !parts[1] || !parts[2] || !/^[a-f0-9]{64}$/.test(parts[3]!))
      throw new Error(`固定引用每行应为 类型 | 标识 | 修订 | 64 位 SHA-256；类型可写 ${allowed.join("、")}`);
    return { kind: parts[0] as EvaluationFixedRef["kind"], id: parts[1]!, revision: parts[2]!, contentHash: parts[3]! };
  });
}

/** Form hints for the fixed-reference lines; the typed format itself is unchanged. */
export const fixedRefLineHint = "每行：类型 | 标识 | 修订 | SHA-256；类型写 document、git、wiki、delivery 或 evidence";
export const nextActionLineHint = "任务：task | 任务标识 | 任务固定修订（无需哈希）；其他：类型 | 标识 | 修订 | SHA-256。留空不表示动作已发生。";

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

/** A delivery registration creates a new Task revision; only its explicit Run ID attributes it to an attempt. */
export function deliveriesForAttempt(attempt: EvaluationAttempt, taskId: string, deliveries: Delivery[]): Delivery[] {
  return deliveries.filter(item => item.runId === attempt.runId && item.taskId === taskId && item.projectId === attempt.projectId);
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

// ---- 界面用语：评价页里出现的枚举一律经这里译成中文；未识别的值写明未识别，不把英文原样露出。 ----

export function labelOf<K extends string>(labels: Record<K, string>, value: string | null | undefined, unknown = "未识别的状态"): string {
  return value && Object.prototype.hasOwnProperty.call(labels, value) ? labels[value as K] : unknown;
}

export const runStateLabels: Record<RuntimeRunState, string> = {
  requested: "待派发", dispatching: "派发中", running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断", unknown: "结果未知",
};
/** Tones follow docs/frontend/foundations.md: in flight is progress, ended is neutral, failed is blocked, unknown stays unknown. */
export const runStateTones: Record<RuntimeRunState, StatusTone> = {
  requested: "waiting", dispatching: "progress", running: "progress", completed: "done", failed: "blocked", interrupted: "blocked", unknown: "unknown",
};
export const nextChoiceLabels: Record<EvaluationConclusion["nextChoice"], string> = {
  read_direct: "先读直接来源", adopt_with_limits: "带限制采用", maintain: "维持当前做法", research: "继续研究", wait: "等待证据", stop: "停止",
};
export const comparabilityLabels: Record<EvaluationConclusion["comparability"], string> = {
  comparable: "历史记录声称可比较", with_limits: "有限比较", unknown: "未知",
};
export const conditionLabels: Record<EvaluationCondition["kind"], string> = { direct: "直接材料", wiki: "加入固定 Wiki" };
export const sandboxLabels: Record<EvaluationCondition["environment"]["sandbox"], string> = {
  "read-only": "只读", "workspace-write": "只写工作目录", "danger-full-access": "完整本机权限",
};
export const approvalLabels: Record<EvaluationCondition["environment"]["approvalPolicy"], string> = {
  "on-request": "按需请求审批", untrusted: "不受信命令需审批", never: "无需逐次审批",
};
export const fixedRefKindLabels: Record<EvaluationFixedRef["kind"], string> = { document: "文档", git: "Git 来源", wiki: "Wiki 页", delivery: "交付", evidence: "证据" };
export const technicalResultLabels: Record<Delivery["technicalResult"], string> = { passed: "技术检查通过", failed: "技术检查未通过" };
export const observationResultLabels: Record<ConsumerObservation["result"], string> = { used: "已使用", failed: "用后失败", notUsed: "未使用" };
export const actorKindLabels: Record<EvaluationAssessment["assessorKind"], string> = { human: "真人", agent: "智能体" };
export const taskStateLabels: Record<TaskState, string> = { todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" };

const anyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A fixed reference by name: a verified document title, a Git source's own name, otherwise its kind; IDs stay in 完整标识. */
export function fixedRefName(ref: Pick<EvaluationFixedRef, "kind" | "id">, verifiedTitle?: string | null): string {
  if (verifiedTitle) return `《${verifiedTitle}》`;
  if (ref.kind === "git" && !anyUuid.test(ref.id)) return `Git 来源 ${ref.id}`;
  return `${labelOf(fixedRefKindLabels, ref.kind, "固定来源")}（名称未核实）`;
}

/** A verified title belongs to one exact revision and hash; the same key finds it wherever that reference reappears. */
export const fixedTitleKey = (ref: Pick<EvaluationFixedRef, "id" | "revision" | "contentHash">) => `${ref.id}:${ref.revision}:${ref.contentHash.toLowerCase()}`;

/** Full identity of a fixed reference, for the 完整标识 layer only. */
export const fixedRefIdentity = (ref: EvaluationFixedRef) =>
  `${labelOf(fixedRefKindLabels, ref.kind, "固定来源")} ${ref.id} · 修订 ${ref.revision} · SHA-256 ${ref.contentHash}`;

/** The list names the common task by the title frozen in the definition's source signature, never by its ID. */
export function frozenTaskTitle(item: Pick<EvaluationRevision, "definition">): string {
  return item.definition.case.sourceSignature?.title?.trim() || "名称未登记的共同任务";
}

export function evaluationRowMeta(item: Pick<EvaluationRevision, "definition" | "version" | "createdAt">, when: (value: string) => string): string {
  return `匹配定义 v${item.version} · 共同任务《${frozenTaskTitle(item)}》 · ${when(item.createdAt)}`;
}

export type ReadState = "loading" | "failed" | "read";

/**
 * The latest read decides. A reread that failed is "failed" and one still running is "loading", even while the last
 * answer stays on screen: absence ("not found", "no delivery") may only be said of a read that finished and succeeded.
 */
export function readStateOf(query: { data: unknown; isError: boolean; isFetching: boolean }): ReadState {
  return query.isError ? "failed" : query.isFetching || query.data === undefined ? "loading" : "read";
}

/** Names the reads that failed, so a message says which records are missing rather than a fixed guess. */
export function unreadSources(failed: { task?: boolean; runs?: boolean; agents?: boolean }): string {
  return [failed.task && "共同任务", failed.runs && "运行记录", failed.agents && "智能体列表"].filter(Boolean).join("、");
}

/** A run still being read, or one whose read failed, is said to be so; "not found" needs a completed read. */
export function attemptRunText(run: Pick<RuntimeRunRecord, "state"> | undefined, runs: ReadState): string {
  if (run) return labelOf(runStateLabels, run.state);
  if (runs === "loading") return "正在读取运行记录";
  if (runs === "failed") return "运行状态无法判断";
  return "运行记录未读到";
}

export function conditionGlance(revision: EvaluationRevision, attempts: EvaluationAttempt[], assessments: Pick<EvaluationAssessment, "attemptId">[],
  conditionId: string, runs: Pick<RuntimeRunRecord, "id" | "state">[] | undefined, runsState: ReadState): string {
  const rows = attemptsForCondition(revision, attempts, conditionId);
  const last = rows.at(-1);
  const judged = assessments.filter(item => rows.some(attempt => attempt.id === item.attemptId)).length;
  const state = last ? attemptRunText(runs?.find(run => run.id === last.runId), runsState) : "尚未运行";
  return `${rows.length} 次尝试 · ${state} · ${judged} 项判定`;
}

export function conclusionGlance(conclusions: Pick<EvaluationConclusion, "comparability" | "nextChoice">[]): string {
  const latest = conclusions.at(-1);
  return latest ? `${labelOf(comparabilityLabels, latest.comparability)} · ${labelOf(nextChoiceLabels, latest.nextChoice)}`
    : "尚无结论；需看两条件的实际尝试与判定";
}

/** Names an assessment by where it belongs (condition, attempt, who, when) instead of by its ID. */
export function assessmentName(item: Pick<EvaluationAssessment, "attemptId" | "assessorKind" | "actorId" | "createdAt">, revision: EvaluationRevision,
  attempts: Pick<EvaluationAttempt, "id" | "conditionId" | "ordinal">[], when: (value: string) => string): string {
  const attempt = attempts.find(row => row.id === item.attemptId);
  const condition = attempt && revision.definition.conditions.find(row => row.id === attempt.conditionId);
  const place = attempt ? `${condition ? labelOf(conditionLabels, condition.kind, "未识别的条件") : "未识别的条件"} · 尝试 ${attempt.ordinal}` : "所属尝试未读到";
  return `${place} · ${labelOf(actorKindLabels, item.assessorKind, "未识别的身份")} ${item.actorId} · ${when(item.createdAt)}`;
}

/** Where (1-based, in record order) the assessment a correction replaces sits among the attempt's assessments. */
export function correctedPosition(item: Pick<EvaluationAssessment, "supersedesId">, assessments: Pick<EvaluationAssessment, "id">[]): number | null {
  if (!item.supersedesId) return null;
  const index = assessments.findIndex(row => row.id === item.supersedesId);
  return index < 0 ? null : index + 1;
}

/** Provider-reported cost and usage of the attempt's run. What was not reported stays unreported, never zero. */
export function runCostText(run: Pick<RuntimeRunRecord, "costUsd" | "usage">): string {
  const parts: string[] = [];
  if (typeof run.costUsd === "number") parts.push(`服务商报告费用 ${run.costUsd} 美元`);
  const usage = run.usage;
  if (usage && (usage.inputTokens !== null || usage.outputTokens !== null))
    parts.push(`输入 ${usage.inputTokens ?? "未报告"} 个、输出 ${usage.outputTokens ?? "未报告"} 个词元`);
  return parts.length ? parts.join(" · ") : "运行未报告费用与用量；不视为零。";
}
