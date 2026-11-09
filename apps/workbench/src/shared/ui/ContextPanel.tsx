// The right column: facts about what the center shows, plus objects opened beside it (docs/frontend/layout.md 右栏).
// Pages fill it with <ContextPanelContent>; objects open as tabs with openInPanel(). Width and open/closed are kept
// per space. Below 1100px the panel opens as a drawer (right) and below 760px as a sheet from the bottom.
import * as React from "react";
import { createPortal } from "react-dom";
import { PanelRightClose, PanelRightOpen, X, ArrowUpRight } from "lucide-react";
import { IconButton, Sheet, SheetContent, SheetTitle, SheetDescription, cn } from "@evoloop/ui";
import { PageActive } from "./pageActive";
export { PageActive } from "./pageActive";
/** The space the panel state belongs to (app/shell/spaces.ts); kept as a string so shared code does not depend on app. */
type Space = string;

export const panelWidth = { min: 280, max: 560, initial: 320 } as const;
export const maxObjectTabs = 5;

export interface PanelObject {
  /** Stable identity such as `document:{id}@{revision}`; opening it again selects the existing tab. */
  id: string;
  title: string;
  /** Address of the same object in the center column. */
  href?: string;
  render: () => React.ReactNode;
}

interface PanelState { open: boolean; width: number }
type Store = Pick<Storage, "getItem" | "setItem">;

export function clampWidth(value: number): number {
  return Math.min(panelWidth.max, Math.max(panelWidth.min, Math.round(value)));
}

/** Per-space memory: open/closed and width. Wide screens start open, narrower ones closed. */
export function readPanelState(store: Store | null, space: Space, wide: boolean): PanelState {
  try {
    const saved = JSON.parse(store?.getItem(`evoloop:panel:${space}`) ?? "null") as Partial<PanelState> | null;
    if (saved && typeof saved.open === "boolean" && typeof saved.width === "number") return { open: saved.open, width: clampWidth(saved.width) };
  } catch { /* fall back to defaults */ }
  return { open: wide, width: panelWidth.initial };
}

/** Opening an object: an existing tab is reused, a new one goes first, and at most five stay (oldest dropped). */
export function addObjectTab(tabs: readonly PanelObject[], next: PanelObject): PanelObject[] {
  if (tabs.some(tab => tab.id === next.id)) return tabs.map(tab => tab.id === next.id ? next : tab);
  return [next, ...tabs].slice(0, maxObjectTabs);
}

interface PanelApi {
  open: boolean;
  setOpen(open: boolean): void;
  openInPanel(object: PanelObject): void;
  hasContent: boolean;
}
interface PanelInternals extends PanelApi {
  state: PanelState; update(next: PanelState): void; inline: boolean;
  target: HTMLElement | null; setTarget(node: HTMLElement | null): void; register(): () => void;
  providers: number; tabs: PanelObject[]; active: string; setActive(id: string): void; close(id: string): void;
}
const PanelContext = React.createContext<PanelInternals | null>(null);

export function useContextPanel(): PanelApi | null {
  return React.useContext(PanelContext);
}

/** A page's default facts for the right column. Renders nothing when the shell has no panel (tests, samples). */
export function ContextPanelContent({ children }: { children: React.ReactNode }) {
  const panel = React.useContext(PanelContext);
  const pageActive = React.useContext(PageActive);
  const register = panel?.register;
  React.useEffect(() => pageActive ? register?.() : undefined, [register, pageActive]);
  return pageActive && panel?.target ? createPortal(children, panel.target) : null;
}

function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== "undefined" && window.matchMedia(query).matches;
  const [matches, setMatches] = React.useState(get);
  React.useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Panel state for one space; the shell places <ContextPanelColumn> where the column belongs. */
export function ContextPanelProvider({ space, children }: { space: Space; children: React.ReactNode }) {
  const wide = useMediaQuery("(min-width: 1440px)");
  const inline = useMediaQuery("(min-width: 1100px)");
  const store = typeof window === "undefined" ? null : window.localStorage;
  const [states, setStates] = React.useState<Partial<Record<Space, PanelState>>>({});
  const state = states[space] ?? readPanelState(store, space, wide);
  const update = (next: PanelState) => {
    setStates(previous => ({ ...previous, [space]: next }));
    try { store?.setItem(`evoloop:panel:${space}`, JSON.stringify(next)); } catch { /* memory only */ }
  };
  const [target, setTarget] = React.useState<HTMLElement | null>(null);
  const [providers, setProviders] = React.useState(0);
  const register = React.useCallback(() => { setProviders(count => count + 1); return () => setProviders(count => count - 1); }, []);
  const [tabs, setTabs] = React.useState<PanelObject[]>([]);
  const [active, setActive] = React.useState<string>("facts");
  // Below 1100px the panel is a modal drawer: it opens only when asked and is never restored on its own.
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  React.useEffect(() => { if (inline) setDrawerOpen(false); }, [inline]);
  const hasContent = providers > 0 || tabs.length > 0;
  const shown = inline ? state.open : drawerOpen;
  const setShown = (open: boolean) => inline ? update({ ...state, open }) : setDrawerOpen(open);
  const value: PanelInternals = {
    open: shown && hasContent, hasContent, state: { ...state, open: shown }, update: next => { if (next.open !== shown) setShown(next.open); if (next.width !== state.width) update({ ...state, width: next.width }); },
    inline, target, setTarget, register, providers, tabs, active, setActive,
    setOpen: setShown,
    openInPanel: object => { setTabs(current => addObjectTab(current, object)); setActive(object.id); setShown(true); },
    close: id => { setTabs(current => current.filter(tab => tab.id !== id)); if (active === id) setActive("facts"); },
  };
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

/** The right column itself. The facts container always exists (hidden while empty) so pages can portal into it. */
/** `embedded` gives the column a fixed height inside another page (the /ui samples) instead of following the viewport. */
export function ContextPanelColumn({ embedded = false }: { embedded?: boolean } = {}) {
  const panel = React.useContext(PanelContext);
  if (!panel) return null;
  const { state, update, inline, setTarget, providers, tabs, active, setActive, close, hasContent } = panel;
  const activeTab = tabs.find(tab => tab.id === active);
  const showFacts = active === "facts" || !activeTab;
  const body = <div className="flex h-full min-h-0 flex-col" data-ui="">
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <div role="tablist" aria-label="右栏内容" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {providers > 0 && <button role="tab" type="button" aria-selected={showFacts} onClick={() => setActive("facts")}
          className={cn("shrink-0 rounded-md px-2.5 py-1 text-small text-text-secondary hover:bg-selected", showFacts && "bg-selected text-foreground")}>信息</button>}
        {tabs.map(tab => <span key={tab.id} className={cn("flex shrink-0 items-center rounded-md text-small", active === tab.id ? "bg-selected text-foreground" : "text-text-secondary hover:bg-selected")}>
          <button role="tab" type="button" aria-selected={active === tab.id} onClick={() => setActive(tab.id)} className="max-w-40 truncate py-1 pl-2.5 pr-1" title={tab.title}>{tab.title}</button>
          <button type="button" aria-label={`关闭 ${tab.title}`} onClick={() => close(tab.id)} className="rounded p-1 hover:bg-field"><X size={13} aria-hidden="true" /></button>
        </span>)}
      </div>
      {activeTab?.href && <a href={activeTab.href} aria-label="在中间打开" title="在中间打开" className="flex size-8 shrink-0 items-center justify-center rounded-full text-primary hover:bg-accent focus-visible:shadow-[var(--focus-ring)] outline-none"><ArrowUpRight size={16} aria-hidden="true" /></a>}
      {inline && <IconButton label="收起右栏" icon={<PanelRightClose size={17} />} compact onClick={() => update({ ...state, open: false })} />}
      {!inline && <IconButton label="关闭右栏" icon={<X size={17} />} compact onClick={() => update({ ...state, open: false })} />}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div ref={setTarget} hidden={!showFacts} />
      {activeTab && !showFacts && <div key={activeTab.id}>{activeTab.render()}</div>}
    </div>
  </div>;
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX, startWidth = state.width;
    const move = (e: PointerEvent) => update({ ...state, width: clampWidth(startWidth + (startX - e.clientX)) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  // The facts container must stay mounted for portals even while the column is hidden.
  if (!hasContent || !state.open) return <>
    <div hidden><div ref={setTarget} /></div>
    {hasContent && <div data-ui="" className={embedded ? "absolute right-2 top-2" : "fixed right-4 top-3 z-20"}><IconButton label="展开右栏" icon={<PanelRightOpen size={17} />} variant="secondary" onClick={() => update({ ...state, open: true })} /></div>}
  </>;
  if (!inline) return <Sheet open onOpenChange={open => update({ ...state, open })}>
    <SheetContent side={typeof window !== "undefined" && window.matchMedia("(min-width: 760px)").matches ? "right" : "bottom"} className="p-0">
      <SheetTitle className="sr-only">右栏</SheetTitle><SheetDescription className="sr-only">当前对象的信息与在旁边打开的对象</SheetDescription>
      {body}
    </SheetContent>
  </Sheet>;
  return <aside aria-label="右栏" style={{ width: state.width }} className={cn("flex shrink-0 flex-col border-l border-border", embedded ? "relative h-[440px]" : "sticky top-2 h-[calc(100dvh-16px)]")}>
    <div role="separator" aria-orientation="vertical" aria-label="调整右栏宽度" aria-valuemin={panelWidth.min} aria-valuemax={panelWidth.max} aria-valuenow={state.width} tabIndex={0}
      onPointerDown={startDrag}
      onKeyDown={event => { if (event.key === "ArrowLeft") update({ ...state, width: clampWidth(state.width + 16) }); if (event.key === "ArrowRight") update({ ...state, width: clampWidth(state.width - 16) }); }}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none focus-visible:bg-primary/30" />
    {body}
  </aside>;
}
