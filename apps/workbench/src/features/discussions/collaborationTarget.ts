// The question a 待我决定 link points at, read from the task address: `/p/{project}/tasks/{task}?section=collaboration&discussion=…&question=…`.
// Anything that is not exactly that (another section, another page, a repeated parameter) selects nothing.
export function collaborationTarget(path: string, projectId: string, taskId: string): { discussionId: string; eventId: string } | null {
  const [pathname, query = ""] = path.split("?");
  if (pathname !== `/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}` && pathname !== `/p/${projectId}/tasks/${taskId}`) return null;
  const params = new URLSearchParams(query);
  if (params.get("section") !== "collaboration") return null;
  const one = (name: string) => { const values = params.getAll(name); return values.length === 1 && values[0]!.trim() ? values[0]! : ""; };
  const eventId = one("question");
  return eventId ? { discussionId: one("discussion"), eventId } : null;
}
