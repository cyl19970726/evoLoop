// 统筹安排 › 动态 (DEC-045 F1): the scheduling flow as a picture. The layout, the event-to-picture mapping, the live / pause / replay controls
// and the accessibility rules, driven by whatever `events` and `board` it is given. It reads nothing by itself: FlowPage feeds it the work
// board (source "live") and the sample route /ui/flow feeds it hand-written fixtures, which the page says on screen.
import { stationNode, type NodeInfo, type OpenInfo } from "./flowOpen";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pause, Play, Radio } from "lucide-react";
import { Button, cn } from "@evoloop/ui";
import type { SchedEvent, WorkBoardSnapshot } from "@evoloop/contracts/work-board";
import {
  GROUPS, PEOPLE, STATIONS, foldPackets, isStuck, routeOf, stationCounts, stuckSpots, styleOf, upTo,
  type FlowContext, type FlowGroup, type FlowTone, type NodeId, type Packet,
} from "./flowModel";

/** The most packets on the canvas at once; more are merged into one "×N" (docs/frontend/pages/flow-view.md 性能预算). */
export const MAX_PACKETS = 12;
const PACKET_MS = 1400;
/** A packet that has arrived stays on its target this long, so it can be clicked; then it goes. */
const PACKET_KEEP_MS = 6000;
/** The event list shows the newest rows only; older ones are reached with the time slider. */
const LIST_ROWS = 200;
const STEP_MS = 800;
const tone: Record<FlowTone, string> = { accent: "text-accent-foreground", warning: "text-warning", danger: "text-destructive", brand: "text-brand", neutral: "text-text-secondary" };

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query), on = () => setMatches(list.matches);
    list.addEventListener("change", on); on();
    return () => list.removeEventListener("change", on);
  }, [query]);
  return matches;
}

// ---- geometry (percent of a 1160 x 640 stage) ----
const W = 1160, H = 640;
interface Box { x: number; y: number; w: number; h: number }
const LEADER: Box = { x: 450, y: 250, w: 260, h: 100 }, TRAY: Box = { x: 480, y: 396, w: 200, h: 48 }, BOARD: Box = { x: 360, y: 24, w: 440, h: 190 };
const PEOPLE_BOX = (i: number): Box => ({ x: 24, y: 40 + i * 96, w: 200, h: 72 });
const MAX_SESSIONS = 7;
function sessionBox(i: number, n: number): Box { const rows = Math.min(n, MAX_SESSIONS), step = Math.min(88, 470 / Math.max(1, rows)); return { x: 880, y: 28 + i * step, w: 256, h: Math.min(72, step - 8) }; }
/** A path runs from the edge of one box to just short of the edge of the other (GAP), so a packet that has arrived rests beside its target, clear of it, and can be clicked. */
const GAP = 16;
function anchors(a: Box, b: Box): [[number, number], [number, number]] {
  if (a.x + a.w <= b.x) return [[a.x + a.w, a.y + a.h / 2], [b.x - GAP, b.y + b.h / 2]];
  if (b.x + b.w <= a.x) return [[a.x, a.y + a.h / 2], [b.x + b.w + GAP, b.y + b.h / 2]];
  return a.y <= b.y ? [[a.x + a.w / 2, a.y + a.h], [b.x + b.w / 2, b.y - GAP]] : [[a.x + a.w / 2, a.y], [b.x + b.w / 2, b.y + b.h + GAP]];
}
const pct = (b: Box) => ({ left: `${(b.x / W) * 100}%`, top: `${(b.y / H) * 100}%`, width: `${(b.w / W) * 100}%`, height: `${(b.h / H) * 100}%` });

export interface FlowConnectionInfo { state: "loading" | "live" | "reconnecting" | "failed"; error: string; lastSeq: number; reconnects: number }
export interface FlowViewProps {
  board: WorkBoardSnapshot; events: SchedEvent[]; context: FlowContext;
  /** "fixture": shown with the on-screen notice that nothing here is read from an instance. */
  source: "fixture" | "live";
  /** Replay starts at this many events shown (default: all; live follows the newest). */
  startAt?: number;
  /** Live only: the state of the stream, said on screen. */
  connection?: FlowConnectionInfo;
  /** What the loaded events cover, said on screen (e.g. "近 6 小时；更早的没有读"). */
  windowNote?: string;
  /** The real objects an event opens, what the links do not say, and the pull request (or why it cannot be read). */
  openInfo?: (event: SchedEvent) => OpenInfo;
  /** What a node opens, or why it cannot (live only; a fixture node has no real object). */
  nodeInfo?: (id: NodeId) => NodeInfo;
  /** How many hours the loaded events and the 已验收 count cover. Said on the 已验收 cell itself. */
  windowHours?: number;
  /** Which event is selected at first (used by tests and by deep links). */
  selectSeq?: number;
  /** Which node is selected at first (tests and deep links). */
  selectNode?: NodeId;
}
type Mode = "live" | "paused" | "replay";

export function FlowView({ board, events, context, source, startAt, connection, windowNote, openInfo, nodeInfo, windowHours, selectSeq, selectNode }: FlowViewProps) {
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const narrow = useMedia("(max-width: 640px)");
  const live = source === "live";
  const [mode, setMode] = useState<Mode>(live ? "live" : "paused");
  const [stored, setStored] = useState(Math.min(events.length, startAt ?? events.length) - 1);
  // Live shows everything received; paused and replay show the events up to the stored position, so new events never move what is on screen.
  const cursor = mode === "live" ? events.length - 1 : stored;
  const newer = Math.max(0, events.length - 1 - cursor);
  const [hidden, setHidden] = useState<Set<FlowGroup>>(new Set());
  const [stuckOnly, setStuckOnly] = useState(false);
  const [selected, setSelected] = useState<{ type: "event"; seq: number } | { type: "node"; id: NodeId } | null>(selectSeq !== undefined ? { type: "event", seq: selectSeq } : selectNode ? { type: "node", id: selectNode } : null);
  const [fresh, setFresh] = useState<SchedEvent[]>([]);
  const [flash, setFlash] = useState<Set<NodeId>>(new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  const addFresh = (batch: SchedEvent[]) => {
    if (!batch.length) return;
    const route = routeOf(batch.at(-1)!, context);
    if (reduced) { setFlash(new Set([route.from, route.to])); timers.current.push(window.setTimeout(() => setFlash(new Set()), STEP_MS)); return; }
    setFresh(list => [...list.filter(e => !batch.some(b => b.seq === e.seq)), ...batch].slice(-MAX_PACKETS * 2));
    timers.current.push(window.setTimeout(() => setFresh(list => list.filter(e => !batch.some(b => b.seq === e.seq))), PACKET_KEEP_MS));
  };
  const eventsRef = useRef(events); eventsRef.current = events;

  // Replay: one timer, only while replaying and the tab is in front. What is shown is a function of the cursor, so a tab that was in the
  // background loses nothing: when it returns the state is whatever the events up to the cursor say.
  useEffect(() => {
    if (mode !== "replay") return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      const all = eventsRef.current;
      setStored(current => {
        if (current + 1 >= all.length) { setMode("paused"); return current; }
        addFresh([all[current + 1]!]);
        return current + 1;
      });
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [mode, context, reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: every event that arrives after the first picture is a packet; a background tab updates the data and draws no packet.
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const last = events.at(-1)?.seq ?? 0;
    if (seen.current === null) { seen.current = last; return; }
    const batch = events.filter(e => e.seq > seen.current!);
    seen.current = last;
    if (mode === "live" && batch.length && !document.hidden) addFresh(batch.slice(-MAX_PACKETS));
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (next: Mode) => {
    if (next === "live") { setFresh([]); setMode("live"); return; }
    if (next === "paused") { setStored(cursor); setMode("paused"); return; }
    // Replay from the start when the position is at the end: the cursor goes to 0 and it really plays, it does not just flip the state.
    const atEnd = cursor + 1 >= events.length;
    setFresh([]); setStored(atEnd ? -1 : cursor); setMode("replay");
  };

  const shown = useMemo(() => upTo(events, cursor), [events, cursor]);
  const visible = useMemo(() => shown.filter(e => !hidden.has(styleOf(e.kind).group) && (!stuckOnly || isStuck(e))), [shown, hidden, stuckOnly]);
  const stuck = useMemo(() => stuckSpots(board), [board]);
  const stations = useMemo(() => stationCounts(board, shown.filter(e => e.kind === "acceptance.closed").length), [board, shown]);
  const packets = useMemo(() => reduced ? [] : foldPackets(fresh.filter(e => !hidden.has(styleOf(e.kind).group)), context, MAX_PACKETS), [fresh, hidden, context, reduced]);
  const sessions = useMemo(() => board.sessions.filter(s => s.sessionId !== context.leaderSessionId), [board.sessions, context.leaderSessionId]);
  const nodeBox = (id: NodeId): Box => {
    if (id === "leader") return LEADER; if (id === "packets") return TRAY;
    if (id.startsWith("people.")) return PEOPLE_BOX(Math.max(0, PEOPLE.findIndex(p => p.id === id)));
    const i = sessions.findIndex(s => `session:${s.sessionId}` === id);
    return sessionBox(Math.max(0, Math.min(i, MAX_SESSIONS - 1)), sessions.length);
  };
  const pathOf = (from: NodeId, to: NodeId): string => {
    const [[ax, ay], [bx, by]] = anchors(nodeBox(from), nodeBox(to)), mid = (ax + bx) / 2, vertical = Math.abs(bx - ax) < 1;
    return vertical ? `M ${ax} ${ay} L ${bx} ${by}` : `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}`;
  };
  const toggle = (group: FlowGroup) => setHidden(prev => { const next = new Set(prev); next.has(group) ? next.delete(group) : next.add(group); return next; });
  const selectedEvent = selected?.type === "event" ? events.find(e => e.seq === selected.seq) ?? null : null;
  const lastTime = shown.at(-1)?.at;

  const sessionStatus = (id: string) => {
    const s = sessions.find(x => x.sessionId === id);
    if (!s) return { glyph: "?", text: "读不到" };
    if (s.health.recoveryGate !== "open" || s.health.providerHeld) return { glyph: "!", text: "受阻" };
    if (s.current) return { glyph: "▶", text: "运行中" };
    if (s.queue.length || s.queuedMessages) return { glyph: "…", text: "排队中" };
    return { glyph: "○", text: "空闲" };
  };
  const NodeButton = ({ id, className, children, label }: { id: NodeId; className?: string; children: ReactNode; label: string }) => (
    <Button variant="row" aria-label={label} aria-pressed={selected?.type === "node" && selected.id === id} data-node={id} style={pct(nodeBox(id))}
      onClick={() => setSelected({ type: "node", id })}
      className={cn("absolute flex h-auto min-w-0 flex-col items-start justify-center gap-0.5 rounded-lg bg-card px-3 text-left border border-border hover:bg-card", flash.has(id) && "bg-accent", selected?.type === "node" && selected.id === id && "bg-accent hover:bg-accent", className)}>
      {children}
    </Button>);

  const rows = visible.length > LIST_ROWS ? visible.slice(visible.length - LIST_ROWS) : visible;
  const eventList = (
    <ol className="flex max-h-96 flex-col overflow-y-auto" aria-label="事件列表">
      {visible.length === 0 && <li className="py-3 text-small text-muted-foreground">{shown.length === 0 ? "还没有事件" : "筛选后没有事件"}</li>}
      {visible.length > rows.length && <li className="py-1 text-caption text-muted-foreground">更早的 {visible.length - rows.length} 条没有列在这里，用时间滑杆回放。</li>}
      {[...rows].reverse().map(e => {
        const st = styleOf(e.kind), route = routeOf(e, context);
        return <li key={e.seq}>
          <Button variant="row" data-event={e.seq} aria-pressed={selected?.type === "event" && selected.seq === e.seq} onClick={() => setSelected({ type: "event", seq: e.seq })}
            className={cn("flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-small", selected?.type === "event" && selected.seq === e.seq ? "bg-accent" : "hover:bg-muted")}>
            <span className={cn("w-4 shrink-0 text-center", tone[st.tone])} aria-hidden="true">{st.glyph}</span>
            <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{new Date(e.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
            <span className="min-w-0 flex-1 truncate">{st.known ? st.label : `未知事件 ${e.kind}`}{e.subject.title ? `：${e.subject.title}` : ""}</span>
            {isStuck(e) && <span className="shrink-0 text-caption text-destructive">卡住</span>}
            {!route.known && <span className="shrink-0 text-caption text-muted-foreground">端点未识别</span>}
          </Button></li>;
      })}
    </ol>);

  const detail = selectedEvent ? (() => {
    const st = styleOf(selectedEvent.kind), route = routeOf(selectedEvent, context);
    return <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small" aria-label="事件详情">
      <dt className="text-muted-foreground">时间</dt><dd>{new Date(selectedEvent.at).toLocaleString("zh-CN", { hour12: false })}</dd>
      <dt className="text-muted-foreground">种类</dt><dd>{st.known ? st.label : "未知事件"} <code className="text-caption">{selectedEvent.kind}</code></dd>
      <dt className="text-muted-foreground">从谁到谁</dt><dd>{selectedEvent.from ?? "未记录"} → {selectedEvent.to ?? "未记录"}（画面：{route.known ? `${route.from} → ${route.to}` : "端点未识别，画在“其他身份”"}）</dd>
      <dt className="text-muted-foreground">对象</dt><dd>{selectedEvent.subject.title ?? selectedEvent.subject.kind} <code className="text-caption">{selectedEvent.subject.id.slice(0, 8)}</code></dd>
      <dt className="text-muted-foreground">状态变化</dt><dd>{selectedEvent.prior ?? "未记录"} → {selectedEvent.next ?? "未记录"}</dd>
      <dt className="text-muted-foreground">打开</dt>
      <dd>{(() => {
        if (source === "fixture") return "夹具事件没有真实对象";
        const info = openInfo?.(selectedEvent) ?? { targets: [], notes: [], pr: null };
        if (!info.targets.length && !info.notes.length) return "这类对象没有单独的页面";
        return <span className="flex flex-col gap-0.5">
          {info.targets.length > 0 && <span className="flex flex-wrap gap-x-3">{info.targets.map(t => <a key={t.href} className="text-accent-foreground underline" href={t.href} data-open="">{t.label}</a>)}</span>}
          {info.notes.map(note => <span key={note} className="text-caption text-muted-foreground" data-open-note="">{note}</span>)}
        </span>;
      })()}</dd>
      {source === "live" && openInfo?.(selectedEvent)?.pr && <><dt className="text-muted-foreground">PR</dt><dd data-pr="">{openInfo(selectedEvent)!.pr}</dd></>}
    </dl>;
  })() : selected?.type === "node" ? (() => {
    if (source === "fixture" || !nodeInfo) return <p className="text-small" data-node-detail="">{selected.id}：{selected.id.startsWith("session:") ? sessionStatus(selected.id.slice(8)).text : "固定节点"}。夹具节点没有真实对象。</p>;
    const info = nodeInfo(selected.id);
    return <div className="flex flex-col gap-1 text-small" data-node-detail="" aria-label="节点详情">
      <p className="m-0 font-medium">{info.title}</p>
      {info.lines.map(line => <p key={line} className="m-0 text-muted-foreground">{line}</p>)}
      {info.targets.length > 0 && <span className="flex flex-wrap gap-x-3">{info.targets.map(t => <a key={t.href} className="text-accent-foreground underline" href={t.href} data-open="">{t.label}</a>)}</span>}
      {info.notes.map(note => <span key={note} className="text-caption text-muted-foreground" data-open-note="">{note}</span>)}
    </div>;
  })() : <p className="text-small text-muted-foreground">点画面上的节点或列表里的一行，看详情。</p>;

  const controls = (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="回放与筛选">
      {live && <Button size="compact" onClick={() => start("live")} aria-pressed={mode === "live"} className="gap-1.5"><Radio aria-hidden="true" className="size-4" />实时</Button>}
      <Button size="compact" onClick={() => start("paused")} aria-pressed={mode === "paused"} className="gap-1.5"><Pause aria-hidden="true" className="size-4" />暂停</Button>
      <Button size="compact" onClick={() => start("replay")} aria-pressed={mode === "replay"} className="gap-1.5">
        <Play aria-hidden="true" className="size-4" />{mode !== "replay" && cursor + 1 >= events.length ? "从头回放" : "回放"}</Button>
      <label className="flex items-center gap-2 text-label">时间
        <input type="range" min={0} max={Math.max(0, events.length - 1)} value={Math.max(0, cursor)} aria-valuetext={lastTime ? new Date(lastTime).toLocaleTimeString("zh-CN", { hour12: false }) : "未开始"}
          onChange={e => { setFresh([]); setStored(Number(e.target.value)); setMode("paused"); }} className="w-40" /></label>
      {GROUPS.map(g => <Button size="compact" key={g.id} aria-pressed={!hidden.has(g.id)} onClick={() => toggle(g.id)}
        className={cn(hidden.has(g.id) && "text-muted-foreground line-through")}>{g.label}</Button>)}
      <Button size="compact" variant="ghost" aria-pressed={stuckOnly} onClick={() => setStuckOnly(v => !v)} className={cn(stuckOnly && "bg-accent font-semibold text-foreground hover:bg-accent")}>只看卡住的</Button>
    </div>);

  const connectionText = !connection ? null
    : connection.state === "loading" ? "正在读取快照与事件…"
      : connection.state === "live" ? `已连接，按序号接收（到 #${connection.lastSeq}）${connection.reconnects ? ` · 已重连 ${connection.reconnects} 次` : ""}`
        : connection.state === "reconnecting" ? `连接中断，正在按序号续传（从 #${connection.lastSeq} 之后）`
          : `读不到：${connection.error || "未知原因"}`;

  const header = <div className="flex flex-wrap items-baseline justify-between gap-2">
    <h2 className="text-heading font-semibold">动态</h2>
    {source === "fixture" && <p role="note" className="rounded-md bg-warning-soft px-2.5 py-1 text-label text-warning">夹具数据 · 非真实：这些事件是手写的，不来自任何实例</p>}
    <p className="text-caption text-muted-foreground">已显示 {shown.length} / {events.length} 条事件{lastTime ? ` · 到 ${new Date(lastTime).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}{windowNote ? ` · ${windowNote}` : ""}</p>
    {connectionText && <p role="status" data-connection={connection!.state} className={cn("basis-full text-label", connection!.state === "live" ? "text-text-secondary" : connection!.state === "loading" ? "text-muted-foreground" : "text-warning")}>
      <span aria-hidden="true">{connection!.state === "live" ? "● " : connection!.state === "loading" ? "… " : "! "}</span>{connectionText}</p>}
    {live && mode === "paused" && newer > 0 && <p role="status" className="basis-full text-label text-muted-foreground">画面停在这里；之后又来了 {newer} 条事件。<Button variant="link" size="compact" onClick={() => start("live")}>回到实时</Button></p>}
  </div>;

  const windowLabel = windowHours ? `近 ${windowHours} 小时` : "窗口内";
  const trackItems = <ol className="flex flex-wrap gap-2" aria-label="对象轨道">
    {stations.map((s, i) => <li key={s.station} className="flex items-center gap-1.5 text-small"><span className="text-muted-foreground" aria-hidden="true">{i ? "→" : ""}</span>
      <Button variant="row" data-node={stationNode(s.station)} aria-pressed={selected?.type === "node" && selected.id === stationNode(s.station)} onClick={() => setSelected({ type: "node", id: stationNode(s.station) })}
        className={cn("flex h-auto items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-small", selected?.type === "node" && selected.id === stationNode(s.station) && "bg-accent")}>
        <span>{s.station}</span><span className="tabular-nums font-medium">{s.count === null ? "读不到" : s.count}</span>
        {s.note && <span className="text-caption text-muted-foreground" data-station-note="">{s.note}</span>}
        {s.station === "已验收" && <span className="text-caption text-muted-foreground" data-station-window="">{windowLabel}</span>}</Button></li>)}</ol>;

  if (narrow) {
    return <section className="flex flex-col gap-4" aria-label="动态（窄屏泳道）" data-layout="lanes">
      {header}{controls}
      <ul className="flex flex-col gap-2" aria-label="节点">
        {PEOPLE.map(p => <li key={p.id}><Button variant="row" data-node={p.id} aria-pressed={selected?.type === "node" && selected.id === p.id} onClick={() => setSelected({ type: "node", id: p.id })} className="flex h-auto w-full flex-col items-start rounded-lg bg-card px-3 py-2 text-left border border-border">
          <span className="block text-small font-medium">{p.label}</span><span className="text-caption text-muted-foreground">{p.sub}</span></Button></li>)}
        <li><Button variant="row" data-node="packets" aria-pressed={selected?.type === "node" && selected.id === "packets"} onClick={() => setSelected({ type: "node", id: "packets" })} className="flex h-auto w-full flex-col items-start rounded-lg bg-card px-3 py-2 text-left border border-border">
          <span className="block text-small font-medium">通知包托盘</span><span className="text-caption text-muted-foreground">开放 {board.graph.counts.openPackets ?? "读不到"}</span></Button></li>
        <li><Button variant="row" data-node="leader" onClick={() => setSelected({ type: "node", id: "leader" })} className="flex h-auto w-full flex-col items-start rounded-lg bg-card px-3 py-2 text-left border border-border">
          <span className="block text-small font-medium">Leader</span><span className="text-caption text-muted-foreground">{stuck.length ? `${stuck.length} 处卡住` : "没有读到卡住的地方"}</span></Button></li>
        {sessions.map(s => { const st = sessionStatus(s.sessionId); return <li key={s.sessionId}>
          <Button variant="row" data-node={`session:${s.sessionId}`} onClick={() => setSelected({ type: "node", id: `session:${s.sessionId}` })} className="flex h-auto w-full flex-col items-start rounded-lg bg-card px-3 py-2 text-left border border-border">
            <span className="block truncate text-small font-medium">{s.roleTitle ?? s.roleId}</span>
            <span className="text-caption text-muted-foreground"><span aria-hidden="true">{st.glyph} </span>{st.text}{s.current?.taskTitle ? ` · ${s.current.taskTitle}` : ""}</span></Button></li>; })}
      </ul>
      {trackItems}{detail}{eventList}</section>;
  }

  return (
    <section className="flex flex-col gap-4" aria-label="动态" data-layout="canvas">
      {header}{controls}
      <div className="relative w-full overflow-hidden rounded-xl bg-sunken" style={{ aspectRatio: `${W} / ${H}` }} data-stage="">
        <svg viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" focusable="false">
          {/* paths: drawn faintly; a packet lights its path while it travels */}
          {[...new Set(shown.slice(-40).map(e => { const r = routeOf(e, context); return `${r.from}>${r.to}`; }))].map(key => { const [from, to] = key.split(">") as [NodeId, NodeId]; return <path key={key} d={pathOf(from, to)} fill="none" stroke="var(--border-strong)" strokeWidth={1.5} />; })}
          {packets.map(p => <PacketMark key={p.key} packet={p} d={pathOf(p.from, p.to)} onSelect={() => setSelected({ type: "event", seq: p.event.seq })} />)}
          {/* the object track */}
          <line x1={60} x2={W - 60} y1={582} y2={582} stroke="currentColor" strokeWidth={2} className="text-border" />
          {stations.map((s, i) => { const x = 100 + i * ((W - 200) / (STATIONS.length - 1)); return <g key={s.station}><circle cx={x} cy={582} r={7} fill="currentColor" className="text-card" stroke="currentColor" strokeWidth={2} /></g>; })}
        </svg>
        {PEOPLE.map(p => <NodeButton key={p.id} id={p.id} label={`${p.label}：${p.sub}`}><span className="truncate text-small font-medium">{p.label}</span><span className="truncate text-caption text-muted-foreground">{p.sub}</span></NodeButton>)}
        <div style={pct(BOARD)} className="absolute rounded-lg bg-card p-3 border border-border" role="group" aria-label="调度板">
          <p className="text-label font-medium">调度板</p>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-small">
            {stations.slice(0, 4).map(s => <div key={s.station} className="flex justify-between"><dt className="text-muted-foreground">{s.station}</dt><dd className="tabular-nums">{s.count === null ? "读不到" : s.count}</dd></div>)}
            <div className="col-span-2 flex justify-between"><dt className="text-muted-foreground">卡住的地方</dt><dd className={cn("tabular-nums", stuck.length && "text-destructive")}>{stuck.length}</dd></div>
          </dl>
          {stuck.slice(0, 2).map(s => <p key={s.text} className="truncate text-caption text-destructive"><span aria-hidden="true">! </span>{s.text}</p>)}
        </div>
        <NodeButton id="leader" label="Leader"><span className="text-small font-medium">Leader</span><span className="text-caption text-muted-foreground">{board.sessions.length ? `${board.graph.counts.queuedMessages ?? "读不到"} 条消息排队` : "读不到"}</span></NodeButton>
        <NodeButton id="packets" label="通知包托盘"><span className="text-small">通知包</span><span className="text-caption text-muted-foreground">开放 {board.graph.counts.openPackets ?? "读不到"}</span></NodeButton>
        {sessions.slice(0, MAX_SESSIONS).map(s => { const st = sessionStatus(s.sessionId); return <NodeButton key={s.sessionId} id={`session:${s.sessionId}`} label={`${s.roleTitle ?? s.roleId}：${st.text}`}>
          <span className="truncate text-small font-medium">{s.roleTitle ?? s.roleId}</span>
          <span className="truncate text-caption text-muted-foreground"><span aria-hidden="true">{st.glyph} </span>{st.text}{s.current?.taskTitle ? ` · ${s.current.taskTitle}` : ""}</span></NodeButton>; })}
        {sessions.length > MAX_SESSIONS && <p className="absolute right-6 bottom-24 text-caption text-muted-foreground">另有 {sessions.length - MAX_SESSIONS} 个 Session，见“统筹安排”</p>}
        <ol aria-label="对象轨道">
          {stations.map((s, i) => <li key={s.station} className="absolute bottom-2 flex -translate-x-1/2 flex-col items-center text-caption" style={{ left: `${((100 + i * ((W - 200) / (STATIONS.length - 1))) / W) * 100}%` }}>
            <Button variant="row" data-node={stationNode(s.station)} aria-pressed={selected?.type === "node" && selected.id === stationNode(s.station)} onClick={() => setSelected({ type: "node", id: stationNode(s.station) })}
              className={cn("flex h-auto flex-col items-center rounded-md px-1.5 py-0.5 text-caption", selected?.type === "node" && selected.id === stationNode(s.station) && "bg-accent")}>
              <span className="tabular-nums font-medium">{s.count === null ? "读不到" : s.count}</span><span className="text-muted-foreground">{s.station}</span>{s.note && <span className="text-muted-foreground" data-station-note="">{s.note}</span>}{s.station === "已验收" && <span className="text-muted-foreground" data-station-window="">{windowLabel}</span>}</Button></li>)}
        </ol>
      </div>
      <div className="grid gap-4 @2xl:grid-cols-2 md:grid-cols-2"><div>{eventList}</div><div>{detail}</div></div>
    </section>);
}

function PacketMark({ packet, d, onSelect }: { packet: Packet; d: string; onSelect: () => void }) {
  const cls = tone[packet.style.tone];
  // The svg is hidden from assistive technology and does not take the pointer; a packet does, so it can be clicked. The same event is a row of
  // the event list, which is the keyboard and screen-reader way to it.
  return <g className={cn(cls, "pointer-events-auto cursor-pointer")} data-packet={packet.key} data-seq={packet.event.seq} onClick={onSelect}>
    <circle r={9} fill="currentColor" className="opacity-20" /><circle r={5} fill="currentColor" />
    <text x={10} y={4} className="text-caption" fill="currentColor" aria-hidden="true">{packet.folded > 1 ? `×${packet.folded}` : packet.style.glyph}</text>
    <animateMotion dur={`${PACKET_MS}ms`} path={d} fill="freeze" />
  </g>;
}
