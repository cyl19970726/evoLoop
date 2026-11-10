// What a list covers, said under the list (覆盖范围), so a filter, a short first page, a read under way or a failed
// read never reads as the whole project. Only a list that was just read may say 已读完. Shared by the document and
// knowledge lists; the state comes from shared/query.ts projectListState.

/**
 * `current`: the loaded pages were just read. `checking`: they are read again. `stale`: that reread failed (上次读回).
 * `reading`: the first page is on its way. `failed`: the first page failed and nothing was ever read.
 */
export type ListCoverage = "current" | "checking" | "stale" | "reading" | "failed";

export function coverageText({ loaded, matched, filtered, more, coverage = "current", unit = "项" }: {
  loaded: number; matched: number; filtered: boolean; more: boolean; coverage?: ListCoverage; unit?: string;
}): string {
  if (coverage === "failed") return "列表没有读回，无法判断有多少";
  if (coverage === "reading") return "正在读取";
  const count = `${coverage === "stale" ? "上次读回" : "已载入"} ${loaded} ${unit}${filtered ? ` · 匹配 ${matched} ${unit}` : ""}`;
  if (coverage === "stale") return `${count}${more ? " · 后续页面未读" : ""} · 当前待核对`;
  if (coverage === "checking") return `${count}${more ? " · 后续页面未读" : ""} · 正在核对`;
  return `${count}${more ? " · 后续页面未读" : " · 已读完"}`;
}

/** Said when a list's next cursor came back as one already read: the reading stopped, so the list may not be whole. */
export const repeatedCursorText = "后续页没有前进，列表可能不完整";

/**
 * What a list says about the rows after the loaded ones: a cursor that did not move (never as if read to the end),
 * more to read, or nothing (read to its end).
 */
export function listEndText(state: { more: boolean; repeatedCursor: boolean }): string | null {
  if (state.repeatedCursor) return repeatedCursorText;
  return state.more ? "还有后续" : null;
}
