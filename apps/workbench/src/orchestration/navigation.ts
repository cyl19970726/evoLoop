export type TaskSection = "overview" | "basis" | "delivery" | "runtime" | "history" | "actions";
const sections = new Set<TaskSection>(["overview", "basis", "delivery", "runtime", "history", "actions"]);

export function taskSectionHref(projectId: string, taskId: string, target: {revisionId?: string; tab?: TaskSection} = {}): string {
  const base = `#/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
  return target.revisionId ? `${base}?revision=${encodeURIComponent(target.revisionId)}` :
    target.tab ? `${base}?tab=${target.tab}` : base;
}

/** Internal tab changes use the same URL as incoming links, so browser history and later same-Task links agree. */
export function navigateTaskTab(projectId: string, taskId: string, section: TaskSection,
  location: {hash:string}): boolean {
  const href = taskSectionHref(projectId, taskId, {tab:section});
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
