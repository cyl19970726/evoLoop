// The inner rail's object list (docs/frontend/layout.md 内层上下文栏): below the section navigation, the page on
// screen lists its objects (tasks, documents, schedules …) with <ContextRailContent>. Hidden pages never fill it.
import * as React from "react";
import { createPortal } from "react-dom";
import { PageActive } from "./pageActive";

const RailContext = React.createContext<{ target: HTMLElement | null; setTarget(node: HTMLElement | null): void } | null>(null);

export function ContextRailProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = React.useState<HTMLElement | null>(null);
  const value = React.useMemo(() => ({ target, setTarget }), [target]);
  return <RailContext.Provider value={value}>{children}</RailContext.Provider>;
}

/**
 * Where the shell places the list; empty when the page lists nothing. A plain click on a link in the list calls
 * `onNavigate`, so the narrow-screen drawer closes the way it does for the section links.
 */
export function ContextRailSlot({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const rail = React.useContext(RailContext);
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  const setTarget = rail?.setTarget;
  const ref = React.useCallback((element: HTMLElement | null) => { setNode(element); setTarget?.(element); }, [setTarget]);
  React.useEffect(() => {
    if (!node || !onNavigate) return;
    // Portal content bubbles React events to the page, not to this element, so listen on the DOM node itself.
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest("a[href]")) onNavigate();
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, [node, onNavigate]);
  return <div ref={ref} className={className} data-shell="object-list" />;
}

export function ContextRailContent({ children }: { children: React.ReactNode }) {
  const rail = React.useContext(RailContext);
  const active = React.useContext(PageActive);
  return active && rail?.target ? createPortal(children, rail.target) : null;
}

/** Whether the object list is on screen (the wide rail is shown, or the narrow drawer is open). */
export function useContextRailShown(): boolean {
  return !!React.useContext(RailContext)?.target;
}
