// Visited pages stay mounted while hidden. A document page reads again when the reader comes back to it (another
// page was on screen in between) and when the window regains focus. A write elsewhere in the app needs nothing here:
// it already makes the project's reads stale (shared/query.ts projectChanged), and a second reread would cancel that
// request and send it again. The answer on screen stays until the new one arrives.
import { useContext, useEffect, useRef } from "react";
import { PageActive } from "../../shared/ui/pageActive";

export function useRereadOnReturn(reread: () => void): boolean {
  const active = useContext(PageActive);
  const latest = useRef(reread);
  latest.current = reread;
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) latest.current();
    wasActive.current = active;
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const onFocus = () => { if (document.visibilityState === "visible") latest.current(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active]);
  return active;
}
