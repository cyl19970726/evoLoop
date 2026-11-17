// The shapes the session page draws from (task 6a959b42). A response that is not the shape the page iterates over used to reach the drawing code and take the whole
// page into the error boundary (“e is not iterable”): a live read of `{}` — what a proxy that blocks the live stream can answer — has no `entries`, and the merge spread it.
// Each check either returns a value the page can use, with what was missing named in `limitations`, or throws an ApiError the page already shows as a failed read while it
// keeps the content it has. Nothing here makes up data.
import type { SessionTimelinePage, WorkspaceLiveRead } from "@evoloop/contracts/session-timeline";
import type { ObservedResource, SessionSnapshot } from "@evoloop/contracts/session-observation";
import { ApiError } from "./api";

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const arrayOr = <T>(value: unknown, name: string, missing: string[]): T[] => { if (Array.isArray(value)) return value as T[]; missing.push(name); return []; };

/** The live read of a Session's timeline. Without a cursor the page cannot go on from it, so that is a failed read; a missing list is empty and said so. */
export function checkedLiveRead(value: unknown): WorkspaceLiveRead {
  if (!isObject(value) || typeof value.cursor !== "string") throw new ApiError(0, "实时更新的响应不是预期的格式（没有位置游标），这一轮没有采用；已显示的内容保留，稍后会重读。");
  const missing: string[] = [];
  const entries = arrayOr<WorkspaceLiveRead["entries"][number]>(value.entries, "entries", missing);
  const turns = arrayOr<WorkspaceLiveRead["turns"][number]>(value.turns, "turns", missing);
  const limitations = Array.isArray(value.limitations) ? value.limitations.filter((item): item is string => typeof item === "string") : [];
  if (missing.length) limitations.push(`实时更新缺少 ${missing.join("、")}，按空处理；这一段可能不完整。`);
  const freshness = value.freshness === "live" || value.freshness === "stale" || value.freshness === "unavailable" ? value.freshness : "stale";
  return { ...value, cursor: value.cursor, resetRequired: value.resetRequired === true, entries, turns, freshness, limitations } as WorkspaceLiveRead;
}

/** One page of a Session's timeline: the lists are lists, the live part is a live read; what was missing is named in `limitations`. */
export function checkedTimelinePage(value: unknown): SessionTimelinePage {
  if (!isObject(value)) throw new ApiError(0, "会话时间线的响应不是预期的格式，没有采用。");
  const missing: string[] = [];
  const entries = arrayOr<SessionTimelinePage["entries"][number]>(value.entries, "entries", missing);
  const pending = arrayOr<SessionTimelinePage["pending"][number]>(value.pending, "pending", missing);
  const turns = arrayOr<SessionTimelinePage["turns"][number]>(value.turns, "turns", missing);
  const limitations = Array.isArray(value.limitations) ? value.limitations.filter((item): item is string => typeof item === "string") : [];
  let live: WorkspaceLiveRead;
  try { live = checkedLiveRead(value.live); }
  catch { live = { cursor: "", resetRequired: false, entries: [], turns: [], freshness: "unavailable", limitations: [] }; missing.push("live"); }
  if (missing.length) limitations.push(`时间线缺少 ${missing.join("、")}，按空处理；这一页可能不完整。`);
  const capabilities = isObject(value.capabilities) ? value.capabilities : { history: true, live: false, originalToolDetail: false, reason: "服务没有说明这个会话的读取能力" };
  return { ...value, entries, pending, turns, live, limitations, capabilities,
    unsupportedKinds: Array.isArray(value.unsupportedKinds) ? value.unsupportedKinds : [],
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null, messagesCursor: typeof value.messagesCursor === "string" ? value.messagesCursor : null } as SessionTimelinePage;
}

const missingResource = (): ObservedResource => ({ value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "服务没有返回这一项" });
const RESOURCES = ["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"] as const;

/**
 * A Session's snapshot (Task c3a8e5d1). Its lists and resource block are iterated and spread all over the page; one of them null or of the wrong type — what a partial answer or
 * a proxy can give — used to take the whole page into the error boundary. Without a Session that carries its key there is nothing to show, so that is a failed read; a missing
 * list is empty and a missing resource says it was not returned, and what was missing is named in `metadata.limitations` (`partial`) instead of being made up.
 */
export function checkedSessionSnapshot(value: unknown): SessionSnapshot {
  if (!isObject(value) || !isObject(value.session) || typeof value.session.key !== "string" || !isObject(value.session.target))
    throw new ApiError(0, "会话快照的响应不是预期的格式（没有这个会话），没有采用；已显示的内容保留，稍后会重读。");
  const missing: string[] = [];
  const list = <T>(name: string) => arrayOr<T>(value[name], name, missing);
  const lists = { assignments: list("assignments"), roleTasks: list("roleTasks"), queue: list("queue"), results: list("results"), questions: list("questions"), activity: list("activity") };
  const resources = isObject(value.resources) ? value.resources : (missing.push("resources"), {});
  const checkedResources = Object.fromEntries(RESOURCES.map(name => [name, isObject(resources[name]) ? resources[name] : (isObject(value.resources) && missing.push(`resources.${name}`), missingResource())]));
  const metadata = isObject(value.metadata) ? value.metadata : (missing.push("metadata"), {});
  const limitations = Array.isArray(metadata.limitations) ? metadata.limitations.filter((item): item is string => typeof item === "string") : [];
  if (missing.length) limitations.push(`会话快照缺少 ${missing.join("、")}，按空处理；这一页可能不完整。`);
  return { ...value, ...lists,
    nativeInputRequests: Array.isArray(value.nativeInputRequests) ? value.nativeInputRequests : [],
    currentWork: isObject(value.currentWork) ? value.currentWork : null,
    observationCursor: typeof value.observationCursor === "string" ? value.observationCursor : "",
    resources: checkedResources,
    metadata: { generatedAt: typeof metadata.generatedAt === "string" ? metadata.generatedAt : "", sourceObservedAt: typeof metadata.sourceObservedAt === "string" ? metadata.sourceObservedAt : null,
      partial: metadata.partial === true || missing.length > 0, limitations } } as unknown as SessionSnapshot;
}
