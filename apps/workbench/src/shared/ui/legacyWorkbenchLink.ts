import { isProjectRoute } from "./returnRoute";

/** Only links written for the former local workbench may move with this project. */
const legacyOrigin = "http://127.0.0.1:55431";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validReturn(value: string, projectId: string): boolean {
  if (value.length > 2048 || value.includes("#", 1) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const route = value.startsWith("#") ? value.slice(1) : value;
  const path = route.split("?")[0];
  const match = new RegExp(`^/p/${projectId}/documents/([^/?#]+)$`, "i").exec(path ?? "");
  return isProjectRoute(route, projectId) || (!!match && uuid.test(match[1]!));
}

function validRoute(hash: string, projectId: string): boolean {
  const prefix = `#/p/${projectId}/`;
  if (!hash.startsWith(prefix) || hash.length > 4096 || /[\u0000-\u001f\u007f]/.test(hash)) return false;
  const route = hash.slice(prefix.length);
  const [pathname, query, extra] = route.split("?");
  if (extra !== undefined || !pathname) return false;
  const path = /^(tasks|documents)\/([0-9a-f-]+)$/i.exec(pathname);
  if (!path || !uuid.test(path[2]!)) return false;
  if (query === undefined) return true;
  if (!query || query.includes("#")) return false;
  const params = new URLSearchParams(query);
  if (![...params.keys()].every(key => ["revision", "run", "return", "returnTitle", "actor", "tab", "list"].includes(key))) return false;
  if (new Set(params.keys()).size !== [...params.keys()].length) return false;
  for (const [key, value] of params) {
    if ((key === "revision" || key === "run") && !uuid.test(value)) return false;
    if (key === "actor" && !/^[a-z0-9_-]{1,240}$/i.test(value)) return false;
    if (key === "returnTitle" && (!value || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value))) return false;
    if (key === "tab" && !["overview", "basis", "delivery", "runtime", "history", "actions"].includes(value)) return false;
    if (key === "list" && (!value.startsWith(`${prefix}work`) || value.split("?")[0] !== `${prefix}work` ||
      value.includes("#", 1) || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))) return false;
    if (key === "return" && !validReturn(value, projectId)) return false;
  }
  return true;
}

export function legacyWorkbenchRoute(raw: string, projectId?: string): string | null {
  if (!projectId || !uuid.test(projectId) || !raw.startsWith(`${legacyOrigin}/#`)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== legacyOrigin || url.username || url.password || url.pathname !== "/" || url.search ||
    !validRoute(url.hash, projectId)) return null;
  // Open as a path; nested return and list addresses written as `#/p/…` become paths too.
  const [path, query] = url.hash.slice(1).split("?");
  if (query === undefined) return path!;
  const params = new URLSearchParams(query);
  for (const key of ["return", "list"]) {
    const value = params.get(key);
    if (value?.startsWith("#/")) params.set(key, value.slice(1));
  }
  return `${path}?${params}`;
}
