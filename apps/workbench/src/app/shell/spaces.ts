// Where the reader is: the space (outer rail), the section (inner rail) and the page. Pure, so the rails, the
// mobile tab bar and the tests agree. Labels follow docs/frontend/principles.md (界面用语): Session → 智能体.
import { href, type Route, type Section } from "../../shared/routes";

export type Space = "work" | "agents" | "inbox";

export interface NavItem {
  section: Section; label: string;
  /** Listed only while the project has something there (records, or a configured backend); the page the reader is on stays listed. */
  optional?: true;
}

/** The work space's top level: 总览, 目标与阶段, 任务, 文档. None of them has children. */
export const workNavigation: readonly NavItem[] = [
  { section: "overview", label: "总览" },
  { section: "journey", label: "目标与阶段" },
  { section: "work", label: "任务" },
  { section: "documents", label: "文档" },
  { section: "knowledge", label: "知识空间", optional: true },
];

/** 运转: folded by default; 分工讨论 and 协作回执 join it once they have records. */
export const operationsNavigation: readonly NavItem[] = [
  { section: "schedules", label: "日程" },
  { section: "roles", label: "职责" },
  { section: "runtime", label: "运行与接入" },
  { section: "discussions", label: "分工讨论", optional: true },
  { section: "collaboration", label: "协作回执", optional: true },
];
export const operationsGroupLabel = "运转";
/** The pages that sit in the 运转 group (their address opens them whether or not they are listed). */
export const operationsSections: readonly Section[] = operationsNavigation.map(item => item.section);

/** The entries to list: optional ones only when the project has records or a configured backend there, or the reader is on that page. */
export function listedEntries(items: readonly NavItem[], present: ReadonlySet<Section> | undefined, current: Section): readonly NavItem[] {
  return items.filter(item => !item.optional || present?.has(item.section) || current === item.section);
}

/** 待我处理: acceptance and judgement waiting on me, then operations whose result is unknown. */
export const inboxNavigation: readonly NavItem[] = [
  { section: "inbox", label: "待我处理" },
  { section: "operations", label: "结果未知的操作" },
];

export const spaceLabels: Record<Space, string> = { work: "工作", agents: "智能体", inbox: "待我处理" };

/** The page each section shows in the header and the browser title. */
export const sectionLabels: Record<Section, string> = {
  overview: "总览", work: "任务", "create-task": "新建任务", inbox: "待我处理", task: "任务", documents: "过程文档",
  document: "文档", knowledge: "知识空间", sessions: "智能体", journey: "目标与阶段", discussions: "分工讨论", reviews: "组织复盘",
  collaboration: "协作回执", runtime: "运行与接入", arrangement: "统筹安排", schedules: "日程", roles: "职责", repository: "仓库规范",
  operations: "结果未知的操作", evaluations: "评价与后果", settings: "项目设置", connectors: "微信连接", "not-found": "找不到页面",
};

export function spaceOf(route: Route): Space {
  // `/runtime?session=owned:…` is an old conversation link (redirected to /sessions); `?session={uuid}` is 运行与接入.
  // 统筹安排 lives in the agents space: the page shown while no agent is selected.
  if (route.section === "sessions" || route.section === "arrangement" || route.section === "runtime" && !!route.session?.includes(":")) return "agents";
  if (route.section === "inbox" || route.section === "operations") return "inbox";
  return "work";
}

/** The work item that owns a page: a task belongs to 任务, a document (and 组织复盘, now a filter of it) to 文档, the pages in 运转 to that group. */
export function workSectionOf(section: Section): Section | typeof operationsGroupKey | null {
  if (["work", "task", "create-task", "evaluations"].includes(section)) return "work";
  if (["documents", "document", "reviews"].includes(section)) return "documents";
  if (section === "overview" || section === "journey" || section === "knowledge") return section;
  if (operationsSections.includes(section)) return operationsGroupKey;
  return null;
}
export const operationsGroupKey = "operations-group" as const;

/** The highlighted entry: a task page highlights 任务, a document 文档, a page in 运转 its own entry. */
export function leafOf(section: Section): Section {
  if (section === "task" || section === "create-task" || section === "evaluations") return "work";
  if (section === "document" || section === "reviews") return "documents";
  return section;
}

/** The address a space opens by default. */
export function spaceHome(projectId: string, space: Space): string {
  return href(projectId, space === "agents" ? "sessions" : space === "inbox" ? "inbox" : "work");
}

type Store = Pick<Storage, "getItem" | "setItem">;
const memoryKey = (actorId: string, projectId: string, space: Space) => `evoloop:space:${actorId}:${projectId}:${space}`;

/**
 * Each space keeps its last address (object, filters, search, selected row, tab) so switching spaces comes back to the
 * same place. The shell calls this on every address change, quiet view-state rewrites included. An address that names
 * no page is not kept: the space reopens where the reader last was on a real page.
 */
export function rememberSpace(store: Store | null, actorId: string, projectId: string, route: Route, path: string): void {
  if (!route.projectId || route.projectId !== projectId || !path.startsWith(`/p/${projectId}/`) || route.section === "not-found") return;
  try { store?.setItem(memoryKey(actorId, projectId, spaceOf(route)), path); } catch { /* memory is a convenience */ }
}

export function spaceHref(store: Store | null, actorId: string, projectId: string, space: Space): string {
  try {
    const saved = store?.getItem(memoryKey(actorId, projectId, space));
    if (saved?.startsWith(`/p/${projectId}/`)) return saved;
  } catch { /* fall back to the space's home */ }
  return spaceHome(projectId, space);
}

/** The first letter or digit of the project name ("【示例】工作台" → "示"), so brackets never become the mark. */
export function projectInitial(title: string): string {
  return (/[\p{L}\p{N}]/u.exec(title)?.[0] ?? "E").toUpperCase();
}
