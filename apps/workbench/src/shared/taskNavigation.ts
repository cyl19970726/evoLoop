export type TaskSection = "overview" | "basis" | "delivery" | "runtime" | "history" | "actions";
const sections = new Set<TaskSection>(["overview", "basis", "delivery", "runtime", "history", "actions"]);

export function taskSectionHref(projectId: string, taskId: string, target: {revisionId?: string; tab?: TaskSection} = {}): string {
  const base = `#/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
  return target.revisionId ? `${base}?revision=${encodeURIComponent(target.revisionId)}` :
    target.tab ? `${base}?tab=${target.tab}` : base;
}

/** Only an exact Task route and the current reader's Session link can provide a return destination. */
export function taskSessionReturn(hash: string, projectId: string, taskId: string, actorId: string):
  { href: string; title: string } | null {
  const [path, query, extra] = hash.split("?");
  if (extra !== undefined || path !== taskSectionHref(projectId, taskId)) return null;
  const params = new URLSearchParams(query ?? "");
  if (params.getAll("actor").length !== 1 || params.get("actor") !== actorId ||
    params.getAll("return").length !== 1) return null;
  const destination = params.get("return");
  if (!destination) return null;
  const [returnPath, returnQuery, returnExtra] = destination.split("?");
  const project = `#/p/${encodeURIComponent(projectId)}`;
  if (returnExtra !== undefined || !returnQuery ||
    (returnPath !== `${project}/sessions` && returnPath !== `${project}/runtime`)) return null;
  const session = new URLSearchParams(returnQuery).get("session");
  if (!session?.match(/^(owned|external):[0-9a-f-]{36}$/i)) return null;
  return { href: destination, title: params.get("returnTitle")?.slice(0, 80).trim() || "Session" };
}

/** A Work list backlink can carry its filter across tabs without becoming a Session identity claim. */
export function taskListReturn(hash: string, projectId: string, taskId: string): string | null {
  const [path, query, extra] = hash.split("?");
  if (extra !== undefined || path !== taskSectionHref(projectId, taskId)) return null;
  const params = new URLSearchParams(query ?? "");
  if (params.getAll("list").length !== 1) return null;
  const list = params.get("list");
  return list?.split("?")[0] === `#/p/${encodeURIComponent(projectId)}/work` ? list : null;
}

/** Internal tab changes use the same URL as incoming links, so browser history and later same-Task links agree. */
export function navigateTaskTab(projectId: string, taskId: string, section: TaskSection,
  location: {hash:string}, actorId?: string): boolean {
  const params = new URLSearchParams({ tab: section });
  const source = actorId ? taskSessionReturn(location.hash, projectId, taskId, actorId) : null;
  if (source) {
    params.set("return", source.href);
    params.set("actor", actorId!);
    params.set("returnTitle", source.title);
  }
  const list = taskListReturn(location.hash, projectId, taskId);
  if (list) params.set("list", list);
  const href = `${taskSectionHref(projectId, taskId)}?${params}`;
  if (location.hash === href) return false;
  location.hash = href;
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
