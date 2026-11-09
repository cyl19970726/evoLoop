// Section routes of the current workbench pages and the addresses that open them.
import { currentPath } from "./navigation";

export type Section = "overview" | "work" | "create-task" | "knowledge" | "sessions" | "task" | "document" | "documents" | "inbox" | "journey" | "discussions" | "reviews" | "collaboration" | "runtime" | "schedules" | "roles" | "repository" | "operations" | "evaluations" | "settings" | "connectors";
export type Route = { projectId: string | null; section: Section; id?: string; revision?: string; action?: string; session?: string };


/** The current address as a section route. */
export function readRoute(): Route { return parseRoute(currentPath()); }

/** `/p/{project}/{section}/…?…` → section route; anything outside a project is the project list. */
export function parseRoute(path: string): Route {
  const [pathname = "/", search = ""] = path.split("?");
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "p" || !parts[1]) return { projectId: null, section: "overview" };
  const section = parts[2];
  const action = new URLSearchParams(search).get("action") || undefined;
  const revision = new URLSearchParams(search).get("revision") || undefined;
  const requestedSession = new URLSearchParams(search).get("session") || undefined;
  const session = section === "sessions" && requestedSession && !requestedSession.includes(":")
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedSession)
    ? `owned:${requestedSession}` : requestedSession;
  if (section === "tasks" && parts[3] === "new") return { projectId: parts[1], section: "create-task" };
  if (section === "tasks" && parts[3]) return { projectId: parts[1], section: "task", id: parts[3], revision };
  if (section === "documents" && parts[3]) return { projectId: parts[1], section: "document", id: parts[3], revision };
  if (section === "evaluations") return { projectId: parts[1], section: "evaluations", id: parts[3], revision };
  if (["work", "knowledge", "sessions", "documents", "inbox", "journey", "discussions", "reviews", "collaboration", "runtime", "schedules", "roles", "repository", "operations", "settings", "connectors"].includes(section ?? "")) return { projectId: parts[1], section: section as Section, action, ...(["sessions", "runtime"].includes(section ?? "") ? { session } : {}) };
  return { projectId: parts[1], section: "overview" };
}

export function href(projectId: string, section: Section, id?: string, revision?: string): string {
  const part = section === "task" ? `tasks/${id}` : section === "create-task" ? "tasks/new" : section === "document" ? `documents/${id}` : section === "evaluations" && id ? `evaluations/${id}` : section;
  return `/p/${projectId}/${part}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}`;
}
