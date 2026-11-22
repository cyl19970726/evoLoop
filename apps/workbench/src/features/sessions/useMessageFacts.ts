// The saved messages of one agent (sender class, send time, how each was processed, its reply) read from the message list, so
// the timeline can say who a message is from, when it was sent and what the agent answered. It reads more pages while a message
// the timeline shows is not in what was read yet, up to a few pages; a message not found says less, never something else.
import { useEffect, useMemo } from "react";
import { useProjectPages } from "../../shared/query";
import { sessionClient } from "../../shared/sessionClient";
import type { MessageFact } from "./timelineRounds";

const maxPages = 6;

export function useMessageFacts(projectId: string, sessionKey: string, wanted: readonly string[], enabled: boolean, changed: string) {
  const pages = useProjectPages(projectId, ["session-message-facts", sessionKey],
    (cursor, signal) => sessionClient("", projectId).messages(sessionKey, cursor, signal), { enabled });
  const messages = useMemo(() => new Map<string, MessageFact>((pages.data?.pages ?? []).flatMap(page => (page.items ?? []).map(item => [item.id, item] as const))), [pages.data]);
  const missing = wanted.some(id => !messages.has(id));
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, refetch } = pages;
  const loaded = pages.data?.pages.length ?? 0;
  useEffect(() => {
    if (enabled && missing && hasNextPage && !isFetching && !isFetchNextPageError && loaded < maxPages) void fetchNextPage();
  }, [enabled, missing, hasNextPage, isFetching, isFetchNextPageError, loaded, fetchNextPage]);
  // New entries or a changed turn can mean a new message or a new reply: read the pages already loaded again.
  useEffect(() => { if (enabled && loaded > 0) void refetch(); }, [changed]);
  return { messages, settled: !enabled || !pages.isPending, failed: pages.isError };
}
