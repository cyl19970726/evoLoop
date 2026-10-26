import { useEffect, useRef, useState } from "react";
import type { ObservedSession, SessionDirectory } from "@evoloop/contracts/session-observation";
import { errorText } from "../api";
import { sessionClient } from "./client";

export type DirectoryMembership = "current" | "historical" | "unclassified";
const pageSize = 20;

function checked(page: SessionDirectory, membership: DirectoryMembership): SessionDirectory {
  if (page.items.some(item => item.membership !== membership)) throw new Error("会话目录分类与请求不符，请重新读取。");
  return page;
}

export async function readSessionDirectoryPages(client: ReturnType<typeof sessionClient>, membership: DirectoryMembership,
  search: string, count: number, signal?: AbortSignal): Promise<{ page: SessionDirectory; items: ObservedSession[] }> {
  const options = { membership, search: search || undefined, limit: pageSize };
  let page = checked(await client.directory(options, signal), membership);
  const items = new Map(page.items.map(item => [item.key, item]));
  for (let loaded = 1; loaded < count && page.nextCursor; loaded++) {
    const cursor = page.nextCursor;
    page = checked(await client.directory({ ...options, cursor }, signal), membership);
    if (page.nextCursor === cursor) throw new Error("会话目录分页没有前进，请重新读取。");
    for (const item of page.items) items.set(item.key, item);
  }
  return { page, items: [...items.values()] };
}

export function useSessionDirectoryGroup(token: string, projectId: string, membership: DirectoryMembership,
  search: string, retry: number, enabled: boolean) {
  const [page, setPage] = useState<SessionDirectory | null>(null);
  const [items, setItems] = useState<ObservedSession[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const generation = useRef(0);
  const nextCursor = useRef<string | null>(null);
  const pagesLoaded = useRef(1);
  const reading = useRef(false);
  const loadingMore = useRef(false);
  const moreController = useRef<AbortController | null>(null);

  useEffect(() => {
    const myGeneration = ++generation.current;
    const controller = new AbortController();
    moreController.current?.abort(); moreController.current = null;
    reading.current = false; loadingMore.current = false; nextCursor.current = null; pagesLoaded.current = 1;
    setPage(null); setItems([]); setError(""); setLoading(false); setMoreBusy(false);
    if (!enabled) return () => { generation.current++; controller.abort(); };
    const client = sessionClient(token, projectId);
    async function read() {
      if (document.visibilityState === "hidden" || reading.current || loadingMore.current) return;
      reading.current = true; setLoading(true);
      try {
        const result = await readSessionDirectoryPages(client, membership, search, pagesLoaded.current, controller.signal);
        if (generation.current !== myGeneration) return;
        setPage(result.page); setItems(result.items); nextCursor.current = result.page.nextCursor; setError("");
      } catch (cause) {
        if (!controller.signal.aborted && generation.current === myGeneration) setError(errorText(cause));
      } finally { if (generation.current === myGeneration) { reading.current = false; setLoading(false); } }
    }
    void read();
    const timer = window.setInterval(() => void read(), 10000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { generation.current++; controller.abort(); moreController.current?.abort();
      window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [token, projectId, membership, search, retry, enabled]);

  async function more() {
    const cursor = nextCursor.current;
    if (!enabled || !cursor || moreBusy || reading.current || loadingMore.current) return;
    const myGeneration = generation.current;
    const controller = new AbortController(); moreController.current = controller;
    loadingMore.current = true; setMoreBusy(true);
    try {
      const result = checked(await sessionClient(token, projectId).directory({ membership, search: search || undefined,
        limit: pageSize, cursor }, controller.signal), membership);
      if (generation.current !== myGeneration || cursor !== nextCursor.current) return;
      if (result.nextCursor === cursor) throw new Error("会话目录分页没有前进，请重新读取。");
      setItems(old => [...new Map([...old, ...result.items].map(item => [item.key, item])).values()]);
      nextCursor.current = result.nextCursor; setPage(result); setError(""); pagesLoaded.current++;
    } catch (cause) { if (!controller.signal.aborted && generation.current === myGeneration) setError(errorText(cause)); }
    finally { if (generation.current === myGeneration) { loadingMore.current = false; setMoreBusy(false); moreController.current = null; } }
  }
  return { page, items, error, loading, moreBusy, more, hasMore: !!page?.nextCursor };
}
