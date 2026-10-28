import type { LeaderWorkDocument, LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";

export interface LeaderDocumentLoad {
  items: Map<string, LeaderWorkDocument>;
  complete: boolean;
}

/** Continue the lifecycle index until every currently rendered Document is covered. */
export async function loadLeaderDocumentsForIds(
  read: (cursor?: string) => Promise<LeaderWorkPage<LeaderWorkTask | LeaderWorkDocument>>,
  wantedIds: readonly string[],
): Promise<LeaderDocumentLoad> {
  const wanted = new Set(wantedIds), found = new Map<string, LeaderWorkDocument>(), seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const result = await read(cursor);
    for (const item of result.items) if (item.kind === "document") found.set(item.documentId, item);
    if ([...wanted].every(id => found.has(id))) return { items: found, complete: true };
    if (!result.nextCursor) return { items: found, complete: false };
    if (seen.has(result.nextCursor)) throw new Error("文档生命周期分页游标重复，无法确认覆盖完整性");
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}
