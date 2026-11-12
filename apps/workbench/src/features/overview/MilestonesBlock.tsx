// The overview's version and milestone blocks (docs/frontend/overview-top-design.md): the deployed version on the left, the six roadmap phases
// on the right, only the current one highlighted. The version comes from GET /api/version, the phases from GET /projects/:id/milestones.
import { api, errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { href } from "../../shared/ui/shared";
import { NOT_REGISTERED, milestoneRows, versionView } from "./milestonesPresentation";

const card = "flex min-w-0 flex-col gap-1.5 rounded-xl bg-raised px-4 py-3 shadow-sm compact:gap-2 compact:p-5";
const muted = "text-caption text-muted-foreground";
const heading = "text-label font-semibold text-foreground";
const toneClass = { done: "bg-success-soft text-success", progress: "bg-selected text-primary", partial: "bg-warning-soft text-warning", idle: "bg-field text-text-secondary", none: "border border-dashed border-border text-text-secondary" } as const;

export function MilestonesBlock({ projectId, active }: { projectId: string; active: boolean }) {
  const version = useProjectQuery(projectId, ["overview", "version"], signal => api().version(signal), { enabled: active, retry: false });
  const milestones = useProjectQuery(projectId, ["overview", "milestones"], signal => api().milestones(projectId, signal), { enabled: active, retry: false });
  const v = versionView(version.data ?? null);
  const rows = milestoneRows(milestones.data ?? null);
  const unreadable = milestones.isError || (milestones.data && milestones.data.source.roadmap === "unavailable");
  return <div className="@container" data-overview-top="">
    <div className="grid gap-3 @2xl:grid-cols-[14rem_minmax(0,1fr)]">
      <section className={card} aria-label="线上当前版本" data-overview-version="">
        <h2 className={heading}>线上当前版本</h2>
        {version.isPending && <p className={muted} role="status">正在读取版本…</p>}
        {!version.isPending && <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 text-small">
          <dt className={muted}>源码提交</dt><dd className="m-0">{v.readable ? <code className="rounded-sm bg-field px-1.5 font-mono text-caption">{v.commit}</code> : <span className="text-text-secondary">{v.commit}</span>}</dd>
          <dt className={muted}>构建时间</dt><dd className="m-0 text-foreground">{v.builtAt}</dd>
          <dt className={muted}>启动时间</dt><dd className="m-0 text-foreground">{v.startedAt}</dd>
        </dl>}
        {version.isError && <p className={muted} role="status">版本接口这次没有读到（{errorText(version.error)}）；不显示旧版本。</p>}
        <p className="m-0 flex flex-wrap gap-x-2 text-caption">{v.links.map(link => <a key={link.href} className="text-primary hover:underline" href={link.href} target="_blank" rel="noreferrer">{link.label}</a>)}</p>
      </section>
      <section className={`${card} @container`} aria-label="里程碑" data-overview-milestones="">
        <div className="flex flex-wrap items-baseline gap-x-3"><h2 className={heading}>重要里程碑（路线图，共 {rows.length || 6} 个阶段）</h2>
          {milestones.data && !unreadable && <span className={muted} data-current-note="">{milestones.data.currentNote ?? ""}</span>}</div>
        {milestones.isPending && <p className={muted} role="status">正在读取里程碑…</p>}
        {unreadable && <p className={muted} role="status">{milestones.isError ? `里程碑这次没有读到（${errorText(milestones.error)}）。` : "路线图读不到，里程碑无法显示。"}</p>}
        {!unreadable && rows.length > 0 && <>
          <div aria-hidden="true" className="hidden gap-x-3 px-2 text-caption text-muted-foreground @3xl:grid @3xl:grid-cols-[9rem_minmax(0,1.2fr)_minmax(0,1.5fr)_6rem_7rem]">
            <span>阶段</span><span>要交付什么</span><span>退出证据</span><span>状态</span><span>节点日期</span></div>
          <ol className="m-0 flex list-none flex-col p-0">
            {rows.map(row => <li key={row.id} data-phase={row.id} data-current={row.current ? "true" : undefined} aria-current={row.current ? "step" : undefined}
              className={`grid grid-cols-[minmax(0,1fr)_auto] items-center @sm:grid-cols-[minmax(0,1fr)_auto_7.5rem] gap-x-2 border-t border-border px-2 py-1 first:border-t-0 @3xl:grid-cols-[9rem_minmax(0,1.2fr)_minmax(0,1.5fr)_6rem_7rem] @3xl:gap-x-3 ${row.current ? "bg-selected shadow-[inset_3px_0_0_var(--accent)]" : ""}`}>
              <span className="col-start-1 row-start-1 min-w-0 text-small font-medium @3xl:col-start-1 @3xl:row-start-1">
                <a className="text-primary hover:underline" href={href(projectId, "journey")}>{row.id} {row.title}</a>
                {row.current && <span className="ml-1 text-caption font-semibold text-primary">当前</span>}</span>
              <span className={`${row.current ? "hidden @sm:block " : "hidden @3xl:block "}col-start-1 row-start-2 line-clamp-1 text-caption text-text-secondary @3xl:col-start-2 @3xl:row-start-1 @3xl:line-clamp-2 @3xl:text-small`}><span className="@3xl:hidden">交付：</span>{row.deliver}</span>
              <span className={`${row.current ? "hidden @sm:block " : "hidden @3xl:block "}col-span-2 @sm:col-span-3 col-start-1 row-start-3 line-clamp-1 text-caption text-text-secondary @3xl:col-span-1 @3xl:col-start-3 @3xl:row-start-1 @3xl:line-clamp-2 @3xl:text-small`}><span className="@3xl:hidden">退出证据：</span>{row.exit}</span>
              <span className="col-start-2 row-start-1 justify-self-end @3xl:col-start-4 @3xl:row-start-1 @3xl:justify-self-start"><span className={`inline-block whitespace-nowrap rounded-full px-2 text-caption ${toneClass[row.tone]}`}>{row.status}</span></span>
              <span className="hidden @sm:block @sm:col-start-3 @sm:row-start-1 col-start-2 row-start-2 justify-self-end whitespace-nowrap text-caption text-text-secondary @3xl:col-start-5 @3xl:row-start-1 @3xl:justify-self-start @3xl:text-small">{row.date === NOT_REGISTERED ? NOT_REGISTERED : row.date}</span>
            </li>)}
          </ol></>}
      </section>
    </div>
  </div>;
}
