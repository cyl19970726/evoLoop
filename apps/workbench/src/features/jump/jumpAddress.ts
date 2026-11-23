// 地址栏认短编号 (Task 5eb93990): which addresses in the project carry an id written as a prefix, what to look up for
// it and the address the full id gives. Pure functions of the address; the page that resolves it is ResolveAddress.
import { parseJumpInput, type JumpObjectKind } from "@evoloop/contracts/object-jump";
import type { Route } from "../../shared/routes";

const fullId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isFullId = (text: string) => fullId.test(text);

/** What the address names that is not a full id: the object kind, the text written, and the address once the full id is known. */
export interface ShortAddress { kind: Exclude<JumpObjectKind, "delivery">; text: string; withId(id: string): string }

const kindLabels: Record<Exclude<JumpObjectKind, "delivery">, string> = { task: "任务", document: "文档", session: "智能体", stage: "阶段", schedule: "日程" };
export const jumpKindLabel = (kind: JumpObjectKind) => kind === "delivery" ? "交付" : kindLabels[kind];
/** Where each kind is listed, for 回到列表. */
export const kindListSection = { task: "work", document: "documents", session: "sessions", stage: "journey", schedule: "schedules" } as const;

/** The same address with one query parameter changed, keeping every other parameter in its place. */
function withParam(pathname: string, query: string, name: string, value: string): string {
  const params = new URLSearchParams(query);
  params.set(name, value);
  return `${pathname}?${params}`;
}

/**
 * The short id an address carries, or null when it carries none or a full one (`/tasks/{id}`, `/documents/{id}`,
 * `?session=`, `?stage=`, `?schedule=`). Whatever is not a full id counts: a prefix is looked up, anything else is
 * “找不到这个对象” at once.
 */
export function shortAddress(route: Route, path: string): ShortAddress | null {
  const [pathname = "", query = ""] = path.split("?");
  const projectId = route.projectId;
  if (!projectId) return null;
  if (route.section === "task" && route.id && !isFullId(route.id)) return { kind: "task", text: route.id, withId: id => `/p/${projectId}/tasks/${id}${query ? `?${query}` : ""}` };
  if (route.section === "document" && route.id && !isFullId(route.id)) return { kind: "document", text: route.id, withId: id => `/p/${projectId}/documents/${id}${query ? `?${query}` : ""}` };
  const params = new URLSearchParams(query);
  if (route.section === "sessions") {
    const written = route.session ?? null;
    // `owned:{prefix}` or a bare prefix; another kind of key (`external:…`) is not an id of this project's agents.
    const text = written?.startsWith("owned:") ? written.slice(6) : written && !written.includes(":") ? written : null;
    if (text && !isFullId(text)) return { kind: "session", text, withId: id => withParam(pathname, query, "session", `${written!.startsWith("owned:") ? "owned:" : ""}${id}`) };
  }
  if (route.section === "journey" && params.get("stage") && !isFullId(params.get("stage")!)) return { kind: "stage", text: params.get("stage")!, withId: id => withParam(pathname, query, "stage", id) };
  if (route.section === "schedules" && params.get("schedule") && !isFullId(params.get("schedule")!)) return { kind: "schedule", text: params.get("schedule")!, withId: id => withParam(pathname, query, "schedule", id) };
  return null;
}

/** Why a text is not looked up at all, or null when it is: fewer than 8 digits is 至少要 8 位, anything else is not an id. */
export function jumpRefusal(text: string): string | null {
  const parsed = parseJumpInput(text);
  if (parsed.kind === "short") return "至少要 8 位";
  if (parsed.kind === "invalid") return "不是编号：写 8 位以上的编号，或 PR 号如 #527";
  return null;
}
