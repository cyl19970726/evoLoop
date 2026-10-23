export type TaskSection = "overview" | "basis" | "delivery" | "runtime" | "history" | "actions";
const sections = new Set<TaskSection>(["overview", "basis", "delivery", "runtime", "history", "actions"]);

export function taskSectionHref(projectId: string, taskId: string, target: {revisionId?: string; tab?: TaskSection} = {}): string {
  const base = `#/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
  return target.revisionId ? `${base}?revision=${encodeURIComponent(target.revisionId)}` :
    target.tab ? `${base}?tab=${target.tab}` : base;
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

/** Land at the visible panel after React has switched a deep-linked tab. */
export function scrollToTaskSection(projectId: string, taskId: string, section: TaskSection,
  revisionId: string | undefined, getElement: (id: string) => HTMLElement | null): boolean {
  const panel = getElement(`task-panel-${projectId}-${taskId}-${revisionId ?? "current"}-${section}`);
  if (!panel || panel.hidden) return false;
  panel.scrollIntoView({ block: "start", behavior: "auto" });
  return true;
}
