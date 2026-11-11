// The right column: facts about what the center shows, plus objects opened beside it (docs/frontend/layout.md 右栏).
// Pages fill it with <ContextPanelContent>; objects open as tabs with openInPanel(). Width and open/closed are kept
// per space. Below 1100px the panel opens as a drawer (right) and below 760px as a sheet from the bottom.
import * as React from "react";
import { createPortal } from "react-dom";
import { PanelRightClose, PanelRightOpen, X, ArrowUpRight } from "lucide-react";
import { Button, IconButton, Sheet, SheetContent, SheetTitle, SheetDescription, cn } from "@evoloop/ui";
import { appPath, currentPath, onAddressChange, onNavigate } from "../navigation";
import { parseRoute } from "../routes";
import { PageActive } from "./pageActive";
import { useMediaQuery } from "./useMediaQuery";
export { PageActive } from "./pageActive";
/** The space the panel state belongs to (app/shell/spaces.ts); kept as a string so shared code does not depend on app. */
type Space = string;

export const panelWidth = { min: 280, max: 560, initial: 320 } as const;
export const maxObjectTabs = 5;

export interface PanelObject {
  /** Stable identity such as `document:{id}@{revision}`; opening it again selects the existing tab. */
  id: string;
  title: string;
  /** The task page that opened this object. Changing to another task closes it instead of showing it out of context. */
  ownerTaskId?: string;
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
  target: HTMLElement | null; host(node: HTMLElement | null): void; register(): () => void;
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

/** Where an address points for the right column: the page and the revision it reads, without view state. */
export function panelPlace(href: string): string {
  const [pathname = "", query = ""] = (appPath(href) ?? href).split("#")[0]!.split("?");
  const revision = new URLSearchParams(query).get("revision");
  return revision ? `${pathname}?revision=${revision}` : pathname;
}

/**
 * After the center moves to an address, a tab showing the same object would repeat the center: it closes, and the
 * column shows 信息 (the facts of what the center now reads) when that tab was the one in front.
 */
export function afterCenterMoved(tabs: readonly PanelObject[], active: string, path: string): { tabs: PanelObject[]; active: string } {
  const here = panelPlace(path);
  const kept = tabs.filter(tab => !tab.href || panelPlace(tab.href) !== here);
  return { tabs: kept, active: active !== "facts" && !kept.some(tab => tab.id === active) ? "facts" : active };
}

/** The task whose page or selected table row supplies the right column's default facts. */
export function currentTaskId(path: string): string | null {
  const route = parseRoute(path);
  if (route.section === "task") return route.id ?? null;
  if (route.section !== "work") return null;
  return new URLSearchParams(path.split("?")[1] ?? "").get("selected") || null;
}

/** A task's opened objects stay while that task remains current; another task starts from its own 信息, not stale text. */
export function afterTaskChanged(tabs: PanelObject[], active: string, path: string): { tabs: PanelObject[]; active: string } {
  const taskId = currentTaskId(path);
  if (!taskId) return { tabs, active };
  const kept = tabs.filter(tab => !tab.ownerTaskId || tab.ownerTaskId === taskId);
  if (kept.length === tabs.length) return { tabs, active };
  return { tabs: kept, active: active !== "facts" && !kept.some(tab => tab.id === active) ? "facts" : active };
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
  // One container for the page's facts for the whole life of the shell. The column, the drawer or a hidden holder
  // takes it in turn (moved in the DOM), so the portal never changes target and forms in it keep their state when the
  // panel collapses or switches between column and drawer.
  const [target] = React.useState<HTMLElement | null>(() => typeof document === "undefined" ? null : document.createElement("div"));
  const host = React.useCallback((node: HTMLElement | null) => { if (node && target && target.parentNode !== node) node.appendChild(target); }, [target]);
  const [providers, setProviders] = React.useState(0);
  const register = React.useCallback(() => { setProviders(count => count + 1); return () => setProviders(count => count - 1); }, []);
  const [tabs, setTabs] = React.useState<PanelObject[]>([]);
  const [active, setActive] = React.useState<string>("facts");
  const latest = React.useRef({ tabs, active });
  latest.current = { tabs, active };
  // Below 1100px the panel is a modal drawer: it opens only when asked and is never restored on its own.
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  React.useEffect(() => { if (inline) setDrawerOpen(false); }, [inline]);
  // Following a link (from the drawer or anywhere else) closes the drawer, so it never reopens over the next page
  // or over this one when the reader comes back. 在中间打开 (or any link to an open tab's object) closes that tab:
  // the center reads it in full now, and 信息 shows its facts.
  React.useEffect(() => onNavigate(() => {
    setDrawerOpen(false);
    const moved = afterCenterMoved(latest.current.tabs, latest.current.active, currentPath());
    const next = afterTaskChanged(moved.tabs, moved.active, currentPath());
    if (next.tabs !== latest.current.tabs) setTabs(next.tabs);
    if (next.active !== latest.current.active) setActive(next.active);
  }), []);
  // Table row selection changes the current task with a quiet address rewrite rather than navigation.
  React.useEffect(() => onAddressChange(() => {
    const next = afterTaskChanged(latest.current.tabs, latest.current.active, currentPath());
    if (next.tabs !== latest.current.tabs) setTabs(next.tabs);
    if (next.active !== latest.current.active) setActive(next.active);
  }), []);
  const hasContent = providers > 0 || tabs.length > 0;
  const shown = inline ? state.open : drawerOpen;
  const setShown = (open: boolean) => inline ? update({ ...state, open }) : setDrawerOpen(open);
  const value: PanelInternals = {
    open: shown && hasContent, hasContent, state: { ...state, open: shown }, update: next => { if (next.open !== shown) setShown(next.open); if (next.width !== state.width) update({ ...state, width: next.width }); },
    inline, target, host, register, providers, tabs, active, setActive,
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
  // The drawer opens from a page's own button (所选任务信息, 任务信息) or 展开右栏, never from a Radix trigger, so
  // Radix would leave focus on <body> when it closes. Hand focus back to what opened it, as the navigation drawer does.
  const opener = React.useRef<HTMLElement | null>(null);
  if (!panel) return null;
  const { state, update, inline, host, providers, tabs, active, setActive, close, hasContent } = panel;
  const rememberOpener = () => {
    const focused = document.activeElement;
    opener.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
  };
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const target = opener.current;
    opener.current = null;
    const shown = (element: HTMLElement | null) => !!element?.isConnected && element.getClientRects().length > 0;
    // 展开右栏 is replaced while the drawer is open; its successor takes the focus.
    const expand = document.querySelector<HTMLElement>("[data-panel-expand]");
    (shown(target) ? target : shown(expand) ? expand : document.getElementById("workspace-main"))?.focus({ preventScroll: true });
  };
  const activeTab = tabs.find(tab => tab.id === active);
  const showFacts = active === "facts" || !activeTab;
  const body = <div className="flex h-full min-h-0 flex-1 flex-col" data-ui="">
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <div role="tablist" aria-label="右栏内容" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {providers > 0 && <Button role="tab" variant="tab" aria-selected={showFacts} onClick={() => setActive("facts")}>信息</Button>}
        {/* An opened object's tab and its close button share one highlight. */}
        {tabs.map(tab => <span key={tab.id} className={cn("flex shrink-0 items-center rounded-md", active === tab.id ? "bg-selected" : "hover:bg-selected")}>
          <Button role="tab" variant="tab" aria-selected={active === tab.id} onClick={() => setActive(tab.id)} title={tab.title}
            className="min-w-0 max-w-40 pr-1 hover:bg-transparent aria-selected:bg-transparent"><span className="truncate">{tab.title}</span></Button>
          <IconButton label={`关闭 ${tab.title}`} icon={<X aria-hidden="true" />} className="size-6 rounded-sm [&_svg]:size-3.5" onClick={() => close(tab.id)} />
        </span>)}
      </div>
      {activeTab?.href && <a href={activeTab.href} aria-label="在中间打开" title="在中间打开" className="flex size-8 shrink-0 items-center justify-center rounded-full text-primary hover:bg-accent focus-visible:shadow-[var(--focus-ring)] outline-none"><ArrowUpRight size={16} aria-hidden="true" /></a>}
      {inline && <IconButton label="收起右栏" icon={<PanelRightClose size={17} />} compact onClick={() => update({ ...state, open: false })} />}
      {!inline && <IconButton label="关闭右栏" icon={<X size={17} />} compact onClick={() => update({ ...state, open: false })} />}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div ref={host} hidden={!showFacts} />
      {activeTab && !showFacts && <div key={activeTab.id}>{activeTab.render()}</div>}
    </div>
  </div>;
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX, startWidth = state.width;
    const move = (e: PointerEvent) => update({ ...state, width: clampWidth(startWidth + (startX - e.clientX)) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  // The facts container must stay mounted for portals even while the column is hidden. Collapsed, the column keeps a
  // narrow strip in the work panel for 展开右栏, so the button never covers a page's header; on phones the button sits
  // in the top bar, which keeps room for it. The strip stays while the drawer is open, so the page under the drawer
  // keeps its width (the same element, so focus can come back to it).
  const strip = hasContent && <div data-ui="" data-panel-strip="" className={embedded ? "absolute right-2 top-2"
    : "fixed right-2 top-1.5 z-40 compact:sticky compact:right-auto compact:top-2 compact:z-auto compact:flex compact:h-[calc(100dvh-16px)] compact:w-12 compact:shrink-0 compact:justify-center compact:border-l compact:border-border compact:pt-3"}>
    <IconButton data-panel-expand="" label="展开右栏" icon={<PanelRightOpen size={17} />} variant="secondary" onClick={() => update({ ...state, open: true })} />
  </div>;
  if (!hasContent || !state.open) return <><div hidden ref={host} />{strip}{null}</>;
  const bottom = typeof window !== "undefined" && !window.matchMedia("(min-width: 760px)").matches;
  if (!inline) return <>{null}{strip}<Sheet open onOpenChange={open => update({ ...state, open })}>
    {/* The bottom quick view keeps one height (layout.md: about nine tenths of the screen) so content that grows while
        it renders, such as a diagram in a document, never moves the sheet or its tabs. */}
    <SheetContent side={bottom ? "bottom" : "right"} className={cn("p-0", bottom && "h-[85dvh]")} onOpenAutoFocus={rememberOpener} onCloseAutoFocus={returnFocus}>
      <SheetTitle className="sr-only">右栏</SheetTitle><SheetDescription className="sr-only">当前对象的信息与在旁边打开的对象</SheetDescription>
      {body}
    </SheetContent>
  </Sheet></>;
  return <aside aria-label="右栏" style={{ width: state.width }} className={cn("flex shrink-0 flex-col border-l border-border", embedded ? "relative h-[440px]" : "sticky top-2 h-[calc(100dvh-16px)]")}>
    <div role="separator" aria-orientation="vertical" aria-label="调整右栏宽度" aria-valuemin={panelWidth.min} aria-valuemax={panelWidth.max} aria-valuenow={state.width} tabIndex={0}
      onPointerDown={startDrag}
      onKeyDown={event => { if (event.key === "ArrowLeft") update({ ...state, width: clampWidth(state.width + 16) }); if (event.key === "ArrowRight") update({ ...state, width: clampWidth(state.width - 16) }); }}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none focus-visible:bg-primary/30" />
    {body}
  </aside>;
}
