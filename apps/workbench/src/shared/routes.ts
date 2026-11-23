// Section routes of the current workbench pages and the addresses that open them.
import { appHistory, currentPath, onNavigate } from "./navigation";

/** `not-found` is an address inside a project that names no page (a mistyped or outdated link); it is never linked to. */
export type Section = "overview" | "work" | "create-task" | "knowledge" | "sessions" | "task" | "document" | "documents" | "inbox" | "journey" | "discussions" | "reviews" | "collaboration" | "runtime" | "arrangement" | "schedules" | "roles" | "repository" | "operations" | "evaluations" | "settings" | "connectors" | "go" | "not-found";
export type Route = { projectId: string | null; section: Section; id?: string; revision?: string; action?: string; session?: string };


/** The current address as a section route. */
export function readRoute(): Route { return parseRoute(currentPath()); }

/** Sections whose address is one segment, `/p/{project}/{section}`. */
const singleSections = ["overview", "work", "knowledge", "sessions", "documents", "inbox", "journey", "discussions", "reviews", "collaboration", "runtime", "arrangement", "schedules", "roles", "repository", "operations", "settings", "connectors"];

/**
 * `/p/{project}/{section}/…?…` → section route; anything outside a project is the project list, and `/p/{project}`
 * alone is the overview. An address inside the project that names no page is `not-found`, never quietly the overview.
 */
export function parseRoute(path: string): Route {
  const [pathname = "/", search = ""] = path.split("?");
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "p" || !parts[1]) return { projectId: null, section: "overview" };
  if (parts.length === 2) return { projectId: parts[1], section: "overview" };
  const section = parts[2];
  // `/p/{project}/go/{text}`: whatever a pasted id, id prefix or PR number names (Task 5eb93990). `id` is the text, decoded.
  if (section === "go" && parts.length === 4 && parts[3]) { let text = parts[3]; try { text = decodeURIComponent(text); } catch { /* kept as written */ } return { projectId: parts[1], section: "go", id: text }; }
  const objectSection = section === "tasks" || section === "documents" || section === "evaluations";
  if (parts.length > 4 || parts.length === 4 && !objectSection || !objectSection && !singleSections.includes(section ?? "") || section === "tasks" && !parts[3])
    return { projectId: parts[1], section: "not-found" };
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
  if (["work", "knowledge", "sessions", "documents", "inbox", "journey", "discussions", "reviews", "collaboration", "runtime", "arrangement", "schedules", "roles", "repository", "operations", "settings", "connectors"].includes(section ?? "")) return { projectId: parts[1], section: section as Section, action, ...(["sessions", "runtime"].includes(section ?? "") ? { session } : {}) };
  return { projectId: parts[1], section: "overview" };
}

/**
 * Older team addresses and where they open now: `/runtime?session={key with a colon}` is an agent conversation
 * (`/sessions?session=`), `/runtime?view=roles|discussions` is its own section, and `?view=execution` is plain
 * `/runtime`. `/runtime?session={uuid}` stays: it selects that managed agent in 运行与接入. Null when nothing changes.
 */
export function legacyTeamAddress(path: string): string | null {
  const [pathname = "", query = ""] = path.split("?");
  const parts = pathname.split("/");
  // The navigation cleanup (Task 34f2a392): 组织复盘 is the 复盘 filter of 文档, 仓库规范 is a part of 项目设置. Both old addresses go there.
  if ((parts.length === 4 || parts.length === 5 && parts[4] === "") && parts[1] === "p" && parts[2]) {
    if (parts[3] === "reviews") return `/p/${parts[2]}/documents?kind=organization_review`;
    if (parts[3] === "repository") return `/p/${parts[2]}/settings#settings-repository`;
  }
  // `/p/{project}/runtime` or `/p/{project}/sessions`, or the same with a trailing slash.
  if (!(parts.length === 4 || parts.length === 5 && parts[4] === "") || parts[1] !== "p" || !parts[2] || parts[3] !== "runtime" && parts[3] !== "sessions") return null;
  const params = new URLSearchParams(query);
  const rest = (section: string) => { const text = params.toString(); return `/p/${parts[2]}/${section}${text ? `?${text}` : ""}`; };
  // `/sessions` (also with `?view=flow`) is where 统筹安排 now opens while no agent is selected; `?session=` opens that agent. Nothing to rewrite.
  if (parts[3] === "sessions") return null;
  if (params.get("session")?.includes(":")) { params.delete("view"); return rest("sessions"); }
  const view = params.get("view");
  if (!params.has("view")) return null;
  params.delete("view");
  return rest(view === "roles" || view === "discussions" ? view : "runtime");
}

/** Rewrite an old team address in place, keeping the fragment. True when it did. */
export function redirectLegacyTeam(): boolean {
  const target = legacyTeamAddress(currentPath());
  if (!target) return false;
  appHistory().replace(target.includes("#") ? target : `${target}${appHistory().location.hash}`, undefined, { ignoreBlocker: true });
  return true;
}

/** Installed before the app subscribes to navigation (main.tsx), so no page ever opens on an old team address. */
export function installLegacyTeamRedirect(): () => void {
  redirectLegacyTeam();
  return onNavigate(() => { redirectLegacyTeam(); });
}

/** One role on 职责. */
export function roleHref(projectId: string, roleId: string): string {
  return `/p/${projectId}/roles?role=${encodeURIComponent(roleId)}`;
}

/** One agent's column on 统筹安排. */
export function arrangementAgentHref(projectId: string, sessionKey: string): string {
  return `/p/${projectId}/arrangement#${arrangementAgentId(sessionKey)}`;
}
export const arrangementAgentId = (sessionKey: string) => `agent-${encodeURIComponent(sessionKey)}`;

/** One stage on 目标与阶段: the address every page that names a stage links to. */
export function stageHref(projectId: string, stageId: string): string {
  return `/p/${projectId}/journey?stage=${encodeURIComponent(stageId)}`;
}

export function href(projectId: string, section: Section, id?: string, revision?: string): string {
  const part = section === "task" ? `tasks/${id}` : section === "create-task" ? "tasks/new" : section === "document" ? `documents/${id}` : section === "evaluations" && id ? `evaluations/${id}` : section === "go" && id ? `go/${encodeURIComponent(id)}` : section;
  return `/p/${projectId}/${part}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}`;
}
