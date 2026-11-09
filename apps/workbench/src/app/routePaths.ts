/** Every in-project address under /p/{project}/; `parseRoute` in shared/ui/shared.tsx maps each to a section. */
export const projectPaths = ["overview", "work", "inbox", "tasks/new", "tasks/$taskId", "documents", "documents/$documentId",
  "knowledge", "sessions", "journey", "discussions", "reviews", "collaboration", "runtime", "schedules", "roles",
  "repository", "operations", "evaluations", "evaluations/$evaluationId", "settings", "connectors"] as const;
