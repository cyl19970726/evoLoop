// Words and small decisions for 知识空间 (docs/frontend/pages/knowledge.md). Pure, so the rail, the reader, the right
// column and the review views say the same thing, and tests read them without a browser. Interface words follow
// docs/frontend/principles.md (界面用语): service values such as `adapter_verified` and internal words such as the index
// watermark never reach the reader as they are; raw IDs only appear in the 完整标识 layer.
import type {
  CandidateStatus, EpistemicStatus, KnowledgeCapabilities, KnowledgeGraph, KnowledgePageType, KnowledgeRelation,
  KnowledgeRevision, KnowledgeSummary, KnowledgeValidity, PublishResult,
} from "@evoloop/contracts/knowledge";
import type { StatusTone } from "@evoloop/ui";

export const pageTypeLabel: Record<KnowledgePageType, string> = { topic: "专题", concept: "概念", analysis: "分析", decision: "决定" };
export const epistemicLabel: Record<EpistemicStatus, string> = {
  observation: "观察", inference: "推断", hypothesis: "假设", adopted: "已采纳判断", disputed: "有争议", superseded: "已取代",
};
export const validityLabel: Record<KnowledgeValidity, string> = { valid: "有效", needs_review: "待复核", withdrawn: "已撤回" };
export const validityTone: Record<KnowledgeValidity, StatusTone> = { valid: "done", needs_review: "waiting", withdrawn: "history" };
export const candidateStatusLabel: Record<CandidateStatus, string> = { pending: "待审", accepted: "已接受", rejected: "未采纳", published: "已发布" };
export const candidateStatusTone: Record<CandidateStatus, StatusTone> = { pending: "waiting", accepted: "idle", rejected: "history", published: "done" };
export const relationTypeLabel: Record<KnowledgeRelation["type"], string> = {
  supports: "支持", contradicts: "挑战或反例", related: "相关", member_of: "属于专题", supersedes: "取代",
};
export const relationStateLabel: Record<KnowledgeRelation["state"], string> = { active: "已登记", needs_review: "待复核", withdrawn: "已撤回" };
export const sourceStateLabel: Record<"reachable" | "withdrawn" | "unavailable", string> = { reachable: "可读取", withdrawn: "已撤回", unavailable: "暂不可读" };
export const pageTypes = Object.keys(pageTypeLabel) as KnowledgePageType[];
export const epistemicStates = Object.keys(epistemicLabel) as EpistemicStatus[];
export const relationTypes = Object.keys(relationTypeLabel) as KnowledgeRelation["type"][];

/** A value the service sent that this page does not know is named as such, never shown raw. */
export function label<K extends string>(labels: Record<K, string>, value: string): string {
  return (labels as Record<string, string>)[value] ?? "未识别";
}

/** What the related-pages graph covers, said for the reader. */
export function graphStatusText(status: KnowledgeGraph["status"]): string {
  return ({
    complete: "已登记的关系都在图里",
    truncated: "关系超过上限，图里只有一部分",
    partial: "部分关系没有读回",
    unavailable: "关系暂不可读",
  } as Record<string, string>)[status] ?? "关系读取状态未识别";
}

/** The service facts in the diagnostic layer, each value in words instead of the service's codes. */
export function capabilityFacts(capabilities: KnowledgeCapabilities): Array<[string, string]> {
  const pick = (labels: Record<string, string>, value: string) => labels[value] ?? "未识别";
  return [
    ["知识服务", capabilities.backendReachable ? "可连接" : "连接不上"],
    ["固定版本正文", pick({ adapter_verified: "已接通", unavailable: "未接通" }, capabilities.fixedRevisionRead)],
    ["发布", pick({ single_maintainer_adapter: "可发布（单一维护方）", unavailable: "暂不能发布" }, capabilities.conditionalPublish)],
    ["页间关系", pick({ adapter_verified: "可读取（有数量上限）", unavailable: "暂不可读" }, capabilities.boundedRelations)],
    ["语义检索", pick({ unverified: "未验证" }, capabilities.semanticIndex)],
    ["迁移", pick({ unsupported: "不支持" }, capabilities.migration)],
    ["服务版本", capabilities.backendVersion ?? "没有提供"],
  ];
}

export interface KnowledgeFilter { query: string; type: "all" | KnowledgePageType; validity: "all" | KnowledgeValidity }
export const emptyFilter: KnowledgeFilter = { query: "", type: "all", validity: "all" };
export const isFiltered = (filter: KnowledgeFilter) => !!filter.query.trim() || filter.type !== "all" || filter.validity !== "all";

/** Search and filters over the pages already loaded; the coverage line says how much that is. */
export function filterKnowledge(items: readonly KnowledgeSummary[], filter: KnowledgeFilter): KnowledgeSummary[] {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => (filter.type === "all" || item.pageType === filter.type)
    && (filter.validity === "all" || item.validity === filter.validity)
    && words.every(word => item.title.toLowerCase().includes(word)));
}

/** The directory: 专题 first, then the other pages, each in the order the service listed them. */
export function knowledgeDirectory(items: readonly KnowledgeSummary[]): { topics: KnowledgeSummary[]; pages: KnowledgeSummary[] } {
  return { topics: items.filter(item => item.pageType === "topic"), pages: items.filter(item => item.pageType !== "topic") };
}

/** Members of an open topic, from the topic's own graph: pages with a registered 属于专题 edge to this revision. */
export function topicMembers(graph: KnowledgeGraph | null, topic: Pick<KnowledgeSummary, "knowledgeId" | "revision">): KnowledgeSummary[] {
  if (!graph) return [];
  const members = graph.edges.filter(edge => edge.type === "member_of" && edge.state !== "withdrawn"
    && edge.toKnowledgeId === topic.knowledgeId && edge.toRevision === topic.revision && edge.fromKnowledgeId !== topic.knowledgeId);
  return members.flatMap(edge => graph.nodes.filter(node => node.knowledgeId === edge.fromKnowledgeId && node.revision === edge.fromRevision))
    .filter((node, index, all) => all.findIndex(other => other.knowledgeId === node.knowledgeId) === index);
}

/** What a list covers, so a filter or a short first page never reads as the whole project. */
export { coverageText } from "../../shared/listCoverage";

/** The empty list, distinguished by why it is empty. A failed or unfinished read never says "没有". */
export function emptyKnowledgeText({ filtered, more, fullRead }: { filtered: boolean; more: boolean; fullRead: boolean }): { title: string; reason: string } {
  if (filtered) return { title: "已载入范围没有匹配的知识页",
    reason: more ? "还有后续页面没有读；载入更多才能确认，或清除筛选。" : "可以清除筛选或换个关键词。" };
  if (more) return { title: "这一页没有可列的知识页", reason: "还有后续页面没有读；载入更多才能确认。" };
  return fullRead
    ? { title: "还没有已发布的知识页", reason: "候选经审阅并发布后会出现在这里。可以从过程文档提出第一条候选。" }
    : { title: "还没有已登记的固定引用", reason: "知识正文读取没有接通，这里只列已登记的固定引用。服务恢复后再读取。" };
}

export interface ReadingStanding { label: string; current: boolean; historical: boolean; note: string | null }

/** Which version is on screen, compared with the current one. An unread current version is said, not guessed. */
export function readingStanding(reading: string, fixed: boolean, current: string | null): ReadingStanding {
  if (!fixed || current === reading) return { label: "当前版", current: true, historical: false, note: null };
  if (current) return { label: "固定历史版", current: false, historical: true, note: "你在读固定的历史版本，当前版已更新。引用前请核对任务实际采用的版本。" };
  return { label: "固定版 · 当前版待核对", current: false, historical: false, note: "当前版这次没有读回，无法判断这一版是不是最新的。" };
}

/** History rows are named by position (newest first), never by their revision code. */
export function historyLabel(index: number, revision: string, current: string | null): string {
  if (revision === current) return "当前版";
  return index === 0 ? "最新一版" : `往前第 ${index} 版`;
}

export interface PageRelation { edge: KnowledgeRelation; otherId: string; otherRevision: string; direction: "out" | "in" }

/**
 * The relations of the revision on screen: its own outgoing edges, plus incoming ones from the graph when the current
 * version is read (the graph describes the current version only).
 */
export function pageRelations(page: Pick<KnowledgeRevision, "knowledgeId" | "revision" | "relations">, graph: KnowledgeGraph | null, readingCurrent: boolean): PageRelation[] {
  const outgoing = page.relations.map(edge => ({ edge, otherId: edge.toKnowledgeId, otherRevision: edge.toRevision, direction: "out" as const }));
  const incoming = readingCurrent && graph ? graph.edges.filter(edge => edge.toKnowledgeId === page.knowledgeId && edge.toRevision === page.revision
    && edge.fromKnowledgeId !== page.knowledgeId && !outgoing.some(other => other.edge.edgeId === edge.edgeId))
    .map(edge => ({ edge, otherId: edge.fromKnowledgeId, otherRevision: edge.fromRevision, direction: "in" as const })) : [];
  return [...outgoing, ...incoming];
}

export const directionText = (relation: PageRelation) => relation.direction === "out" ? "此页指向" : "指向此页";

/** Source keys `document:{id}` open the fixed process document; any other key is shown as a registered reference. */
export const sourceDocumentId = (key: string) => key.startsWith("document:") ? key.slice(9) : null;

/** Whether the body must be re-checked against its sources before use. */
export function sourceReview(sources: readonly { state: string }[]): string | null {
  if (!sources.length) return "这一版没有登记来源，正文待复核。";
  if (sources.some(source => source.state === "withdrawn")) return "有来源已撤回，正文待复核。";
  if (sources.some(source => source.state !== "reachable")) return "有来源暂不可读，正文是否仍有依据无法判断。";
  return null;
}

/** The source list as read: `error` when the latest read failed, `stale` when what is shown was read before that. */
export interface SourcesRead { error: string; stale: boolean }

/**
 * The 提出候选 entry in the space's header. Only a writer sees it. While the project has no knowledge backend a
 * candidate cannot be saved, so the entry says so where it stands and cannot be opened (not at the form's source field).
 */
export function proposeEntry({ canWrite, notConfigured, draftTouched }: { canWrite: boolean; notConfigured: boolean; draftTouched: boolean }):
  { shown: false } | { shown: true; label: string; disabled: boolean; reason: string | null } {
  if (!canWrite) return { shown: false };
  if (notConfigured) return { shown: true, label: "提出候选", disabled: true, reason: "知识后端未配置，暂时不能提出" };
  return { shown: true, label: draftTouched ? "继续候选草稿" : "提出候选", disabled: false, reason: null };
}

/** What the source field of 提出候选 says: reading, not read back (never "没有来源"), kept from before, or what is there. */
export function sourceHint(sources: readonly { state: string }[] | undefined, read: SourcesRead): string {
  if (sources === undefined) return read.error ? "可选来源这次没有读回，暂时不能保存；重新读取后再选。" : "正在读取可选来源…";
  const reachable = sources.filter(source => source.state === "reachable").length;
  if (!reachable) return read.stale ? "上次读回的范围内没有可读取的来源；重新读取后再选。" : "已读范围内没有可读取的来源，暂时不能保存。";
  return read.stale ? "选一份可读取的过程文档版本（上次读回的列表，当前待核对）。" : "选一份可读取的过程文档版本。";
}

export interface Outcome { tone: "info" | "waiting" | "error"; title: string; detail?: string; diagnostic?: string | undefined }

/** What a publish answer means for the reader. A service reason goes to the diagnostic layer only. */
export function publishOutcome(result: PublishResult): Outcome {
  if (result.status === "published") return { tone: "info", title: "已发布", detail: "新的固定版本已经写入，正在读回。" };
  if (result.status === "conflict") return { tone: "waiting", title: "当前版已经变化，没有覆盖", detail: "候选和审阅都保留。请先读当前版，再决定是否重新整理。" };
  return { tone: "error", title: "发布结果未知", detail: "没有确认是否已经写入。请按原操作核对结果，不要重新发布。", diagnostic: result.reason };
}

/**
 * What a reconcile answer means. `null` is "the outside record does not list it yet", not a failure. A retract is
 * reconciled through the same record as a publish, so its answer is said without naming a publish.
 */
export function reconcileOutcome(result: PublishResult | null, kind: "publish" | "retract" = "publish"): Outcome & { settled: boolean } {
  if (!result) return { settled: false, tone: "waiting", title: "外部记录里还没有这次操作", detail: "保留回执，稍后再核对。" };
  if (result.status === "unknown") return { settled: false, tone: "waiting", title: "结果仍未知", detail: "保留回执，稍后再核对。", diagnostic: result.reason };
  if (kind === "retract") return result.status === "published"
    ? { settled: true, tone: "info", title: "已核到这次操作的记录", detail: "外部记录已经写入，正在读回当前状态。" }
    : { settled: true, tone: "waiting", title: "已核到这次操作没有写入", detail: "外部记录没有因这次操作改变，正在读回当前状态。" };
  return result.status === "published"
    ? { settled: true, tone: "info", title: "已核到发布记录", detail: "正在读回当前状态。" }
    : { settled: true, tone: "waiting", title: "已核到发布冲突", detail: "当前版没有被覆盖。" };
}

/** Why the list or the service could not be read, said so that an unconfigured backend is not offered a retry. */
export type ListProblem = { kind: "failed" | "stale" | "page" | "cursor" | "unconfigured"; text: string; detail: string | null };

/**
 * The note above a list after a failed read: the first read (nothing was read, so nothing is called 上次读回), a reread
 * (上次读回，当前待核对), or the next page only (这一页没读到; the loaded pages are still what was read).
 */
export function listProblemText(problem: ListProblem, what: string): { text: string; retry: string | null } {
  if (problem.kind === "unconfigured") return { text: `${problem.text}，暂时无法读取${what}。`, retry: null };
  if (problem.kind === "cursor") return { text: `${what}的分页位置重复，后面的页面没有读完整。已载入的仍可查看。`, retry: null };
  if (problem.kind === "page") return { text: `后面一页${what}这次没有读回：${problem.text}。已载入的仍可查看。`, retry: "重试这一页" };
  if (problem.kind === "stale") return { text: `${what}这次没有读回：${problem.text}。下面是上次读回的，当前待核对。`, retry: "重试" };
  return { text: `${what}这次没有读回：${problem.text}。`, retry: "重试" };
}

/** A service that is not configured for this project is a setting, not a passing failure. */
export const notConfiguredCode = "KNOWLEDGE_NOT_CONFIGURED";

export const receiptTitle = (kind: "publish" | "retract") => kind === "publish" ? "发布结果待核对" : "来源撤回结果待核对";
