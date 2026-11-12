// 统筹安排 › 动态 (DEC-045 F1): the scheduling flow as a picture. This file is the skeleton of the first segment: the layout, the
// event-to-picture mapping, the replay controls and the accessibility rules, driven by whatever `events` and `board` it is given.
// It reads nothing by itself. The sample route (/ui/flow) gives it hand-written fixtures and the page says so on screen.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { Button, cn } from "@evoloop/ui";
import type { SchedEvent, WorkBoardSnapshot } from "@evoloop/contracts/work-board";
import {
  GROUPS, PEOPLE, STATIONS, foldPackets, isStuck, routeOf, stationCounts, stuckSpots, styleOf, upTo,
  type FlowContext, type FlowGroup, type FlowTone, type NodeId, type Packet,
} from "./flowModel";

/** The most packets on the canvas at once; more are merged into one "×N" (docs/frontend/pages/flow-view.md 性能预算). */
export const MAX_PACKETS = 12;
const PACKET_MS = 1400;
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
const centre = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];
const pct = (b: Box) => ({ left: `${(b.x / W) * 100}%`, top: `${(b.y / H) * 100}%`, width: `${(b.w / W) * 100}%`, height: `${(b.h / H) * 100}%` });

export interface FlowViewProps {
  board: WorkBoardSnapshot; events: SchedEvent[]; context: FlowContext;
  /** "fixture": shown with the on-screen notice that nothing here is read from an instance. */
  source: "fixture" | "live";
  /** Replay starts at this many events shown (default: all). */
  startAt?: number;
}

export function FlowView({ board, events, context, source, startAt }: FlowViewProps) {
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const narrow = useMedia("(max-width: 640px)");
  const [cursor, setCursor] = useState(Math.min(events.length, startAt ?? events.length) - 1);
  const [playing, setPlaying] = useState(false);
  const [hidden, setHidden] = useState<Set<FlowGroup>>(new Set());
  const [stuckOnly, setStuckOnly] = useState(false);
  const [selected, setSelected] = useState<{ type: "event"; seq: number } | { type: "node"; id: NodeId } | null>(null);
  const [fresh, setFresh] = useState<SchedEvent[]>([]);
  const [flash, setFlash] = useState<Set<NodeId>>(new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  // Advancing: one timer, only while playing and the tab is in front. What is shown is a function of the cursor, so a tab that was in the
  // background loses nothing: when it returns the state is whatever the events up to the cursor say.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setCursor(current => {
        if (current + 1 >= events.length) { setPlaying(false); return current; }
        const next = events[current + 1]!;
        setFresh(list => [...list.filter(e => e.seq !== next.seq), next].slice(-MAX_PACKETS * 2));
        const route = routeOf(next, context);
        if (reduced) { setFlash(new Set([route.from, route.to])); timers.current.push(window.setTimeout(() => setFlash(new Set()), STEP_MS)); }
        timers.current.push(window.setTimeout(() => setFresh(list => list.filter(e => e.seq !== next.seq)), PACKET_MS));
        return current + 1;
      });
    }, STEP_MS);
    return () => window.clearInterval(id);
  }, [playing, events, context, reduced]);

  const shown = useMemo(() => upTo(events, cursor), [events, cursor]);
  const visible = useMemo(() => shown.filter(e => !hidden.has(styleOf(e.kind).group) && (!stuckOnly || isStuck(e))), [shown, hidden, stuckOnly]);
  const stuck = useMemo(() => stuckSpots(board), [board]);
  const stations = useMemo(() => stationCounts(board, shown.filter(e => e.kind === "acceptance.closed").length), [board, shown]);
  const packets = useMemo(() => reduced ? [] : foldPackets(fresh.filter(e => !hidden.has(styleOf(e.kind).group)), context, MAX_PACKETS), [fresh, hidden, context, reduced]);
  const sessions = board.sessions;
  const nodeBox = (id: NodeId): Box => {
    if (id === "leader") return LEADER; if (id === "packets") return TRAY;
    if (id.startsWith("people.")) return PEOPLE_BOX(Math.max(0, PEOPLE.findIndex(p => p.id === id)));
    const i = sessions.findIndex(s => `session:${s.sessionId}` === id);
    return sessionBox(Math.max(0, Math.min(i, MAX_SESSIONS - 1)), sessions.length);
  };
  const pathOf = (from: NodeId, to: NodeId): string => {
    const [ax, ay] = centre(nodeBox(from)), [bx, by] = centre(nodeBox(to)), mid = (ax + bx) / 2;
    return `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}`;
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
      className={cn("absolute flex h-auto min-w-0 flex-col items-start justify-center gap-0.5 rounded-lg bg-card px-3 text-left shadow-sm hover:bg-card", flash.has(id) && "bg-accent", selected?.type === "node" && selected.id === id && "bg-selected", className)}>
      {children}
    </Button>);

  const eventList = (
    <ol className="flex max-h-96 flex-col overflow-y-auto" aria-label="事件列表">
      {visible.length === 0 && <li className="py-3 text-small text-muted-foreground">{shown.length === 0 ? "还没有事件" : "筛选后没有事件"}</li>}
      {[...visible].reverse().map(e => {
        const st = styleOf(e.kind), route = routeOf(e, context);
        return <li key={e.seq}>
          <Button variant="row" data-event={e.seq} aria-pressed={selected?.type === "event" && selected.seq === e.seq} onClick={() => setSelected({ type: "event", seq: e.seq })}
            className={cn("flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-small", selected?.type === "event" && selected.seq === e.seq ? "bg-selected" : "hover:bg-muted")}>
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
      <dd>{selectedEvent.subject.link ? <a className="text-accent-foreground underline" href={selectedEvent.subject.link}>打开对象</a> : source === "fixture" ? "夹具事件没有真实对象" : "这类对象没有单独的页面"}</dd>
    </dl>;
  })() : selected?.type === "node" ? <p className="text-small">{selected.id}：{selected.id.startsWith("session:") ? sessionStatus(selected.id.slice(8)).text : "固定节点"}</p> : <p className="text-small text-muted-foreground">点画面上的节点或列表里的一行，看详情。</p>;

  const controls = (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="回放与筛选">
      <Button size="compact" onClick={() => setPlaying(p => !p)} aria-pressed={playing} className="gap-1.5">
        {playing ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-4" />}{playing ? "暂停" : cursor + 1 >= events.length ? "从头回放" : "回放"}</Button>
      <label className="flex items-center gap-2 text-label">时间
        <input type="range" min={0} max={Math.max(0, events.length - 1)} value={Math.max(0, cursor)} aria-valuetext={lastTime ? new Date(lastTime).toLocaleTimeString("zh-CN", { hour12: false }) : "未开始"}
          onChange={e => { setPlaying(false); setFresh([]); setCursor(Number(e.target.value)); }} className="w-40" /></label>
      {GROUPS.map(g => <Button size="compact" key={g.id} aria-pressed={!hidden.has(g.id)} onClick={() => toggle(g.id)}
        className={cn(hidden.has(g.id) && "text-muted-foreground line-through")}>{g.label}</Button>)}
      <Button size="compact" aria-pressed={stuckOnly} onClick={() => setStuckOnly(v => !v)} className={cn(stuckOnly && "bg-selected")}>只看卡住的</Button>
    </div>);

  const header = <div className="flex flex-wrap items-baseline justify-between gap-2">
    <h2 className="text-heading font-semibold">动态</h2>
    {source === "fixture" && <p role="note" className="rounded-md bg-warning-soft px-2.5 py-1 text-label text-warning">夹具数据 · 非真实：这些事件是手写的，不来自任何实例</p>}
    <p className="text-caption text-muted-foreground">已显示 {shown.length} / {events.length} 条事件{lastTime ? ` · 到 ${new Date(lastTime).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}</p>
  </div>;

  const trackItems = <ol className="flex flex-wrap gap-2" aria-label="对象轨道">
    {stations.map((s, i) => <li key={s.station} className="flex items-center gap-1.5 text-small"><span className="text-muted-foreground" aria-hidden="true">{i ? "→" : ""}</span>
      <span>{s.station}</span><span className="tabular-nums font-medium">{s.count === null ? "读不到" : s.count}</span></li>)}</ol>;

  if (narrow) {
    return <section className="flex flex-col gap-4" aria-label="动态（窄屏泳道）" data-layout="lanes">
      {header}{controls}
      <ul className="flex flex-col gap-2" aria-label="节点">
        <li><Button variant="row" data-node="leader" onClick={() => setSelected({ type: "node", id: "leader" })} className="flex h-auto w-full flex-col items-start rounded-lg bg-card px-3 py-2 text-left shadow-sm">
          <span className="block text-small font-medium">Leader</span><span className="text-caption text-muted-foreground">{stuck.length ? `${stuck.length} 处卡住` : "没有读到卡住的地方"}</span></Button></li>
        {sessions.map(s => { const st = sessionStatus(s.sessionId); return <li key={s.sessionId}>
          <Button variant="row" data-node={`session:${s.sessionId}`} onClick={() => setSelected({ type: "node", id: `session:${s.sessionId}` })} className="flex h-auto w-full flex-col items-start rounded-lg bg-card px-3 py-2 text-left shadow-sm">
            <span className="block truncate text-small font-medium">{s.roleTitle ?? s.roleId}</span>
            <span className="text-caption text-muted-foreground"><span aria-hidden="true">{st.glyph} </span>{st.text}{s.current?.taskTitle ? ` · ${s.current.taskTitle}` : ""}</span></Button></li>; })}
      </ul>
      {trackItems}{detail}{eventList}</section>;
  }

  return (
    <section className="flex flex-col gap-4" aria-label="动态" data-layout="canvas">
      {header}{controls}
      <div className="relative w-full overflow-hidden rounded-xl bg-sunken" style={{ aspectRatio: `${W} / ${H}` }} data-stage="">
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" aria-hidden="true" focusable="false">
          {/* paths: drawn faintly; a packet lights its path while it travels */}
          {[...new Set(shown.slice(-40).map(e => { const r = routeOf(e, context); return `${r.from}>${r.to}`; }))].map(key => { const [from, to] = key.split(">") as [NodeId, NodeId]; return <path key={key} d={pathOf(from, to)} fill="none" stroke="currentColor" strokeWidth={1} className="text-border" />; })}
          {packets.map(p => <PacketMark key={p.key} packet={p} d={pathOf(p.from, p.to)} />)}
          {/* the object track */}
          <line x1={60} x2={W - 60} y1={582} y2={582} stroke="currentColor" strokeWidth={2} className="text-border" />
          {stations.map((s, i) => { const x = 100 + i * ((W - 200) / (STATIONS.length - 1)); return <g key={s.station}><circle cx={x} cy={582} r={7} fill="currentColor" className="text-card" stroke="currentColor" strokeWidth={2} /></g>; })}
        </svg>
        {PEOPLE.map(p => <NodeButton key={p.id} id={p.id} label={`${p.label}：${p.sub}`}><span className="truncate text-small font-medium">{p.label}</span><span className="truncate text-caption text-muted-foreground">{p.sub}</span></NodeButton>)}
        <div style={pct(BOARD)} className="absolute rounded-lg bg-card p-3 shadow-sm" role="group" aria-label="调度板">
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
            <span className="tabular-nums font-medium">{s.count === null ? "读不到" : s.count}</span><span className="text-muted-foreground">{s.station}</span></li>)}
        </ol>
      </div>
      <div className="grid gap-4 @2xl:grid-cols-2 md:grid-cols-2"><div>{eventList}</div><div>{detail}</div></div>
    </section>);
}

function PacketMark({ packet, d }: { packet: Packet; d: string }) {
  const cls = tone[packet.style.tone];
  return <g className={cls} data-packet={packet.key}>
    <circle r={9} fill="currentColor" className="opacity-20" /><circle r={5} fill="currentColor" />
    <text x={10} y={4} className="text-caption" fill="currentColor" aria-hidden="true">{packet.folded > 1 ? `×${packet.folded}` : packet.style.glyph}</text>
    <animateMotion dur={`${PACKET_MS}ms`} path={d} fill="freeze" />
  </g>;
}
