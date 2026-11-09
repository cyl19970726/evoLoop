// Where the reader is: the space (outer rail), the section (inner rail) and the page. Pure, so the rails, the
// mobile tab bar and the tests agree. Labels follow docs/frontend/principles.md (界面用语): Session → 智能体.
import { href, type Route, type Section } from "../../shared/routes";

export type Space = "work" | "agents" | "inbox";

export interface NavItem { section: Section; label: string; children?: readonly NavItem[] }

/** The work space's sections. Pages that used to open only from deep links are listed under their section. */
export const workNavigation: readonly NavItem[] = [
  { section: "overview", label: "总览" },
  { section: "work", label: "任务", children: [
    { section: "work", label: "任务列表" },
    { section: "journey", label: "目标与阶段" },
    { section: "evaluations", label: "评价与后果" },
  ] },
  { section: "documents", label: "文档与知识", children: [
    { section: "documents", label: "过程文档" },
    { section: "knowledge", label: "知识空间" },
    { section: "repository", label: "仓库规范" },
  ] },
  { section: "schedules", label: "日程" },
  { section: "runtime", label: "团队", children: [
    { section: "runtime", label: "分工与运行" },
    { section: "roles", label: "职责" },
    { section: "discussions", label: "分工讨论" },
    { section: "reviews", label: "组织复盘" },
    { section: "collaboration", label: "协作回执" },
  ] },
];

/** 待我处理: acceptance and judgement waiting on me, then operations whose result is unknown. */
export const inboxNavigation: readonly NavItem[] = [
  { section: "inbox", label: "待我验收与判断" },
  { section: "operations", label: "结果未知的操作" },
];

export const spaceLabels: Record<Space, string> = { work: "工作", agents: "智能体", inbox: "待我处理" };

/** The page each section shows in the header and the browser title. */
export const sectionLabels: Record<Section, string> = {
  overview: "总览", work: "任务", "create-task": "新建任务", inbox: "待我验收与判断", task: "任务", documents: "过程文档",
  document: "文档", knowledge: "知识空间", sessions: "智能体", journey: "目标与阶段", discussions: "分工讨论", reviews: "组织复盘",
  collaboration: "协作回执", runtime: "分工与运行", schedules: "日程", roles: "职责", repository: "仓库规范",
  operations: "结果未知的操作", evaluations: "评价与后果", settings: "项目设置", connectors: "微信连接",
};

export function spaceOf(route: Route): Space {
  // `/runtime?session=owned:…` is an old conversation link (redirected to /sessions); `?session={uuid}` is 分工与运行.
  if (route.section === "sessions" || route.section === "runtime" && !!route.session?.includes(":")) return "agents";
  if (route.section === "inbox" || route.section === "operations") return "inbox";
  return "work";
}

/** The work section that owns a page: a task belongs to 任务, a document to 文档与知识, a role to 团队. */
export function workSectionOf(section: Section): Section | null {
  if (["work", "task", "create-task", "journey", "evaluations"].includes(section)) return "work";
  if (["documents", "document", "knowledge", "repository"].includes(section)) return "documents";
  if (["runtime", "roles", "discussions", "reviews", "collaboration"].includes(section)) return "runtime";
  if (section === "overview" || section === "schedules") return section;
  return null;
}

/** The highlighted leaf under a section: a task highlights 任务列表, a document 过程文档. */
export function leafOf(section: Section): Section {
  if (section === "task" || section === "create-task") return "work";
  if (section === "document") return "documents";
  return section;
}

/** The address a space opens by default. */
export function spaceHome(projectId: string, space: Space): string {
  return href(projectId, space === "agents" ? "sessions" : space === "inbox" ? "inbox" : "work");
}

type Store = Pick<Storage, "getItem" | "setItem">;
const memoryKey = (actorId: string, projectId: string, space: Space) => `evoloop:space:${actorId}:${projectId}:${space}`;

/** Each space keeps its last address (object, filters, tab) so switching spaces comes back to the same place. */
export function rememberSpace(store: Store | null, actorId: string, projectId: string, route: Route, path: string): void {
  if (!route.projectId || route.projectId !== projectId || !path.startsWith(`/p/${projectId}/`)) return;
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
