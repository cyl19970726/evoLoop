// The roadmap-phase block the overview used to draw (the six phases of docs/roadmap.md). Not rendered any more: the overview's 阶段 block reads the project's own
// stages (features/stages). Kept, with GET /milestones, until the clean-up step (milestones-design.md §8, item 7) removes both.
import * as React from "react";
import { api, errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { href } from "../../shared/ui/shared";
import { NOT_REGISTERED, milestoneRows } from "./milestonesPresentation";
import { readOverviewParam, writeOverviewParam } from "./overviewAddress";

const card = "flex min-w-0 flex-col gap-1.5 rounded-xl bg-raised px-4 py-2.5 border border-border compact:px-5";
const muted = "text-caption text-muted-foreground";
const heading = "text-label font-semibold text-foreground";
const toneClass = { done: "text-done", progress: "text-running", partial: "text-warning", idle: "text-text-secondary", none: "text-muted-foreground" } as const;

export function LegacyMilestones({ projectId, active }: { projectId: string; active: boolean }) {
  const milestones = useProjectQuery(projectId, ["overview", "milestones"], signal => api().milestones(projectId, signal), { enabled: active, retry: false });
  const rows = milestoneRows(milestones.data ?? null);
  const [open, setOpen] = React.useState(() => readOverviewParam("milestones") === "open");
  const unreadable = milestones.isError || (milestones.data && milestones.data.source.roadmap === "unavailable");
  return (
      <section className={`${card} @container`} aria-label="里程碑" data-overview-milestones="">
        <div className="flex flex-wrap items-baseline gap-x-3"><h2 className={heading}>重要里程碑（路线图，共 {rows.length || 6} 个阶段）</h2>
          {milestones.data && !unreadable && <span className={muted} data-current-note="">{milestones.data.currentNote ?? ""}</span>}</div>
        {milestones.isPending && <p className={muted} role="status">正在读取里程碑…</p>}
        {unreadable && <p className={muted} role="status">{milestones.isError ? `里程碑这次没有读到（${errorText(milestones.error)}）。` : "路线图读不到，里程碑无法显示。"}</p>}
        {!unreadable && rows.length > 0 && <details data-milestones-detail="" className="group" open={open} onToggle={event => { const next = event.currentTarget.open; if (next === open) return; setOpen(next); if (active) writeOverviewParam("milestones", next ? "open" : null); }}>
          <summary className="cursor-pointer text-small text-text-secondary" data-milestones-summary="">{(() => { const cur = rows.find(row => row.current); return cur ? `当前：${cur.id} ${cur.title} · ${cur.status}` : "没有单一的当前阶段"; })()} · 展开全部 {rows.length} 个阶段</summary>
          <div aria-hidden="true" className="hidden gap-x-3 px-2 text-caption text-muted-foreground @3xl:grid @3xl:grid-cols-[9rem_minmax(0,1.2fr)_minmax(0,1.5fr)_6rem_7rem]">
            <span>阶段</span><span>要交付什么</span><span>退出证据</span><span>状态</span><span>节点日期</span></div>
          <ol className="m-0 flex list-none flex-col p-0">
            {rows.map(row => <li key={row.id} data-phase={row.id} data-current={row.current ? "true" : undefined} aria-current={row.current ? "step" : undefined}
              className={`grid grid-cols-[minmax(0,1fr)_auto] items-center @sm:grid-cols-[minmax(0,1fr)_auto_7.5rem] gap-x-2 border-t border-border px-2 py-1 first:border-t-0 @3xl:grid-cols-[9rem_minmax(0,1.2fr)_minmax(0,1.5fr)_6rem_7rem] @3xl:gap-x-3 ${row.current ? "bg-accent font-semibold" : ""}`}>
              <span className="col-start-1 row-start-1 min-w-0 text-small font-medium @3xl:col-start-1 @3xl:row-start-1">
                {row.stageId ? <a className="text-primary hover:underline" href={`${href(projectId, "journey")}?stage=${row.stageId}`}>{row.id} {row.title}</a> : <span>{row.id} {row.title}</span>}
                {row.current && <span className="ml-1 text-caption font-semibold text-primary">当前</span>}</span>
              <span className={`${row.current ? "hidden @sm:block " : "hidden @3xl:block "}col-start-1 row-start-2 line-clamp-1 text-caption text-text-secondary @3xl:col-start-2 @3xl:row-start-1 @3xl:line-clamp-2 @3xl:text-small`}><span className="@3xl:hidden">交付：</span>{row.deliver}</span>
              <span className={`${row.current ? "hidden @sm:block " : "hidden @3xl:block "}col-span-2 @sm:col-span-3 col-start-1 row-start-3 line-clamp-1 text-caption text-text-secondary @3xl:col-span-1 @3xl:col-start-3 @3xl:row-start-1 @3xl:line-clamp-2 @3xl:text-small`}><span className="@3xl:hidden">退出证据：</span>{row.exit}</span>
              <span className="col-start-2 row-start-1 justify-self-end @3xl:col-start-4 @3xl:row-start-1 @3xl:justify-self-start"><span className={`inline-block whitespace-nowrap text-caption font-medium ${toneClass[row.tone]}`}>{row.status}</span></span>
              <span className="hidden @sm:block @sm:col-start-3 @sm:row-start-1 col-start-2 row-start-2 justify-self-end whitespace-nowrap text-caption text-text-secondary @3xl:col-start-5 @3xl:row-start-1 @3xl:justify-self-start @3xl:text-small">{row.date === NOT_REGISTERED ? NOT_REGISTERED : row.date}</span>
            </li>)}
          </ol></details>}
      </section>
  );
}
