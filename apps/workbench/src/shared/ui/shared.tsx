import { isProjectRoute } from "./returnRoute";
export { href, parseRoute, readRoute, type Route, type Section } from "../routes";
import { href } from "../routes";
import { currentPath } from "../navigation";

export function date(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("zh-CN");
}

export function documentReturnHref(projectId: string): string {
  const query = new URLSearchParams(currentPath().split("?")[1] ?? "");
  const requested = query.get("return");
  if (isProjectRoute(requested, projectId)) return requested;
  try {
    const saved = sessionStorage.getItem(`evoloop:document-return:${projectId}`);
    if (isProjectRoute(saved, projectId)) return saved;
  } catch { /* optional navigation state */ }
  return href(projectId, "documents");
}
