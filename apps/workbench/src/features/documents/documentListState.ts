// The reader's list conditions (search, kind, status, how far the list is loaded, the document last opened), kept
// per identity and project for this tab. The inner rail, the table and every reading page share them, so opening a
// document and coming back keeps the same conditions, range and row. Nothing here is written to storage.
import { useCallback, useSyncExternalStore } from "react";
import type { KindFilter, StatusFilter } from "./documentPresentation";

export const pageSize = 50;
/** How long typing rests before a search is sent to the server (and written to the address). */
export const searchRestMs = 350;

export interface DocumentListState {
  /** What is typed in the search box; the server searches titles of every document with it. */
  query: string;
  kind: KindFilter;
  status: StatusFilter;
  /** How many documents the list should hold from the first page on. */
  target: number;
  /** The document last opened from the table or the inner rail, highlighted and focused in the table on return. */
  lastOpened: string | null;
}

export const initialListState: DocumentListState = { query: "", kind: "all", status: "active", target: pageSize, lastOpened: null };

export const isFiltered = (state: Pick<DocumentListState, "query" | "kind" | "status">): boolean =>
  !!state.query.trim() || state.kind !== "all" || state.status !== "active";

/** Pages a range read may take, so short pages never turn one request into an unbounded walk. */
export const pagesFor = (state: Pick<DocumentListState, "target">): number => Math.max(1, Math.ceil(state.target / pageSize));

/** Apply a change. Another type, status or search is another list: it starts from its first page again. */
export function nextListState(current: DocumentListState, patch: Partial<DocumentListState>): DocumentListState {
  const next = { ...current, ...patch };
  const changed = (patch.kind !== undefined && patch.kind !== current.kind) || (patch.status !== undefined && patch.status !== current.status) ||
    (patch.query !== undefined && patch.query.trim() !== current.query.trim());
  if (changed && patch.target === undefined) next.target = pageSize;
  return next;
}

/** Load the next page by hand: one page past what is loaded now. */
export const loadMoreTarget = (state: Pick<DocumentListState, "target">, loaded: number): number =>
  Math.max(state.target, loaded) + pageSize;

const states = new Map<string, DocumentListState>();
const listeners = new Set<() => void>();

function read(scope: string): DocumentListState { return states.get(scope) ?? initialListState; }
function write(scope: string, patch: Partial<DocumentListState>): void {
  const next = nextListState(read(scope), patch);
  states.set(scope, next);
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The shared list conditions for one identity and project. */
export function useDocumentListState(scope: string): [DocumentListState, (patch: Partial<DocumentListState>) => void] {
  const state = useSyncExternalStore(subscribe, () => read(scope), () => read(scope));
  const update = useCallback((patch: Partial<DocumentListState>) => write(scope, patch), [scope]);
  return [state, update];
}
