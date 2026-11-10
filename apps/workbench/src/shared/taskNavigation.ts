import { readReturn, type ReturnLink } from "./returnLink";

export type TaskSection ="overview" | "basis" | "delivery" | "runtime" | "history" | "actions";
const sections = new Set<TaskSection>(["overview", "basis", "delivery", "runtime", "history", "actions"]);

export function taskSectionHref(projectId: string, taskId: string, target: {revisionId?: string; tab?: TaskSection} = {}): string {
  const base = `/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
  return target.revisionId ? `${base}?revision=${encodeURIComponent(target.revisionId)}` :
    target.tab ? `${base}?tab=${target.tab}` : base;
}

/** The way back on an exact Task route: a page of this project the link was made from, for this reader — an agent,
 * 统筹安排, a document or a work section (shared/returnLink.ts) — never this same task. */
export function taskSessionReturn(hash: string, projectId: string, taskId: string, actorId: string): ReturnLink | null {
  const [path, , extra] = hash.split("?");
  if (extra !== undefined || path !== taskSectionHref(projectId, taskId)) return null;
  const source = readReturn(hash, projectId, actorId);
  if (!source || source.place.kind === "task" && source.place.taskId === taskId) return null;
  return source;
}

/** A Work list backlink can carry its filter across tabs without becoming a Session identity claim. */
export function taskListReturn(hash: string, projectId: string, taskId: string): string | null {
  const [path, query, extra] = hash.split("?");
  if (extra !== undefined || path !== taskSectionHref(projectId, taskId)) return null;
  const params = new URLSearchParams(query ?? "");
  if (params.getAll("list").length !== 1) return null;
  const list = params.get("list");
  return list?.split("?")[0] === `/p/${encodeURIComponent(projectId)}/work` ? list : null;
}

/** The task list's filters and sort travel with the task's address, so the inner rail keeps them (tasks.md 列表). */
export const taskListKeys = ["q", "state", "kind", "scope", "sort"] as const;

/** The address of one task tab: the verified Session return, the list backlink and the list view are kept. */
export function taskTabHref(path: string, projectId: string, taskId: string, section: TaskSection, actorId?: string): string {
  const params = new URLSearchParams({ tab: section });
  const source = actorId ? taskSessionReturn(path, projectId, taskId, actorId) : null;
  if (source) {
    params.set("return", source.href);
    params.set("actor", actorId!);
    if (source.title) params.set("returnTitle", source.title);
  }
  const list = taskListReturn(path, projectId, taskId);
  if (list) params.set("list", list);
  const [current, query = ""] = path.split("?");
  if (current === taskSectionHref(projectId, taskId)) {
    const existing = new URLSearchParams(query);
    for (const key of taskListKeys) { const value = existing.get(key); if (value) params.set(key, value); }
  }
  return `${taskSectionHref(projectId, taskId)}?${params}`;
}

/** Internal tab changes use the same URL as incoming links, so browser history and later same-Task links agree. */
export function navigateTaskTab(projectId: string, taskId: string, section: TaskSection,
  location: {path:string}, actorId?: string): boolean {
  const href = taskTabHref(location.path, projectId, taskId, section, actorId);
  if (location.path === href) return false;
  location.path = href;
  return true;
}

/** A Task tab hint is read only for this exact project and Task; a fixed revision always opens history. */
export function taskSectionFromHash(hash: string, projectId: string, taskId: string): TaskSection | null {
  const [path, query, extra] = hash.split("?");
  if (extra !== undefined || path !== taskSectionHref(projectId, taskId)) return null;
  const params = new URLSearchParams(query ?? "");
  if (params.has("revision")) return "history";
  const tab = params.get("tab");
  return tab && params.getAll("tab").length === 1 && sections.has(tab as TaskSection) ? tab as TaskSection : "overview";
}

export function taskRunFromHash(hash: string, projectId: string, taskId: string): string | null {
  const [path, query = "", extra] = hash.split("?");
  if (extra !== undefined || path !== taskSectionHref(projectId, taskId)) return null;
  const params = new URLSearchParams(query);
  return params.get("tab") === "runtime" ? params.get("run") : null;
}

/** Land at the visible tab row after React has switched a deep-linked tab. */
export function scrollToTaskSection(projectId: string, taskId: string, section: TaskSection,
  revisionId: string | undefined, getElement: (id: string) => HTMLElement | null): boolean {
  const prefix = `${projectId}-${taskId}-${revisionId ?? "current"}`;
  const panel = getElement(`task-panel-${prefix}-${section}`);
  const tabs = getElement(`task-tabs-${prefix}`);
  const selected = getElement(`task-tab-${prefix}-${section}`);
  if (!panel || panel.hidden || !tabs || !selected || panel.closest<HTMLElement>("[data-page-key]")?.hidden) return false;
  tabs.scrollIntoView({ block: "start", behavior: "auto" });
  const strip = tabs.getBoundingClientRect();
  const button = selected.getBoundingClientRect();
  if (button.left < strip.left) tabs.scrollLeft += button.left - strip.left;
  else if (button.right > strip.right) tabs.scrollLeft += button.right - strip.right;
  return true;
}
