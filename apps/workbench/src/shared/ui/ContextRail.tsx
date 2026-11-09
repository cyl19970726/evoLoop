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

/** Where the shell places the list; empty when the page lists nothing. */
export function ContextRailSlot({ className }: { className?: string }) {
  const rail = React.useContext(RailContext);
  return <div ref={rail?.setTarget} className={className} data-shell="object-list" />;
}

export function ContextRailContent({ children }: { children: React.ReactNode }) {
  const rail = React.useContext(RailContext);
  const active = React.useContext(PageActive);
  return active && rail?.target ? createPortal(children, rail.target) : null;
}
