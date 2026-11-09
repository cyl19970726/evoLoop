// Visited pages stay mounted while hidden. A page reads again when the reader comes back to it (another page was on
// screen in between), when the window regains focus, and after a write elsewhere in the app (`refresh`). The answer
// on screen stays until the new one arrives. (Same rule as the document pages' useRereadOnReturn.)
import { useContext, useEffect, useRef } from "react";
import { PageActive } from "./pageActive";

export function useRereadOnReturn(reread: () => void, refresh: number): boolean {
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
