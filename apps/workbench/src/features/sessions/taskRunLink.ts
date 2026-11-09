/** Add a Run target to a Task link without dropping its Session return context. */
export function taskRunLink(taskHref: string, runId: string): string {
  const [path, query] = taskHref.split("?");
  const params = new URLSearchParams(query ?? "");
  params.set("tab", "runtime");
  params.set("run", runId);
  return `${path}?${params}`;
}

/** Use the Task recorded on this Run; a missing or invalid association has no direct route. */
export function observedRunTaskLink(run: { taskId: string | null | undefined; id: string }, taskHref: (taskId: string) => string): string | null {
  if (typeof run.taskId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run.taskId)) return null;
  return taskRunLink(taskHref(run.taskId), run.id);
}
