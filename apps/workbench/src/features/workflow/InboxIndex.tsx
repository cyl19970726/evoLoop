// 待我处理 › 待我验收与判断 (tasks.md 收件页, 现状): acceptance arranged for me and basis changes to review, each linked
// to its task. Not rebuilt yet: it keeps the old page markup until the inbox page is migrated. Open to-do tasks are
// listed in the task table (工作 › 任务), filtered to 待办.
import { useQueries } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { ShortId, href } from "../../shared/ui/shared";
import { HumanAcceptanceInbox } from "./AcceptanceOverviewPanels";
import { defaultTaskListView, taskListRoute } from "./taskExperience";
import "./task-experience.css";

export function InboxIndex({ context }: { context: MutationContext; refresh: number }) {
  const { projectId } = context;
  const mine = useProjectQuery(projectId, ["acceptance", "mine"], () => api().acceptanceMine(projectId));
  const impacts = useProjectQuery(projectId, ["impacts"], () => api().impacts(projectId));
  const pending = (impacts.data ?? []).filter(item => item.state === "pending");
  const taskIds = [...new Set(pending.map(item => item.taskId))];
  const titles = useQueries({ queries: taskIds.map(id => ({ queryKey: queryKeys.project(projectId, "task", id, "detail"), queryFn: () => api().task(projectId, id), retry: false })) });
  const title = (taskId: string) => { const data = titles[taskIds.indexOf(taskId)]?.data; return data?.task?.id === taskId ? data.task.title : undefined; };
  const todo = taskListRoute(projectId, { ...defaultTaskListView, filter: "todo" });
  return <div className="content work-index">
    <div className="page-title-row"><div><h1>待判断与复核</h1><p className="lede">阅读分配给我的验收和依据变化，按当前状态决定下一步。</p></div>
      <button className="quiet" aria-label="重新读取" onClick={context.onChanged}><RefreshCw size={16} /></button></div>
    <nav className="work-context-tabs" aria-label="任务相关页面"><a href={href(projectId, "work")}>任务列表</a><a href={href(projectId, "journey")}>目标与阶段</a><a href={href(projectId, "inbox")} aria-current="page">依据复核{impacts.data && pending.length ? ` · ${pending.length}` : ""}</a></nav>
    <HumanAcceptanceInbox items={mine.data?.items ?? (mine.error ? [] : null)} projectId={projectId} error={mine.error ? errorText(mine.error) : ""} />
    <section className="panel impact-summary"><div className="panel-head"><h2>依据变化</h2><span>{impacts.data ? `${pending.length} 项待复核` : impacts.error ? "暂不可读取" : "正在读取"}</span></div>
      {impacts.error ? <p role="status">依据变化暂未读回：{errorText(impacts.error)}</p>
        : impacts.isPending ? <p role="status">正在读取依据变化…</p>
          : !pending.length ? <p className="empty">当前没有待复核的依据变化。</p>
            : <ul className="impact-list">{pending.map(item => <li key={item.id}><a href={`${href(projectId, "task", item.taskId)}?tab=basis`}>
              <strong>{title(item.taskId) ?? "任务（名称读取中）"}</strong><span>固定 <ShortId value={item.fromRevisionId} /> / 新采纳 <ShortId value={item.toRevisionId} /></span><span>查看影响</span></a></li>)}</ul>}
    </section>
    <p className="work-guidance">待办任务在任务表格里按“待办”筛选查看：<a href={todo}>打开待办任务</a></p>
  </div>;
}
