import { OrganizationReviewList } from "../documents/OrganizationReviewList";
import { useEffect, useRef, useState } from "react";
import type { ObservedSession, SessionDirectory } from "@evoloop/contracts/session-observation";
import { errorText } from "../api";
import { Alert, date, href } from "../ui/shared";
import type { MutationContext } from "../workflow/ActionForm";
import { sessionClient } from "../sessions/client";
import { runStateLabel, sessionStatusLabel } from "../sessions/sessionStatusPresentation";
import { RuntimePanel } from "../runtime/RuntimePanel";
import { DiscussionPanel } from "../discussions/DiscussionPanel";
import { RolesPanel } from "./RolesPanel";
import "./team-workspace.css";

type TeamTab = "members" | "reviews" | "roles" | "execution" | "discussions";
const memberLabel = { current: "当前团队", historical: "历史会话", unclassified: "待归类" } as const;
function requestedTab(): TeamTab {
  if (window.location.hash.split("?")[0].endsWith("/reviews")) return "reviews";
  if (window.location.hash.split("?")[0].endsWith("/discussions")) return "discussions";
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("view");
  return value === "roles" || value === "execution" || value === "discussions" ? value : "members";
}

function sessionHref(projectId: string, key: string) {
  return `${href(projectId, "runtime")}?session=${encodeURIComponent(key)}`;
}

function teamWorkLabel(item: ObservedSession): string {
  if (!item.currentTask) return "没有可确认的当前工作";
  if (item.currentTask.relation === "accepted") return "具体 Session 已接手";
  if (item.currentTask.relation === "assigned") return "已分派，待确认接手";
  if (item.currentTask.relation === "claimed") return "Run／队列已认领或占用；不表示分派已接受";
  if (item.currentTask.relation === "run") return "有 Run 关联；不表示分派已接受";
  return "同职责关联；不表示本 Session 已接手";
}

function teamNextAction(item: ObservedSession): string {
  if (item.currentTask?.relation === "assigned") return "核对具体接受回执";
  if (item.currentTask?.relation === "role-responsibility") return "核对具体分派与接手";
  if (item.latestBusinessRun && ["failed", "interrupted", "unknown"].includes(item.latestBusinessRun.state)) return "核对原 Run 与任务";
  if (item.currentTask) return "查看任务当前进展";
  if (item.kind === "external") return "核对外部会话与承接";
  return "查看会话和最近交付";
}

export function TeamWorkspace({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [tab, setTab] = useState<TeamTab>(requestedTab);
  const [directory, setDirectory] = useState<SessionDirectory | null>(null);
  const [items, setItems] = useState<ObservedSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [readAgain, setReadAgain] = useState(0);
  const [search, setSearch] = useState("");
  const searchScope = useRef({ token: context.token, projectId: context.projectId });
  const epoch = useRef(0);
  useEffect(() => {
    const onHash = () => setTab(requestedTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (searchScope.current.token !== context.token || searchScope.current.projectId !== context.projectId) {
      searchScope.current = { token: context.token, projectId: context.projectId };
      setSearch("");
    }
    if (tab !== "members") return;
    let active = true;
    const current = ++epoch.current;
    const controller = new AbortController();
    setLoading(true); setMoreBusy(false); setError(""); setMoreError(""); setDirectory(null); setItems([]); setCursor(null);
    sessionClient(context.token, context.projectId).directory({}, controller.signal)
      .then(page => { if (active && epoch.current === current) { setDirectory(page); setItems(page.items); setCursor(page.nextCursor); } })
      .catch(cause => { if (active && epoch.current === current) setError(errorText(cause)); })
      .finally(() => { if (active && epoch.current === current) setLoading(false); });
    return () => { active = false; controller.abort(); if (epoch.current === current) epoch.current++; };
  }, [context.token, context.projectId, refresh, readAgain, tab]);
  async function more() {
    if (!cursor || moreBusy) return;
    const previous = cursor;
    const current = epoch.current;
    setMoreBusy(true); setMoreError("");
    try {
      const page = await sessionClient(context.token, context.projectId).directory({ cursor: previous });
      if (epoch.current !== current) return;
      if (page.nextCursor === previous) throw new Error("会话列表游标没有前进，请重新读取。");
      setItems(current => [...new Map([...current, ...page.items].map(item => [item.key, item])).values()]);
      setCursor(page.nextCursor);
      setDirectory(page);
    } catch (cause) { if (epoch.current === current) setMoreError(errorText(cause)); }
    finally { if (epoch.current === current) setMoreBusy(false); }
  }
  const visible = items.filter(item => item.membership === "current");
  const filtered = visible.filter(item => `${item.title} ${item.roles.map(role => role.title).join(" ")} ${item.currentTask?.title ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const changeTab = (value: TeamTab) => { setTab(value); window.location.hash = value === "reviews" ? href(context.projectId, "reviews") : value === "discussions" ? href(context.projectId, "discussions") : `${href(context.projectId, "runtime")}?view=${value}`; };
  return <div className="content team-workspace">
    <div className="page-title-row"><div><h1>团队分工</h1><p className="lede">看清职责、实际会话与当前承接。</p></div><div className="team-entry-actions"><a className="button-link" href={href(context.projectId, "collaboration")}>协作回执</a></div></div>
    <nav className="team-tabs" aria-label="团队分工栏目">
      {([ ["members", "当前团队"], ["reviews", "组织复盘"], ["roles", "职责档案"], ["execution", "受管执行"], ["discussions", "分工讨论"] ] as const).map(([key, label]) =>
        <button key={key} type="button" className={tab === key ? "selected" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => changeTab(key)}>{label}</button>)}
    </nav>
    {tab === "members" && <>
      <section className="team-directory" aria-busy={loading}>
        <div className="team-directory-toolbar">
          <label className="team-search"><span className="team-search-label">查找已载入的当前团队会话或职责</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索会话或职责" /></label>
          {directory && <p className="team-read-at">当前团队 {directory.totals.current} · 历史 {directory.totals.historical} · 待归类 {directory.totals.unclassified} · 读于 {date(directory.metadata.generatedAt)}{directory.metadata.partial && " · 来源不完整"}</p>}
          <button type="button" onClick={() => setReadAgain(value => value + 1)} disabled={loading}>重新读取</button>
        </div>
        {loading && <p className="team-directory-state">正在读取实际会话…</p>}
        {error && <div className="team-directory-state"><Alert kind="error">会话列表暂不可读取：{error}。职责档案仍可单独查看。</Alert></div>}
        {!loading && !error && !filtered.length && <p className="team-directory-state">{search ? "已载入范围内没有匹配项；可加载更多会话继续核对。" : cursor ? "当前页未列出当前团队会话，可继续加载。" : "目前没有可确认的当前团队会话。"}</p>}
        {filtered.length > 0 && <div className="table-wrap team-table-wrap"><table className="team-table"><thead><tr><th>实际会话</th><th>职责</th><th>当前工作与下一步</th><th>状态</th></tr></thead><tbody>{filtered.map(item => <tr key={item.key}>
          <td data-label="实际会话"><a className="team-session-name" href={sessionHref(context.projectId, item.key)}>{item.title}</a><small>{item.kind === "owned" ? "项目受管" : "外部连接"} · {memberLabel[item.membership]}</small></td>
          <td data-label="职责"><strong>{item.roles.map(role => role.title).join("、") || "职责待核对"}</strong><details className="team-responsibility"><summary>职责详情</summary><p>{item.roles.map(role => role.responsibility).filter(Boolean).join("；") || item.profile?.purpose || "范围尚未登记"}</p></details></td>
          <td data-label="当前工作与下一步">{item.currentTask ? <a href={href(context.projectId, "task", item.currentTask.id)}>{item.currentTask.title}</a> : "暂无可确认的当前任务"}<small>{item.currentTask && <>{teamWorkLabel(item)} · </>}<a href={sessionHref(context.projectId, item.key)}>{teamNextAction(item)} →</a></small>{item.latestBusinessRun && <details className="team-work-detail"><summary>最近 Run：{runStateLabel(item.latestBusinessRun.state)}</summary><p>更新于 {date(item.latestBusinessRun.updatedAt)}；Run 关联不代表任务分派已接受。<a href={sessionHref(context.projectId, item.key)}>查看会话</a></p></details>}</td>
          <td data-label="状态"><span className="team-state">{sessionStatusLabel(item)}</span><small>{item.lastProgressAt ? `最近进展 ${date(item.lastProgressAt)}` : "进展时间未提供"}</small></td>
        </tr>)}</tbody></table></div>}
        {moreError && <div className="team-directory-state"><Alert kind="error">后续会话未读回：{moreError}</Alert></div>}
        {cursor && !loading && <div className="team-directory-foot"><button type="button" disabled={moreBusy} onClick={() => void more()}>{moreBusy ? "读取中…" : "加载更多会话"}</button></div>}
      </section>
      <p className="team-help">职责的建立、试行与退出有独立记录；<a href={`${href(context.projectId, "runtime")}?view=roles`}>查看职责档案</a>。分工讨论不会自动创建新职责。</p>
    </>}
    {tab === "reviews" && <OrganizationReviewList context={context} refresh={refresh} />}
    {tab === "roles" && <RolesPanel context={context} refresh={refresh} />}
    {tab === "execution" && <RuntimePanel context={context} refresh={refresh} />}
    {tab === "discussions" && <DiscussionPanel context={context} refresh={refresh} />}
  </div>;
}
