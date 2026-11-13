// 跨空间返回 (scenarios.md 跳转规则): a link into another space or page may say where it came from — `return` (a page of
// this project), `actor` (the reader the link was made for) and `returnTitle` (that page's name, optional) — and the page
// it opens offers “返回 <来源>” back to it. Pure, so the agent page, the task page and the document page agree on which
// sources count and say the way back the same way: “返回任务：<名称>”, “返回智能体：<名称>”, “返回日程：<名称>”, “返回统筹安排”.
import { currentPath } from "./navigation";
import { parseRoute, type Section } from "./routes";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const agentKey = /^(owned|external):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The plain pages a link may come back to: the project's sections, without an object of their own. */
const pages = new Set<Section>(["overview", "work", "inbox", "documents", "knowledge", "journey", "discussions", "reviews", "collaboration",
  "runtime", "schedules", "roles", "repository", "operations", "evaluations", "settings", "connectors"]);
/** The parameters that carry the way back; a page that rewrites its own address keeps them. */
export const returnKeys = ["return", "actor", "returnTitle"] as const;
const titleLimit = 80;

/** Where a return link goes, as the reader knows it. */
export type ReturnPlace =
  | { kind: "task"; taskId: string }
  | { kind: "tasks"; selected: string | null }
  | { kind: "agent"; sessionKey: string }
  | { kind: "arrangement" }
  | { kind: "document"; documentId: string }
  | { kind: "page"; section: Section };

/** A page of this project a reader may be sent back to, or null for anything else (another project, an outside address). */
export function returnPlaceOf(target: string | null | undefined, projectId: string): ReturnPlace | null {
  if (!target || target.length > 2048 || /[\u0000-\u001f\u007f#\\]/.test(target)) return null;
  const [path = "", query = "", extra] = target.split("?");
  const project = `/p/${projectId}`;
  if (extra !== undefined || !path.startsWith(`${project}/`)) return null;
  const route = parseRoute(target);
  if (route.projectId !== projectId) return null;
  const params = new URLSearchParams(query);
  const one = (name: string) => params.getAll(name).length <= 1;
  if (route.section === "task") return route.id && uuid.test(route.id) && path === `${project}/tasks/${route.id}` ? { kind: "task", taskId: route.id } : null;
  if (route.section === "document") return route.id && uuid.test(route.id) && path === `${project}/documents/${route.id}` ? { kind: "document", documentId: route.id } : null;
  if (route.section === "evaluations") return path === `${project}/evaluations` || route.id && uuid.test(route.id) && path === `${project}/evaluations/${route.id}`
    ? { kind: "page", section: "evaluations" } : null;
  if (!pages.has(route.section) && route.section !== "sessions" || path !== `${project}/${route.section}` || !one("session") || !one("selected")) return null;
  const session = params.get("session");
  // `/sessions?session={uuid}` is an older link to a managed agent (routes.ts reads it as `owned:{uuid}`).
  if (route.section === "sessions") return session === null ? { kind: "arrangement" } : agentKey.test(session) ? { kind: "agent", sessionKey: session }
    : uuid.test(session) ? { kind: "agent", sessionKey: `owned:${session}` } : null;
  // `/runtime?session=owned:…` is an older agent link (it opens the conversation); `?session={uuid}` stays 分工与运行.
  if (route.section === "runtime" && session !== null && agentKey.test(session)) return { kind: "agent", sessionKey: session };
  if (route.section === "work") {
    const selected = params.get("selected");
    return { kind: "tasks", selected: selected && uuid.test(selected) ? selected : null };
  }
  return { kind: "page", section: route.section };
}

const pageNames: Partial<Record<Section, string>> = {
  overview: "总览", work: "任务列表", inbox: "待我验收与判断", documents: "文档列表", knowledge: "知识空间", journey: "目标与阶段",
  discussions: "分工讨论", reviews: "组织复盘", collaboration: "协作回执", runtime: "分工与运行", schedules: "日程", roles: "职责",
  repository: "仓库规范", operations: "结果未知的操作", evaluations: "评价与后果", settings: "项目设置", connectors: "微信连接",
};

/** A name as the link may show it: one line, at most 80 characters; empty is no name. */
export function returnName(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim().slice(0, titleLimit).trim();
  return text || null;
}

/** “返回任务：<名称>”, “返回智能体：<名称>”, “返回统筹安排” … The name goes after a colon, so a name in 【】 is never bracketed twice. */
export function returnText(place: ReturnPlace, name?: string | null): string {
  const text = returnName(name);
  const named = (kind: string) => text ? `返回${kind}：${text}` : `返回${kind}`;
  switch (place.kind) {
    case "task": return named("任务");
    case "tasks": return place.selected && text ? named("任务") : "返回任务列表";
    case "agent": return named("智能体");
    case "arrangement": return "返回统筹安排";
    case "document": return named("文档");
    // A schedule is one selected on 日程 (`/schedules?schedule=`): “返回日程：<名称>”.
    case "page": return place.section === "schedules" ? named("日程")
      : place.section === "inbox" && text ? `返回${text}` : `返回${pageNames[place.section] ?? "上一页"}`;
  }
}

export interface ReturnLink { href: string; place: ReturnPlace; title: string | null; label: string }

/** The way back an address carries, or null: one `return` to a page of this project, made for this reader. */
export function readReturn(path: string, projectId: string, actorId: string): ReturnLink | null {
  const [, query = "", extra] = path.split("?");
  if (extra !== undefined) return null;
  const params = new URLSearchParams(query);
  if (params.getAll("return").length !== 1 || params.getAll("actor").length !== 1 || params.get("actor") !== actorId) return null;
  const href = params.get("return")!;
  const place = returnPlaceOf(href, projectId);
  if (!place) return null;
  const title = returnName(params.get("returnTitle"));
  return { href, place, title, label: returnText(place, title) };
}

/** The current address as a destination to come back to: its own way back is dropped, so links never nest. */
export function returnSource(path: string): string {
  const [pathname = "", query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  for (const key of returnKeys) params.delete(key);
  return params.size ? `${pathname}?${params}` : pathname;
}

export interface ReturnFrom { href: string; actorId: string; title?: string | null }

/** The parameters a link adds to say where it came from. */
export function returnParams(from: ReturnFrom): Array<[string, string]> {
  const title = returnName(from.title);
  return [["return", returnSource(from.href)], ["actor", from.actorId], ...(title ? [["returnTitle", title] as [string, string]] : [])];
}

/** From the page on screen, when the link does not know a better name for it (a list, a queue, a panel). */
export function hereOrigin(actorId: string, path = currentPath()): ReturnFrom {
  return { href: path, actorId };
}

/** `link` with the way back to `from` added; without `from` (no reader known yet) the link stays plain. */
export function withReturn(link: string, from?: ReturnFrom | null): string {
  if (!from) return link;
  const [pathname = "", query = ""] = link.split("?");
  const params = new URLSearchParams(query);
  for (const key of returnKeys) params.delete(key);
  for (const [key, value] of returnParams(from)) params.set(key, value);
  return `${pathname}?${params}`;
}
