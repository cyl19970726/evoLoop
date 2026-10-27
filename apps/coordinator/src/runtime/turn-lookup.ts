import type { RuntimeBinding, RuntimePage, RuntimeTurn } from "@evoloop/contracts/runtime";

export type TurnLookup = { status: "found"; turn: RuntimeTurn } |
  { status: "partial"; nextTurnCursor: string } | { status: "not_found" };

/** Native 0.164 has paged Turn metadata, but no by-ID metadata read. */
export async function lookupKnownTurn(
  list: (binding: RuntimeBinding, cursor?: string) => Promise<RuntimePage<RuntimeTurn>>,
  binding: RuntimeBinding, turnId: string, initialCursor?: string, maxPages = 2,
): Promise<TurnLookup> {
  let cursor = initialCursor;
  const seen = new Set<string>(cursor ? [cursor] : []);
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await list(binding, cursor);
    const turn = page.data.find(candidate => candidate.id === turnId);
    if (turn) return { status: "found", turn };
    if (page.nextCursor === null) return { status: "not_found" };
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("Runtime turn cursor repeated or invalid");
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  return { status: "partial", nextTurnCursor: cursor! };
}
