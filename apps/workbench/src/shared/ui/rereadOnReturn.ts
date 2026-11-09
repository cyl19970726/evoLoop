// Visited pages stay mounted while hidden. A page reads again when the reader comes back to it (another page was on
// screen in between) and when the window regains focus. The answer on screen stays until the new one arrives.
// A write elsewhere in the app needs nothing here when the page reads through useProjectQuery: the write already makes
// the project's reads stale (shared/query.ts projectChanged), and a second reread would cancel that request and send
// it again. A page that still reads by hand passes the app's `refresh` counter to read again after a write.
import { useContext, useEffect, useRef } from "react";
import { PageActive } from "./pageActive";

export function useRereadOnReturn(reread: () => void, refresh?: number): boolean {
  const active = useContext(PageActive);
  const latest = useRef(reread);
  latest.current = reread;
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) latest.current();
    wasActive.current = active;
  }, [active]);
  const firstRefresh = useRef(refresh);
  useEffect(() => { if (refresh !== firstRefresh.current) latest.current(); }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const onFocus = () => { if (document.visibilityState === "visible") latest.current(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active]);
  return active;
}
