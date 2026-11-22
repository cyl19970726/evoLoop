// The small card on 总览: where scheduling is stuck right now and the latest few events, from the same snapshot and event reads as 动态. It
// reads once (and again on request); it does not subscribe. It links to 统筹安排 › 动态.
import { Component, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button, cn } from "@evoloop/ui";
import { useProjectQuery } from "../../../shared/query";
import { errorText } from "../../../shared/api";
import { href } from "../../../shared/ui/shared";
import { readBoard, readEventsPage } from "./flowClient";
import { isStuck, stuckSpots, styleOf } from "./flowModel";

export const flowHref = (projectId: string) => `${href(projectId, "arrangement")}?view=flow`;

/** The card is an extra on 总览: if it ever fails to draw, it says so and the page around it stays. */
class GlanceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("调度动态小卡片没能显示", error); }
  render() { return this.state.failed ? <p role="status" className="rounded-xl bg-raised px-4 py-3 text-small text-warning border border-border">调度动态小卡片没能显示；总览的其余内容不受影响。</p> : this.props.children; }
}

export function FlowGlance(props: { token: string; projectId: string; active: boolean }) {
  return <GlanceBoundary><FlowGlanceCard {...props} /></GlanceBoundary>;
}

function FlowGlanceCard({ token, projectId, active }: { token: string; projectId: string; active: boolean }) {
  const read = useProjectQuery(projectId, ["flow-glance"], async signal => {
    const board = await readBoard(token, projectId, signal);
    // The newest events: the page just before the head.
    const head = await readEventsPage(token, projectId, { after: Math.max(0, board.eventSeq - 8), limit: 8 }, signal);
    return { board, events: head.items.slice(-5).reverse(), observedAt: new Date().toISOString() };
  }, { enabled: active, refetchInterval: 30_000 });
  const stuck = read.data ? stuckSpots(read.data.board) : [];
  const time = (at: string) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return <section aria-label="调度动态" className="overview-flow flex min-w-0 flex-col gap-2 rounded-xl bg-raised px-4 py-3 border border-border compact:px-5">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-label font-semibold text-foreground">调度动态</h2>
      <span className="flex items-center gap-2">
        <Button size="compact" variant="ghost" onClick={() => void read.refetch()} disabled={read.isFetching} aria-label="重新读取调度动态"><RefreshCw aria-hidden="true" className={cn("size-4", read.isFetching && "animate-spin")} /></Button>
        <a href={flowHref(projectId)} className="text-caption text-accent-foreground underline">查看动态</a>
      </span>
    </div>
    {read.isError && !read.data && <p role="status" className="text-small text-warning">读不到调度板：{errorText(read.error)}</p>}
    {read.isError && read.data && <p role="status" className="text-caption text-warning">重新读取失败，下面是上次读回的内容。</p>}
    {!read.data && !read.isError && <p className="text-small text-muted-foreground">正在读取调度板…</p>}
    {read.data && <>
      <div>
        <h3 className="text-caption font-semibold text-muted-foreground">此刻卡住的地方 · {stuck.length}</h3>
        {stuck.length ? <ul className="mt-1 flex flex-col gap-0.5">{stuck.slice(0, 4).map(s => <li key={s.text} className="truncate text-small text-destructive"><span aria-hidden="true">! </span>{s.text}</li>)}</ul>
          : <p className="mt-1 text-small text-muted-foreground">调度板上没有读到卡住的地方。</p>}
      </div>
      <div>
        <h3 className="text-caption font-semibold text-muted-foreground">最近事件</h3>
        {read.data.events.length ? <ul className="mt-1 flex flex-col gap-0.5">{read.data.events.map(e => { const st = styleOf(e.kind); return <li key={e.seq} className="flex items-baseline gap-2 text-small">
          <span aria-hidden="true" className="w-4 shrink-0 text-center text-text-secondary">{st.glyph}</span>
          <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{time(e.at)}</span>
          <span className="min-w-0 flex-1 truncate">{st.known ? st.label : `未知事件 ${e.kind}`}{e.subject.title ? `：${e.subject.title}` : ""}</span>
          {isStuck(e) && <span className="shrink-0 text-caption text-destructive">卡住</span>}</li>; })}</ul>
          : <p className="mt-1 text-small text-muted-foreground">还没有事件。</p>}
      </div>
    </>}
  </section>;
}
