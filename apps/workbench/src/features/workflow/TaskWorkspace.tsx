// 工作 › 任务 (docs/frontend/pages/tasks.md): the task list in the inner rail, the selected task (or the table view)
// in the center, and the task's facts in the right column. `/work` is the table view; `/tasks/{id}` reads one task.
// The list's filters and sort live in the address (q, state, kind, scope, sort; `selected` for the table's row), so a
// refresh, Back and a shared link come back to the same list.
import React from "react";
import { Plus } from "lucide-react";
import { Button, cn } from "@evoloop/ui";
import type { MutationContext } from "../../shared/ActionForm";
import { currentPath, onNavigate, replaceQuietly } from "../../shared/navigation";
import { taskListKeys, taskTabHref, type TaskSection } from "../../shared/taskNavigation";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { href } from "../../shared/ui/shared";
import { useMediaQuery } from "../../shared/ui/useMediaQuery";
import { TaskFacts } from "./TaskFacts";
import { TaskPage } from "./TaskPage";
import { TaskRail } from "./TaskRail";
import { TaskTable } from "./TaskTable";
import {
  isMyCurrentWork, narrowLayoutKey, readNarrowLayout, taskListParams, taskListRoute, taskListView, taskRoute, type NarrowTaskLayout, type TaskListView,
} from "./taskExperience";
import { useTaskList } from "./useTaskList";

/** The detail address with the list view written in, keeping the task's own parameters (tab, return, revision …). */
function detailAddress(path: string, view: TaskListView): string {
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  for (const key of [...taskListKeys, "selected"]) params.delete(key);
  for (const [key, value] of taskListParams({ ...view, selected: "" })) params.set(key, value);
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

// The phone layout choice is shared by every task page in this tab (the table view and each open task).
let chosenLayout: NarrowTaskLayout | null = null;
const layoutListeners = new Set<() => void>();
const subscribeLayout = (listener: () => void) => { layoutListeners.add(listener); return () => { layoutListeners.delete(listener); }; };
const layoutStore = () => typeof window === "undefined" ? null : window.localStorage;
const currentLayout = () => chosenLayout ?? readNarrowLayout(layoutStore());
function chooseLayout(next: NarrowTaskLayout) {
  chosenLayout = next;
  try { layoutStore()?.setItem(narrowLayoutKey, next); } catch { /* kept for this tab only */ }
  for (const listener of [...layoutListeners]) listener();
}

/**
 * 正文 / 表格; on a phone 正文 / 列表 / 表格, where 列表 and 表格 are two ways to show `/work` and choosing one is kept.
 * `current` is the page: the task (detail) or the list (`/work`).
 */
export function ViewSwitch({ detailHref, tableHref, current, narrow = false, layout = "list" }: {
  detailHref: string | null; tableHref: string; current: "detail" | "table"; narrow?: boolean; layout?: NarrowTaskLayout;
}) {
  const item = "rounded-full px-3 py-1 text-label text-muted-foreground no-underline outline-none transition-colors hover:text-foreground focus-visible:shadow-[var(--focus-ring)]";
  const selected = "bg-raised font-medium text-foreground shadow-sm";
  const listLink = (label: string, shows: boolean, choice?: NarrowTaskLayout) =>
    <a key={label} href={tableHref} aria-current={current === "table" && shows ? "page" : undefined} onClick={choice ? () => chooseLayout(choice) : undefined}
      className={cn(item, current === "table" && shows && selected)}>{label}</a>;
  return <nav aria-label="任务视图" className="inline-flex items-center gap-0.5 rounded-full bg-field p-[3px]">
    {detailHref ? <a href={detailHref} aria-current={current === "detail" ? "page" : undefined} className={cn(item, current === "detail" && selected)}>正文</a>
      : <span aria-disabled="true" className={cn(item, "opacity-50")}>正文</span>}
    {narrow ? [listLink("列表", layout === "list", "list"), listLink("表格", layout === "table", "table")] : listLink("表格", true)}
  </nav>;
}

export function TaskWorkspace({ context, refresh, active, taskId, selectedRevision }: {
  context: MutationContext; refresh: number; active: boolean; taskId?: string; selectedRevision?: string;
}) {
  const { projectId, principal } = context;
  const panel = useContextPanel();
  const [view, setViewState] = React.useState(() => taskListView(currentPath()));
  // A link to this same page with another view (Back, or a link from elsewhere) brings that view with it.
  React.useEffect(() => onNavigate(() => {
    const path = currentPath();
    if (path.split("?")[0] !== (taskId ? href(projectId, "task", taskId) : href(projectId, "work"))) return;
    const next = taskListView(path);
    setViewState(current => {
      const merged = taskId ? { ...next, selected: current.selected } : next;
      return JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
    });
  }), [projectId, taskId]);
  const table = !taskId;
  const narrow = !useMediaQuery("(min-width: 760px)");
  const layout = React.useSyncExternalStore(subscribeLayout, currentLayout, () => "list" as const);
  const stacked = table && narrow && layout === "list";
  const list = useTaskList(projectId, view, principal.actorId, active, { projectionsFor: table ? "filtered" : "none", extraIds: view.selected ? [view.selected] : [] });
  const setView = (patch: Partial<TaskListView>) => {
    const next = { ...view, ...patch };
    setViewState(next);
    if (!active) return;
    if (table) {
      const route = taskListRoute(projectId, next);
      replaceQuietly(route);
      try { sessionStorage.setItem(`evoloop:list:${projectId}`, route); } catch { /* optional return state */ }
    } else replaceQuietly(detailAddress(currentPath(), next));
  };
  // The table view keeps one selected row for the right column: the address's, else my current work, else the first.
  const mine = Object.values(list.projections).filter(item => isMyCurrentWork(item, principal.actorId))
    .sort((a, b) => Number(b.assignment?.state === "accepted") - Number(a.assignment?.state === "accepted") || Date.parse(b.dates.businessChangedAt) - Date.parse(a.dates.businessChangedAt));
  const fallback = mine.find(item => list.visible.some(task => task.id === item.taskId))?.taskId ?? list.visible[0]?.id ?? "";
  const selected = table ? view.selected || fallback : taskId;
  React.useEffect(() => {
    if (table && active && !view.selected && fallback) setView({ selected: fallback });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, active, view.selected, fallback]);
  React.useEffect(() => {
    if (!table || !active) return;
    const route = taskListRoute(projectId, view);
    if (currentPath().split("?")[0] === href(projectId, "work")) {
      replaceQuietly(route);
      try { sessionStorage.setItem(`evoloop:list:${projectId}`, route); } catch { /* optional return state */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, active]);
  const linkFor = (id: string, tab?: string) => {
    const route = taskRoute(projectId, id, view);
    return tab ? `${route}${route.includes("?") ? "&" : "?"}tab=${tab}` : route;
  };
  const tableHref = taskListRoute(projectId, { ...view, selected: selected ?? "" });
  const detailHref = selected ? linkFor(selected) : null;
  const tabLink = (id: string) => (tab: TaskSection) => taskId === id && active
    ? taskTabHref(currentPath(), projectId, id, tab, principal.actorId) : linkFor(id, tab);
  const rail = <ContextRailContent><div data-ui="">
    <a href={href(projectId, "create-task")} className="mb-1 flex items-center gap-1.5 rounded-md px-3 py-2 text-label font-medium text-text-secondary no-underline outline-none hover:bg-field/60 hover:text-foreground focus-visible:shadow-[var(--focus-ring)]"><Plus size={15} aria-hidden="true" />新建任务</a>
    <TaskRail list={list} view={view} onView={setView} selectedId={selected || null} linkFor={id => linkFor(id)} /></div></ContextRailContent>;
  if (taskId) return <>
    {rail}
    <TaskPage context={context} token={context.token} projectId={projectId} id={taskId} selectedRevision={selectedRevision} refresh={refresh}
      canReview={principal.permissions.includes("review")} active={active}
      viewSwitch={<ViewSwitch detailHref={detailHref} tableHref={tableHref} current="detail" narrow={narrow} layout={layout} />} linkForTab={tabLink(taskId)} />
  </>;
  return <>
    {rail}
    <div data-ui="" className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-6 pb-12 pt-6 max-compact:px-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 tabIndex={-1} className="text-title font-semibold text-foreground outline-none">任务</h1>
        <ViewSwitch detailHref={detailHref} tableHref={tableHref} current="table" narrow={narrow} layout={layout} />
        <span className="flex-1" />
        {panel && selected && <Button size="compact" className="min-[1100px]:hidden" onClick={() => panel.setOpen(true)}>所选任务信息</Button>}
        <Button asChild variant="primary" size="compact"><a href={href(projectId, "create-task")}><Plus size={15} aria-hidden="true" />新建任务</a></Button>
      </header>
      <p className="text-label text-text-secondary">批量核对任务的进展、承接与成果。选中一行，右栏显示它的状态、承接、文档与交付；需要推进或调整时，先与相关智能体沟通，再回到这里读回。</p>
      <TaskTable projectId={projectId} list={list} view={view} selectedId={selected || null} onSelect={id => setView({ selected: id })} linkFor={linkFor} stacked={stacked} actorId={principal.actorId} />
    </div>
    {selected && <ContextPanelContent><TaskFacts key={selected} context={context} taskId={selected} heading linkForTab={tabLink(selected)}
      outsideFilter={!list.loading && !list.visible.some(task => task.id === selected)}
      {...(list.projections[selected] ? { leader: list.projections[selected], leaderKnown: true } : {})} /></ContextPanelContent>}
  </>;
}
