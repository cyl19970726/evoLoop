import { useEffect, useRef, useState } from "react";
import type { Document, Impact, Page, Task } from "@evoloop/contracts";
import { ChevronRight, CirclePlay, Clock3, Plus, RefreshCw, Search, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { ApiError, api, errorText } from "../api";
import { sessionClient } from "../sessions/client";
import { ActionForm, option, type MutationContext } from "./ActionForm";
import { UploadDocument } from "../documents/UploadDocument";
import { Alert, ShortId, href } from "../ui/shared";
import { Button } from "../components/ui/button";
import { legacyDecisionLabel, taskNextStep } from "./taskListPresentation";
import { businessNextStep, cognitionSummary, visibleWorkGroups, type WorkTaskStatus } from "./workStatusPresentation";
import { isRoleOwnerId, readOwnerRole } from "./ownerRole";
import "./work-status.css";
import "./task-experience.css";
import { assignmentSessionKey, assignmentStatusLabel, executionSummary, isClosedTask, isMyCurrentWork, matchingProjection, taskListRoute, taskListView } from "./taskExperience";
import { useTaskProjections } from "./useTaskProjections";
import { TaskPreview } from "./TaskPreview";
import type { LeaderWorkDocument, LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import {
  appendLeaderWorkPage, leaderPhaseLabel, leaderSessionDisplayName, leaderWorkItemPresentation,
  loadLeaderDocumentsForIds, loadLeaderWorkStatuses, visibleLeaderDocuments,
} from "./leaderWorkLoad";

const states: Record<Task["state"], string> = { todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
const taskKinds = { implementation: "实施", research: "调研", validation: "验证" } as const;
const documentKinds = { issue: "问题", spec: "规范", discussion: "讨论", report: "报告", organization_review: "组织复盘", task: "任务正文" } as const;
const documentStatuses = { draft: "草稿", published: "已发布", archived: "已归档" } as const;
const searchPageLimit = 10;
const searchItemLimit = 500;
const leaderPhaseOrder = ["unknown", "rework", "blocked", "awaiting_delivery", "awaiting_acceptance", "awaiting_assignment", "ready", "running", "unassigned"] as const;
type OwnerName = { title?: string; error?: string };
type WorkStatusProblem = { kind: "unavailable" | "partial"; diagnostic: string };
type LeaderSessionName = { title: string | null; error: string | null };
const partialStatusDiagnostic = "接口未返回全部已载入任务的工作进度。";

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map(item => item.id));
  const merged = [...current];
  for (const item of incoming) if (!seen.has(item.id)) { seen.add(item.id); merged.push(item); }
  return merged;
}

export function WorkIndex({ context, refresh, view }: { context: MutationContext; refresh: number; view: "work" | "inbox" | "documents" }) {
  const { token, projectId } = context;
  const [tasks, setTasks] = useState<Page<Task>>({ items: [], nextCursor: null });
  const [documents, setDocuments] = useState<Page<Document>>({ items: [], nextCursor: null });
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [statuses, setStatuses] = useState<Record<string, WorkTaskStatus>>({});
  const [statusProblem, setStatusProblem] = useState<WorkStatusProblem | null>(null);
  const [statusRetrying, setStatusRetrying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [recheck, setRecheck] = useState(0);
  const [observedAt, setObservedAt] = useState<Date | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState(() => view === "work" ? taskListView(window.location.hash).query : "");
  const [filter, setFilter] = useState(() => view === "work" ? taskListView(window.location.hash).filter : "open");
  const [kindFilter, setKindFilter] = useState(() => view === "work" ? taskListView(window.location.hash).kind : "all");
  const [scope, setScope] = useState(() => taskListView(window.location.hash).scope);
  const selectionDismissed = useRef(false);
  const [selectedTask, setSelectedTask] = useState(() => taskListView(window.location.hash).selected);
  const [documentStatus, setDocumentStatus] = useState("active");
  const [create, setCreate] = useState(false);
  const [ownerNames, setOwnerNames] = useState<{ scope: string; values: Record<string, OwnerName> }>({ scope: "", values: {} });
  const [leaderWork, setLeaderWork] = useState<LeaderWorkPage<LeaderWorkTask> | null>(null);
  const [leaderDocuments, setLeaderDocuments] = useState<Record<string, LeaderWorkDocument>>({});
  const [leaderDocumentCoverage, setLeaderDocumentCoverage] = useState<"idle" | "loading" | "complete" | "partial">("idle");
  const [leaderWorkBusy, setLeaderWorkBusy] = useState(false);
  const [leaderWorkError, setLeaderWorkError] = useState("");
  const [leaderStatuses, setLeaderStatuses] = useState<Record<string, WorkTaskStatus>>({});
  const [leaderStatusReading, setLeaderStatusReading] = useState(false);
  const [leaderStatusError, setLeaderStatusError] = useState("");
  const [leaderSessionNames, setLeaderSessionNames] = useState<Record<string, LeaderSessionName>>({});
  const [leaderSessionReading, setLeaderSessionReading] = useState(false);
  const [leaderSessionError, setLeaderSessionError] = useState("");
  const epoch = useRef(0);
  const statusSnapshot = useRef<Record<string, WorkTaskStatus>>({});
  const pages = useRef<{ tasks: Page<Task>; documents: Page<Document> }>({
    tasks: { items: [], nextCursor: null }, documents: { items: [], nextCursor: null },
  });
  const pendingPage = useRef<{ tasks?: Promise<boolean>; documents?: Promise<boolean> }>({});
  const cursorHistory = useRef<{ tasks: Set<string>; documents: Set<string> }>({ tasks: new Set(), documents: new Set() });
  const pageCount = useRef({ tasks: 0, documents: 0 });
  const visibleDocuments = visibleLeaderDocuments(documents.items, documentStatus, kindFilter, query);
  const visibleDocumentSignature = visibleDocuments.map(item => item.id).join(",");
  useEffect(() => {
    let active = true; ++epoch.current; pendingPage.current = {}; cursorHistory.current = { tasks: new Set(), documents: new Set() }; pageCount.current = { tasks: 0, documents: 0 }; statusSnapshot.current = {}; setLoading(true); setError(""); setStatuses({}); setStatusProblem(null); setStatusRetrying(false);
    setLeaderStatuses({}); setLeaderStatusError(""); setLeaderStatusReading(false);
    setLeaderSessionNames({}); setLeaderSessionError(""); setLeaderSessionReading(false);
    const client = api(token);
    Promise.all([client.tasks(projectId), client.documents(projectId), client.impacts(projectId)]).then(async ([t, d, i]) => {
      if (active) { pages.current = { tasks: t, documents: d }; pageCount.current = { tasks: 1, documents: 1 }; setTasks(t); setDocuments(d); setImpacts(i); setObservedAt(new Date()); }
      if (t.items.length) try {
        const work = await client.workStatuses(projectId,t.items.map(item => item.id));
        if (active) {const next = Object.fromEntries(work.items.map(item => [item.taskId,item])); statusSnapshot.current = next; setStatuses(next);
          if (work.items.length !== t.items.length) setStatusProblem({ kind: "partial", diagnostic: partialStatusDiagnostic });}
      } catch (cause) { if (active) setStatusProblem({ kind: "unavailable", diagnostic: errorText(cause) }); }
    }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, projectId, refresh, recheck]);
  useEffect(() => {
    let active = true;
    setLeaderWorkError("");
    setLeaderWorkBusy(false);
    if (loading) return () => { active = false; };
    if (view === "documents") setLeaderWork(null);
    else setLeaderDocuments({});
    if (view === "documents") {
      setLeaderDocumentCoverage("loading");
      void (async () => {
        const result = await loadLeaderDocumentsForIds(
          cursor => api(token).leaderWork(projectId, "documents", cursor,
            documentStatus === "all" || documentStatus === "archived"),
          visibleDocuments.map(item => item.id));
        if (!active) return;
        setLeaderDocuments(Object.fromEntries(result.items));
        setLeaderDocumentCoverage(result.complete ? "complete" : "partial");
        if (!result.complete) setLeaderWorkError("文档索引缺少已加载的文档行；请重新读取后再核对。");
      })().catch(cause => {
        if (active && !(cause instanceof ApiError && cause.status === 404)) {
          setLeaderDocumentCoverage("partial");
          setLeaderWorkError(`文档生命周期暂未读回：${errorText(cause)}`);
        }
      });
      return () => { active = false; };
    }
    setLeaderDocumentCoverage("idle");
    api(token).leaderWork(projectId, "tasks").then(result => {
      if (active) setLeaderWork(result as LeaderWorkPage<LeaderWorkTask>);
    }).catch(cause => {
      if (active) {
        setLeaderWork(null);
        setLeaderWorkError(`待处理对账暂未读回：${errorText(cause)}`);
      }
    });
    return () => { active = false; };
  }, [token, projectId, refresh, recheck, view, loading, visibleDocumentSignature, documentStatus]);
  const leaderStatusSignature = leaderWork?.items.map(item => item.taskId).join(",") ?? "";
  const ordinaryStatusSignature = Object.keys(statuses).sort().join(",");
  const leaderStatusKnownSignature = Object.keys(leaderStatuses).sort().join(",");
  useEffect(() => {
    let active = true;
    setLeaderStatusError("");
    setLeaderStatusReading(false);
    if (view !== "work" || !leaderWork) return () => { active = false; };
    const known = new Set([...Object.keys(statuses), ...Object.keys(leaderStatuses)]);
    const missing = [...new Set(leaderWork.items.map(item => item.taskId))].filter(id => !known.has(id));
    if (!missing.length) return () => { active = false; };
    setLeaderStatusReading(true);
    const client = api(token);
    void loadLeaderWorkStatuses(missing, async ids => (await client.workStatuses(projectId, ids)).items)
      .then(result => {
        if (!active) return;
        setLeaderStatuses(current => ({
          ...current, ...Object.fromEntries(result.statuses.map(status => [status.taskId, status])),
        }));
        if (result.missing.length)
          setLeaderStatusError(`Leader 行来源状态仅读回 ${result.statuses.length}/${missing.length} 项；未读回的行不使用原始标题推定来源。`);
      })
      .catch(cause => {
        if (active) setLeaderStatusError(`Leader 行来源状态暂不可读：${errorText(cause)}。未读回的行只显示待核对。`);
      })
      .finally(() => { if (active) setLeaderStatusReading(false); });
    return () => { active = false; };
  }, [token, projectId, view, refresh, recheck, leaderStatusSignature, ordinaryStatusSignature,
    leaderStatusKnownSignature]);
  function sessionKeyFor(item: LeaderWorkTask): string | null {
    return assignmentSessionKey(item);
  }
  const leaderSessionSignature = leaderWork?.items.map(sessionKeyFor).filter((key): key is string => !!key)
    .filter((key, index, keys) => keys.indexOf(key) === index).sort().join(",") ?? "";
  const leaderSessionKnownSignature = Object.entries(leaderSessionNames)
    .filter(([, value]) => !!value.title).map(([key]) => key).sort().join(",");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLeaderSessionError("");
    setLeaderSessionReading(false);
    if (view !== "work" || !leaderWork) return () => { active = false; controller.abort(); };
    const known = new Set(Object.entries(leaderSessionNames).filter(([, value]) => !!value.title).map(([key]) => key));
    const missing = leaderSessionSignature.split(",").filter(Boolean).filter(key => !known.has(key));
    if (!missing.length) return () => { active = false; controller.abort(); };
    setLeaderSessionReading(true);
    const client = sessionClient(token, projectId), results: Record<string, LeaderSessionName> = {};
    const queue = [...missing];
    const read = async () => {
      while (active && queue.length) {
        const key = queue.shift()!;
        try {
          const value = await client.snapshot(key, controller.signal);
          if (!value || value.session.key !== key) throw new Error("会话目录未返回该 Session");
          const title = leaderSessionDisplayName(value.session);
          results[key] = { title: title || null, error: title ? null : "Session 展示名称未登记" };
        } catch (cause) {
          if (!active || controller.signal.aborted) return;
          results[key] = { title: null, error: errorText(cause) };
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, read)).then(() => {
      if (!active) return;
      setLeaderSessionNames(current => ({ ...current, ...results }));
      const unavailable = Object.values(results).filter(value => !value.title).length;
      if (unavailable) setLeaderSessionError(
        `${unavailable} 个 Leader 责任 Session 的展示名称暂不可读；名称待核对，Session ID 与入口仍保留。`);
    }).finally(() => { if (active) setLeaderSessionReading(false); });
    return () => { active = false; controller.abort(); };
  }, [token, projectId, view, refresh, recheck, leaderSessionSignature, leaderSessionKnownSignature]);
  useEffect(() => {
    const reread = () => { if (document.visibilityState === "visible") setRecheck(value => value + 1); };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [projectId]);
  function nextPage(kind: "tasks" | "documents"): Promise<boolean> {
    const inFlight = pendingPage.current[kind];
    if (inFlight) return inFlight;
    const cursor = pages.current[kind].nextCursor;
    if (!cursor) return Promise.resolve(false);
    const readEpoch = epoch.current;
    const client = api(token);
    const request = (async () => {
      if (kind === "documents") {
        const page = await client.documents(projectId, cursor);
        if (readEpoch !== epoch.current || pages.current.documents.nextCursor !== cursor) return false;
        if (page.items.length > 50) throw new Error("文档分页响应超过每页上限");
        if (page.nextCursor && (page.nextCursor === cursor || cursorHistory.current.documents.has(page.nextCursor))) throw new Error("文档分页游标重复，无法确认后续结果");
        cursorHistory.current.documents.add(cursor);
        const merged = { items: mergeById(pages.current.documents.items, page.items), nextCursor: page.nextCursor };
        pages.current.documents = merged; pageCount.current.documents++; setDocuments(merged);
      } else {
        const page = await client.tasks(projectId, cursor);
        if (readEpoch !== epoch.current || pages.current.tasks.nextCursor !== cursor) return false;
        if (page.items.length > 50) throw new Error("任务分页响应超过每页上限");
        if (page.nextCursor && (page.nextCursor === cursor || cursorHistory.current.tasks.has(page.nextCursor))) throw new Error("任务分页游标重复，无法确认后续结果");
        cursorHistory.current.tasks.add(cursor);
        const known = new Set(pages.current.tasks.items.map(item => item.id));
        const added = mergeById<Task>([], page.items.filter(item => !known.has(item.id)));
        const merged = { items: [...pages.current.tasks.items, ...added], nextCursor: page.nextCursor };
        pages.current.tasks = merged; pageCount.current.tasks++; setTasks(merged);
        if (added.length) try {
          const work = await client.workStatuses(projectId, added.map(item => item.id));
          if (readEpoch === epoch.current) {
            const next = { ...statusSnapshot.current, ...Object.fromEntries(work.items.map(item => [item.taskId, item])) };
            statusSnapshot.current = next; setStatuses(next);
            const missing = pages.current.tasks.items.some(task => !Object.hasOwn(next, task.id));
            setStatusProblem(current => missing ? current ?? { kind: "partial", diagnostic: partialStatusDiagnostic } : null);
          }
        } catch (cause) { if (readEpoch === epoch.current) setStatusProblem({ kind: "unavailable", diagnostic: errorText(cause) }); }
      }
      return true;
    })();
    pendingPage.current[kind] = request;
    void request.then(() => { if (pendingPage.current[kind] === request) delete pendingPage.current[kind]; },
      () => { if (pendingPage.current[kind] === request) delete pendingPage.current[kind]; });
    return request;
  }
  async function more() {
    if (busy) return; setBusy(true); const readEpoch = epoch.current;
    try {
      await nextPage(view === "documents" ? "documents" : "tasks");
    } catch (cause) { if (readEpoch === epoch.current) setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function retryWorkStatus() {
    if (statusRetrying) return;
    const readEpoch = epoch.current;
    const ids = tasks.items.map(task => task.id);
    setStatusRetrying(true);
    try {
      const next: Record<string, WorkTaskStatus> = {};
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50);
        const work = await api(token).workStatuses(projectId, batch);
        if (readEpoch !== epoch.current) return;
        for (const item of work.items) next[item.taskId] = item;
      }
      if (readEpoch === epoch.current) {
        const merged = { ...statusSnapshot.current, ...next };
        statusSnapshot.current = merged; setStatuses(merged);
        const missing = pages.current.tasks.items.some(task => !Object.hasOwn(merged, task.id));
        setStatusProblem(missing ? { kind: "partial", diagnostic: partialStatusDiagnostic } : null);
      }
    } catch (cause) {
      if (readEpoch === epoch.current) setStatusProblem({ kind: "unavailable", diagnostic: errorText(cause) });
    } finally {
      if (readEpoch === epoch.current) setStatusRetrying(false);
    }
  }
  async function moreLeaderWork() {
    const current = leaderWork;
    if (!current?.nextCursor || leaderWorkBusy) return;
    setLeaderWorkBusy(true);
    setLeaderWorkError("");
    try {
      const next = await api(token).leaderWork(projectId, "tasks", current.nextCursor);
      const merged = appendLeaderWorkPage(current, next as LeaderWorkPage<LeaderWorkTask>);
      setLeaderWork(previous => previous?.changeSequence === current.changeSequence
        ? merged
        : previous);
    } catch (cause) {
      setLeaderWorkError(`Leader 对账续页未读回：${errorText(cause)}`);
    } finally {
      setLeaderWorkBusy(false);
    }
  }
  const projectionTasks = tasks.items.filter(t => (view !== "inbox" || t.state === "todo") && (filter === "all" || filter === "open" && (t.state === "todo" || t.state === "in_progress") || t.state === filter) && (kindFilter === "all" || t.kind === kindFilter) &&
    `${t.title} ${t.owner} ${t.id} ${statuses[t.id]?.cognition ? cognitionSummary(statuses[t.id]!).title : ""}`.toLowerCase().includes(query.toLowerCase()));
  const projections = useTaskProjections(token, projectId, projectionTasks, leaderWork, `${refresh}:${recheck}`, view === "work");
  const myWork = Object.values(projections.items).filter(item => isMyCurrentWork(item, context.principal.actorId))
    .sort((a, b) => Number(b.assignment?.state === "accepted") - Number(a.assignment?.state === "accepted") || Date.parse(b.dates.businessChangedAt) - Date.parse(a.dates.businessChangedAt));
  const listRoute = taskListRoute(projectId, { query, filter, kind: kindFilter, scope, selected: selectedTask });
  useEffect(() => {
    if (view !== "work" || window.location.hash.split("?")[0] !== href(projectId, "work")) return;
    window.history.replaceState(window.history.state, "", listRoute);
    try { sessionStorage.setItem(`evoloop:list:${projectId}`, listRoute); } catch { /* optional return state */ }
  }, [view, projectId, listRoute]);
  const listProps = { projections: projections.items, sessionNames: leaderSessionNames, actorId: context.principal.actorId,
    returnTo: listRoute, selected: selectedTask, onSelect: (id: string) => { selectionDismissed.current = false; setSelectedTask(id); } };
  const pending = impacts.filter(i => i.state === "pending");
  const visibleTasks = projectionTasks.filter(t => (scope !== "mine" || !!projections.items[t.id] && isMyCurrentWork(projections.items[t.id]!, context.principal.actorId)))
    .sort((a, b) => ({ in_progress: 0, todo: 1, done: 2, cancelled: 3 })[a.state] - ({ in_progress: 0, todo: 1, done: 2, cancelled: 3 })[b.state]);
  const visibleTaskSignature = visibleTasks.map(task => task.id).join(",");
  useEffect(() => {
    if (view !== "work" || selectedTask || selectionDismissed.current || !visibleTasks.length) return;
    setSelectedTask(myWork[0]?.taskId ?? visibleTasks[0].id);
  }, [view, selectedTask, visibleTaskSignature, myWork[0]?.taskId]);
  const ownerIds = [...new Set(visibleTasks.map(task => task.owner).filter(isRoleOwnerId))];
  const ownerSignature = ownerIds.join(",");
  const ownerScope = `${token}\0${projectId}\0${refresh}\0${recheck}\0${view}\0${ownerSignature}`;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setOwnerNames({ scope: ownerScope, values: {} });
    if (loading || view === "documents" || !ownerSignature) return () => { active = false; controller.abort(); };
    // Read only distinct owners of rendered tasks, with bounded concurrent requests.
    const queue = ownerSignature.split(",");
    const read = async () => {
      while (active && queue.length) {
        const owner = queue.shift()!;
        let value: OwnerName;
        try { value = { title: (await readOwnerRole(token, projectId, owner, controller.signal)).proposal.title.trim() }; }
        catch (cause) {
          if (!active) return;
          value = { error: cause instanceof ApiError && cause.status === 404 ? "未找到已登记职责" : `职责暂不可核对：${errorText(cause)}` };
        }
        if (active) setOwnerNames(current => current.scope === ownerScope
          ? { scope: ownerScope, values: { ...current.values, [owner]: value } } : current);
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => read()));
    return () => { active = false; controller.abort(); };
  }, [token, projectId, refresh, recheck, view, loading, ownerSignature, ownerScope]);
  const resolvedOwners = ownerNames.scope === ownerScope ? ownerNames.values : {};
  const classificationUnavailable = Boolean(statusProblem) && !Object.keys(statuses).length;
  const {primary:primaryTasks,cognition:cognitionTasks,unknown:unknownTasks,primaryKind}=visibleWorkGroups(visibleTasks,statuses,classificationUnavailable);
  const awaitingAssignments = view === "work" && scope === "mine" && !projections.complete && !projections.error;
  const needsFilteredPage = view === "work" && !visibleTasks.length && !awaitingAssignments;
  // Continue an empty filtered Task page; typed searches still scan all bounded pages.
  useEffect(() => {
    if (loading || error || (!query.trim() && !needsFilteredPage)) { setSearching(false); setSearchError(""); return; }
    const kind = view === "documents" ? "documents" : "tasks";
    if (!pages.current[kind].nextCursor) { setSearching(false); setSearchError(""); return; }
    let active = true;
    const readEpoch = epoch.current;
    setSearching(true); setSearchError("");
    const timer = window.setTimeout(async () => {
      try {
        await pendingPage.current[kind];
        if (!active || readEpoch !== epoch.current) return;
        const seen = new Set<string>();
        while (active && readEpoch === epoch.current && pages.current[kind].nextCursor) {
          const source = pages.current[kind];
          if (pageCount.current[kind] >= searchPageLimit || source.items.length + 50 > searchItemLimit)
            throw new Error(`自动搜索已达 ${searchPageLimit} 页或 ${searchItemLimit} 项上限；结果未完整。可继续手动加载，或缩小范围。`);
          const cursor = source.nextCursor!;
          if (seen.has(cursor)) throw new Error("分页游标重复，无法确认搜索完整性");
          seen.add(cursor);
          if (!await nextPage(kind)) return;
          // Let the next render recheck filters before reading another page.
          if (!query.trim()) break;
        }
        if (active) setSearching(false);
      } catch (cause) { if (active) { setSearching(false); setSearchError(errorText(cause)); } }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [token, projectId, refresh, recheck, view, query, filter, kindFilter, scope, loading, error, needsFilteredPage, tasks.nextCursor, documents.nextCursor]);
  const fillingFilteredPage = needsFilteredPage && !!tasks.nextCursor && !query.trim() && !searchError && !error;
  const title = view === "documents" ? "过程文档" : view === "inbox" ? "待判断与复核" : "任务";
  const footerSummary = view === "work"
    ? `当前页匹配 ${visibleTasks.length} 项 · 已载入 ${tasks.items.length} 项`
    : view === "documents"
      ? `已载入 ${documents.items.length} 项 · 当前匹配 ${visibleDocuments.length} 项`
      : `已载入 ${tasks.items.length} 项 · 当前匹配 ${visibleTasks.length} 项`;
  return <div className={`content work-index${view === "work" ? " task-index-view" : ""}`}>
    <div className="page-title-row"><div><h1>{title}</h1><p className="lede">{view === "documents" ? "按类型阅读完整正文、固定修订与发布状态。" : view === "inbox" ? "阅读待办任务与依据变化，按当前状态决定下一步。" : "阅读任务正文、验收、固定依据与最新结果。"}</p></div>
      {view === "documents" ? <Button onClick={() => setCreate(!create)} aria-expanded={create}><Plus size={16} />保存文档</Button> : <a className="button-link" href={href(projectId, "create-task")}><Plus size={16} />创建任务</a>}
    </div>
    <div className={`task-list-layout${view === "work" && selectedTask ? " has-selection" : ""}`}><div className="task-list-main">
    {view === "work" && <section className="work-view-controls" aria-label="任务列表筛选">
      <nav className="work-scope-tabs" aria-label="任务范围">
        <button type="button" aria-pressed={scope === "all"} className={scope === "all" ? "selected" : ""} onClick={() => setScope("all")}>全部工作 <span>{projectionTasks.length}</span></button>
        <button type="button" aria-pressed={scope === "mine"} className={scope === "mine" ? "selected" : ""} onClick={() => setScope("mine")}>我的承接 <span>{myWork.length}</span></button>
      </nav>
      <div className="work-quick-tools">
        <label className="search-field"><Search size={16} aria-hidden="true" /><input aria-label="搜索任务（分页读取，范围见下方）" placeholder="搜索任务标题或承接方…" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <select aria-label="任务状态筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="open">未完成任务</option><option value="all">全部状态</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <details className="work-more-filters"><summary aria-label="更多筛选"><SlidersHorizontal size={16} aria-hidden="true" /></summary><select aria-label="任务类型筛选" value={kindFilter} onChange={e => setKindFilter(e.target.value)}><option value="all">全部类型</option>{Object.entries(taskKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></details>
        <button className="quiet" aria-label="重新读取列表" onClick={context.onChanged}><RefreshCw size={16} /></button>
      </div>
    </section>}
    {view === "inbox" && <nav className="work-context-tabs" aria-label="任务相关页面"><a href={href(projectId, "work")} >任务列表</a><a href={href(projectId, "journey")}>目标与阶段</a><a href={href(projectId, "inbox")} aria-current="page">依据复核{pending.length ? ` · ${pending.length}` : ""}</a></nav>}
    {view === "documents" && <nav className="context-links" aria-label="文档与知识"><a href={href(projectId, "documents")} aria-current="page">过程文档</a><a href={href(projectId, "knowledge")}>知识空间</a><a href={href(projectId, "repository")}>仓库规范</a></nav>}
    {view === "documents" && leaderDocumentCoverage === "partial" &&
      <p className="work-list-read-status" role="status">文档生命周期尚未完整覆盖；未读到的行不会推测，可重新读取后再核对。</p>}
    {view === "documents" && create && <div className="panel"><h2>保存过程文档</h2><ActionForm context={context} title="创建 Markdown 文档" fields={[{ name: "title", label: "文档名称" }, { name: "kind", label: "类型（可选）", kind: "select", optional: true, options: Object.entries(documentKinds).filter(([key]) => key !== "task" && key !== "organization_review").map(([key, label]) => option(key, label)) }, { name: "body", label: "完整 Markdown 正文", kind: "textarea" }]} build={v => ({ type: "document.create", documentId: crypto.randomUUID(), title: v.title, body: v.body, kind: v.kind || null })} /><UploadDocument context={context} /></div>}
    {view === "inbox" && <section className="panel impact-summary"><div className="panel-head"><h2>依据变化</h2><span>{pending.length} 项待复核</span></div>{!pending.length ? <p className="empty">当前没有待复核的依据变化。</p> : <ul className="impact-list">{pending.map(i => <li key={i.id}><a href={href(projectId, "task", i.taskId)}><strong>{tasks.items.find(t => t.id === i.taskId)?.title ?? `任务 ${i.taskId.slice(0, 8)}`}</strong><span>固定 <ShortId value={i.fromRevisionId} /> / 新采纳 <ShortId value={i.toRevisionId} /></span><span>查看影响</span></a></li>)}</ul>}</section>}
    <section className="list-surface" aria-label={title} aria-busy={loading}>
      <p className="work-list-read-status">{loading ? "正在核对当前列表…" : observedAt ? `列表读于 ${observedAt.toLocaleString("zh-CN")}；返回窗口时自动重读，也可手动刷新。` : "列表尚未读回。"}</p>
      {view !== "work" && <div className="list-toolbar"><label className="search-field"><Search size={16} aria-hidden="true" /><input aria-label={view === "documents" ? "搜索全部文档" : "搜索任务（分页读取，范围见下方）"} placeholder={view === "documents" ? "查找文档…" : "搜索任务标题或编号…"} value={query} onChange={e => setQuery(e.target.value)} /></label>
        <select aria-label={view === "documents" ? "文档类型筛选" : "任务类型筛选"} value={kindFilter} onChange={e => setKindFilter(e.target.value)}><option value="all">全部类型</option>{Object.entries(view === "documents" ? documentKinds : taskKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        {view === "documents" && <select aria-label="文档状态筛选" value={documentStatus} onChange={e => setDocumentStatus(e.target.value)}><option value="active">未归档</option>{Object.entries(documentStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="all">全部状态</option></select>}
        <button className="quiet" aria-label="重新读取列表" onClick={context.onChanged}><RefreshCw size={16} /></button>
      </div>}
      {loading && <p className="list-message" role="status">正在读取{title}…</p>}
      {error && <div className="list-message"><Alert kind="error">读取失败：{error}</Alert><button onClick={context.onChanged}>重试读取</button></div>}
      {awaitingAssignments && <p className="list-message" role="status">我的承接信息尚未读全，当前结果不完整。</p>}
      {(searching || fillingFilteredPage) && <p className="list-message" role="status">{query.trim() ? "正在搜索后续页面；结果尚未完整。" : "正在读取后续页面中的匹配任务…"}</p>}
      {searchError && <div className="list-message"><Alert kind="error">搜索未完成：{searchError}。当前结果只覆盖已载入项目。</Alert></div>}
      {!loading && !error && <>{view === "documents" ? <div className="table-wrap"><table><thead><tr><th>文档名称</th><th>类型</th><th>状态</th><th>修订与时间</th><th>用途与下一动作</th></tr></thead><tbody>{visibleDocuments.map(d => {
        const lifecycle=leaderDocuments[d.id];
        return <tr key={d.id}><td><a href={href(projectId,"document",d.id)}>{d.title}</a><small><ShortId value={d.id}/>{d.primaryTaskId&&<> · <a href={href(projectId,"task",d.primaryTaskId)}>所属任务</a></>}{lifecycle&&<> · 创建 {new Date(lifecycle.dates.createdAt).toLocaleString("zh-CN")}</>}</small></td><td className="leader-doc-kind">{d.kind?documentKinds[d.kind]:"未分类"}</td><td className="leader-doc-status"><span className="pill subtle">{documentStatuses[d.status]}</span>{lifecycle&&<small className="leader-doc-time">{lifecycle.dates.changedAt?`最近变化 ${new Date(lifecycle.dates.changedAt).toLocaleString("zh-CN")}`:"最近变化未知"}</small>}</td><td className="leader-doc-revision"><span>当前 <ShortId value={d.currentRevisionId}/></span><small>{lifecycle&&new Date(lifecycle.dates.currentRevisionAt).toLocaleString("zh-CN")}</small><span>已采纳 {d.adoptedRevisionId?<ShortId value={d.adoptedRevisionId}/>:"未发布"}</span>{lifecycle?.dates.adoptedAt&&<small>{new Date(lifecycle.dates.adoptedAt).toLocaleString("zh-CN")}</small>}</td><td>{lifecycle?<>{lifecycle.references.length?`${lifecycle.references.length} 个引用任务`:"尚无引用任务"}<small>{lifecycle.nextAction}</small></>:<span>生命周期未读回</span>}</td></tr>;
      })}</tbody></table></div> : view === "work" ? <>
        {statusProblem && <div className="work-status-warning" role="status"><p>{statusProblem.kind === "partial" ? "部分任务的工作进度尚未读回，已加载任务仍可查看。" : "工作进度暂时无法读取，已加载任务仍可查看。"}</p>
          <button type="button" disabled={statusRetrying} onClick={() => void retryWorkStatus()}>{statusRetrying ? "正在重试…" : "重试读取工作进度"}</button>
          <details><summary>查看诊断信息</summary><code>{statusProblem.diagnostic}</code></details></div>}
        <div className="work-status-section"><h2>{primaryKind === "unclassified" ? "已载入任务 · 状态分类暂不可用" : "业务工作"} <span>{primaryTasks.length} 项已载入</span></h2>
          {primaryTasks.length ? <TaskListTable tasks={primaryTasks} statuses={statuses} projectId={projectId} pending={pending} ownerNames={resolvedOwners} {...(view === "work" ? listProps : {})} /> : <p className="work-status-note">{primaryKind === "unclassified" ? "当前尚无已载入任务。" : "已载入部分暂无可确认的业务任务。"}{tasks.nextCursor ? "仍有下一页任务可读取。" : ""}</p>}</div>
        {unknownTasks.length > 0 && <section className="work-status-section work-status-group" aria-label="来源与状态待核对"><h2>来源与状态待核对 <span>{unknownTasks.length} 项已载入</span></h2><p>状态投影未读全，暂不把这些任务归为业务或系统记录。</p><TaskListTable tasks={unknownTasks} statuses={statuses} projectId={projectId} pending={pending} ownerNames={resolvedOwners} {...(view === "work" ? listProps : {})} /></section>}
        {cognitionTasks.length > 0 && <details className="work-status-group"><summary>判断与接续记录 · {cognitionTasks.length} 项已载入</summary><p>由正式认知派发关联的任务；原任务与历史记录均可打开。这里的本轮结果不改写任务状态。</p><TaskListTable tasks={cognitionTasks} statuses={statuses} projectId={projectId} pending={pending} ownerNames={resolvedOwners} {...(view === "work" ? listProps : {})} /></details>}
      </> : <TaskListTable tasks={visibleTasks} statuses={statuses} projectId={projectId} pending={pending} ownerNames={resolvedOwners} />}
      {!searching && !fillingFilteredPage && !awaitingAssignments && !searchError && !(view === "documents" ? visibleDocuments : visibleTasks).length && <div className="list-empty"><FileEmpty /><h2>{view === "work" && tasks.nextCursor ? "已载入范围内没有匹配任务" : view === "work" && tasks.items.length || query || filter !== "open" || kindFilter !== "all" || view === "documents" && documentStatus !== "active" ? "没有匹配项" : view === "inbox" ? "没有待办任务" : `还没有${title}`}</h2><p>{view === "work" && tasks.nextCursor ? "仍有后续页面，可继续载入或搜索全部已读取范围。" : view === "work" && tasks.items.length ? "可以调整筛选，查看其他状态的工作。" : "可以清除筛选，或创建一项有明确正文与验收条件的工作。"}</p><button onClick={() => { setQuery(""); setFilter("open"); setKindFilter("all"); setDocumentStatus("active"); setScope("all"); }}>清除筛选</button></div>}
      <div className="list-footer"><span>{footerSummary}</span><div className="list-footer-actions">{(view === "documents" ? documents.nextCursor : tasks.nextCursor) && <button disabled={busy || searching} onClick={() => void more()}>{busy || searching ? "加载中…" : "加载更多"}</button>}{view === "work" && observedAt && <small>读取于 {observedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>}</div></div></>}
    </section>
    </div>{view === "work" && selectedTask && <TaskPreview token={token} projectId={projectId} id={selectedTask}
      item={projections.items[selectedTask]} actorId={context.principal.actorId} returnTo={listRoute} outsideFilter={!visibleTasks.some(task => task.id === selectedTask)} onClose={() => { selectionDismissed.current = true; setSelectedTask(""); }} />}</div>
    {view === "work" && leaderWork && <details className="leader-work-disclosure"><summary>查看全项目 Leader 对账 <span>按项目全部未关闭工作核对</span></summary><LeaderWorkOverview page={leaderWork} projectId={projectId}
      ownerNames={resolvedOwners} statuses={statuses} leaderStatuses={leaderStatuses}
      sessionNames={leaderSessionNames} sourceReading={leaderStatusReading || leaderSessionReading}
      sourceProblem={leaderStatusError || leaderSessionError} busy={leaderWorkBusy}
      onMore={() => void moreLeaderWork()} /></details>}
    {leaderWorkError && <p className="work-list-read-status" role="status">{leaderWorkError}</p>}
    {view === "work" && <nav className="work-context-tabs" aria-label="任务相关页面"><a href={href(projectId, "work")} aria-current="page">任务列表</a><a href={href(projectId, "journey")}>目标与阶段</a><a href={href(projectId, "inbox")} >依据复核{pending.length ? ` · ${pending.length}` : ""}</a></nav>}
    {view === "work" && <><p className="work-guidance">需要推进或调整工作时，先与已有 Agent 沟通；由 Agent 执行变更后，在这里回读核对。</p><div className="context-links"><a href={href(projectId, "journey")}>目标与阶段</a><a href={href(projectId, "discussions")}>阅读负责人讨论材料</a><a href={href(projectId, "documents")}>阅读过程文档</a><a href={href(projectId, "inbox")}>依据复核{pending.length ? `（${pending.length}）` : ""}</a></div></>}
  </div>;
}

function LeaderWorkOverview({ page, projectId, ownerNames, statuses, leaderStatuses, sessionNames,
  sourceReading, sourceProblem, busy, onMore }: {
  page: LeaderWorkPage<LeaderWorkTask>; projectId: string; ownerNames: Record<string, OwnerName>;
  statuses: Record<string, WorkTaskStatus>; leaderStatuses: Record<string, WorkTaskStatus>;
  sessionNames: Record<string, LeaderSessionName>; sourceReading: boolean; sourceProblem: string;
  busy: boolean; onMore: () => void;
}) {
  const counts = page.counts;
  const visible = [...page.items].sort((a, b) => leaderPhaseOrder.indexOf(a.phase as typeof leaderPhaseOrder[number]) -
    leaderPhaseOrder.indexOf(b.phase as typeof leaderPhaseOrder[number]));
  return <section className="leader-work" aria-labelledby="leader-work-title">
    <header><div><p className="eyebrow">Leader 对账</p><h2 id="leader-work-title">现在需要处理什么</h2></div><p>{page.observedAt ? `读于 ${new Date(page.observedAt).toLocaleString("zh-CN")}` : "尚未读回"} · 变更序号 {page.changeSequence}</p></header>
    <div className="leader-work-phases">{leaderPhaseOrder.filter(phase => counts[phase]).map(phase =>
      <span key={phase} className={`leader-phase phase-${phase}`}>{leaderPhaseLabel[phase]} <strong>{counts[phase]}</strong></span>)}</div>
    {(!!counts.review_deferred || !!counts.review_acknowledged) && <div className="leader-work-phases" aria-label="Leader 处理决定">
      {counts.review_deferred ? <span className="leader-phase phase-unassigned">已暂缓 <strong>{counts.review_deferred}</strong></span> : null}
      {counts.review_acknowledged ? <span className="leader-phase phase-ready">已核对 <strong>{counts.review_acknowledged}</strong></span> : null}
    </div>}
    {sourceReading && <p className="muted" role="status">正在核对 Leader 行的来源与责任名称…</p>}
    {sourceProblem && <p className="muted" role="status">{sourceProblem}</p>}
    {visible.length ? <ol className="leader-work-list">{visible.map(item => {
      const status = leaderStatuses[item.taskId] ?? statuses[item.taskId];
      const sessionKey = item.responsible.kind === "session" && item.responsible.id
        ? `${item.assignment?.targetKind === "external" ? "external" : "owned"}:${item.responsible.id}`
        : null;
      const presentation = leaderWorkItemPresentation(item, status,
        item.responsible.kind === "role" ? ownerNames[item.responsible.id ?? ""]?.title : undefined,
        sessionKey && sessionNames[sessionKey]
          ? sessionNames[sessionKey]!.title ?? "未登记展示名称"
          : undefined);
      return <li key={item.taskId}>
      <span className={`leader-phase phase-${item.phase}`}>{leaderPhaseLabel[item.phase]}</span>
      <div><a href={href(projectId,"task",item.taskId)}>{presentation.title}</a><p>{item.nextAction}</p>
        <small>{presentation.responsibility}
          {sessionKey && item.responsible.id && <> · <a href={`${href(projectId,"runtime")}?session=${encodeURIComponent(sessionKey)}&tab=overview`}>打开 Session</a> · <ShortId value={item.responsible.id} /></>}
          {item.plan?.priority?` · P${item.plan.priority}`:""}
          {item.dependencies.length?` · ${item.dependencies.length} 项依赖`:""}
          {item.plan?.dueAt?` · 截止 ${new Date(item.plan.dueAt).toLocaleString("zh-CN")}`:" · 截止未设置"}</small>
        <small>创建 {new Date(item.dates.createdAt).toLocaleString("zh-CN")} · 业务变化 {new Date(item.dates.businessChangedAt).toLocaleString("zh-CN")}
          {item.plan?.plannedStartAt?` · 计划开始 ${new Date(item.plan.plannedStartAt).toLocaleString("zh-CN")}`:""}
          {item.dates.startedAt?` · 实际开始 ${new Date(item.dates.startedAt).toLocaleString("zh-CN")}`:""}
          {item.dates.completedAt?` · 完成 ${new Date(item.dates.completedAt).toLocaleString("zh-CN")}`:""}
        </small>
        {item.review && <small className="leader-review-note">Leader {item.review.decision === "deferred" ? "已暂缓" : "已核对"}：
          {item.review.reason} · {new Date(item.review.at).toLocaleString("zh-CN")}</small>}</div>
      <span className="leader-action-key" title={item.actionKey}>任务 v{item.version}</span>
    </li>;
    })}</ol> : <p className="empty">当前没有未关闭工作。</p>}
    <footer>按当前 Task 版本、assignment、Run、Delivery、使用观察、依据复核和依赖派生；运行结束不等于验收。
      {page.partial && " 服务端只返回了部分工作，结果不完整。"}
      {page.nextCursor && <button type="button" className="quiet" disabled={busy} onClick={onMore}>
        {busy ? "正在读取 Leader 续页…" : `继续读取 Leader 对账（${page.items.length}/${page.total}）`}
      </button>}</footer>
  </section>;
}

function FileEmpty() { return <Search size={27} strokeWidth={1.4} aria-hidden="true" />; }

function TaskListTable({ tasks, statuses, projectId, pending, ownerNames, projections = {}, sessionNames = {}, actorId = "", returnTo, selected, onSelect }: { tasks: Task[]; statuses: Record<string, WorkTaskStatus>;
  projectId: string; pending: Impact[]; ownerNames: Record<string, OwnerName>;
  projections?: Record<string, LeaderWorkTask>; sessionNames?: Record<string, LeaderSessionName>; actorId?: string;
  returnTo?: string; selected?: string; onSelect?: (id: string) => void }) {
  return <div className="table-wrap task-scan-region" tabIndex={0} role="region" aria-label="任务列表，可滚动查看更多工作"><table className="task-list-table"><thead><tr><th>工作</th><th>进展</th><th>具体承接</th><th>下一入口</th><th><span className="sr-only">查看</span></th></tr></thead><tbody>{tasks.map(t => {
    const status=statuses[t.id], cognition=status?.cognition ? cognitionSummary(status) : null;
    const projection = matchingProjection(t, projections[t.id]);
    const nextAction = cognition?.next ?? projection?.nextAction ?? (status && businessNextStep(t,status)) ?? taskNextStep(t.state,t.legacyDecision);
    const phaseLabel = cognition?.phase ?? (projection && t.state !== "done" && t.state !== "cancelled" ? leaderPhaseLabel[projection.phase] : states[t.state]);
    const PhaseIcon = projection?.phase === "ready" ? CirclePlay
      : projection?.phase === "rework" || projection?.phase === "blocked" || projection?.phase === "awaiting_delivery" ? TriangleAlert
        : Clock3;
    const sessionKey = projection && assignmentSessionKey(projection);
    const taskLink = `${href(projectId, "task", t.id)}${returnTo ? `?list=${encodeURIComponent(returnTo)}` : ""}`;
    const sessionLink = sessionKey ? `${href(projectId, "runtime")}?session=${encodeURIComponent(sessionKey)}&tab=overview&actor=${encodeURIComponent(actorId)}&return=${encodeURIComponent(returnTo ?? href(projectId, "work"))}` : null;
    return <tr key={t.id} className={selected === t.id ? "selected-task-row" : undefined}>
      <td className="task-list-title">{onSelect ? <button className="task-row-select" aria-pressed={selected === t.id} onClick={() => onSelect(t.id)}>{cognition?.title ?? t.title}</button> : <a href={taskLink}>{cognition?.title ?? t.title}</a>}<small>v{t.version}{t.kind ? ` · ${taskKinds[t.kind]}` : ""}</small>
        <small>{pending.some(i => i.taskId===t.id) && <span className="impact-marker">依据待复核 · </span>}
          {cognition && <>判断接续记录 · <a href={href(projectId,"task",t.id)}>查看来源</a></>}</small>
        {cognition && <span className="work-status-context">{status?.goalOutcome && <>目标：{status.goalOutcome}</>}{status?.stageDeliverable && <> · 阶段产物：{status.stageDeliverable}</>}</span>}
        <span className="task-list-inline-next" title={nextAction}>{nextAction}</span>
        {selected && projection?.delivery && <a className="task-inline-result" href={`${taskLink}${returnTo ? "&" : "?"}tab=delivery`}>查看固定成果与使用 →</a>}</td>
      <td className="task-list-state"><span className="mobile-field-label">当前状态</span><span className={`task-state-display task-state-${t.state} phase-${projection?.phase ?? "unknown"}`}><PhaseIcon size={15} aria-hidden="true" />{phaseLabel}</span>
        {(cognition || projection && !["done", "cancelled"].includes(t.state) && leaderPhaseLabel[projection.phase] !== states[t.state]) && <small>任务 · {states[t.state]}</small>}</td>
      <td className="task-list-owner"><span className="mobile-field-label">{isClosedTask(t.state) ? "历史承接" : "具体承接"}</span>{sessionLink ? <><a href={sessionLink}>{sessionNames[sessionKey!]?.title ?? `Session ${projection!.assignment!.targetId.slice(0, 8)}`}</a><small>{assignmentStatusLabel(projection!)}</small></> : <><span className="task-list-owner-identity">{ownerNames[t.owner]?.title ? <a href={href(projectId, "roles")}>{ownerNames[t.owner]!.title}</a> : <code>{t.owner}</code>}{ownerNames[t.owner]?.title && <code title={t.owner}>{t.owner.slice(0, 8)}</code>}{ownerNames[t.owner]?.error && <small>{ownerNames[t.owner]!.error}</small>}</span><small>{["done", "cancelled"].includes(t.state) ? "无当前分派 · 历史见任务" : projection ? "待具体承接" : "承接尚未读回"}</small></>}</td>
      <td className="task-list-next"><span className="mobile-field-label">下一步</span>
        {t.legacyDecision && <strong className="task-list-legacy">{legacyDecisionLabel(t.legacyDecision)}</strong>}
        {projection?.delivery && <a className="task-row-result" href={`${taskLink}${returnTo ? "&" : "?"}tab=delivery`}>查看固定成果与使用 →</a>}
        {projection?.latestRun && t.state !== "done" && <small>{executionSummary(projection)}</small>}
        {cognition && <details className="task-list-legacy-reason"><summary>来源与决定理由</summary>
          <p>{status?.sourceKind === "loop.enrolled" ? "来自工作链首次规划。" : `正式来源：${status?.sourceKind ?? "未读回"}。`}</p>
          {status?.sourceTaskId && <p>源任务（现名称）：<a href={href(projectId,"task",status.sourceTaskId)}>{status.sourceTaskTitle ?? "打开源任务"}</a></p>}
          <p>署名决定：{status?.decisionKind ?? "未记录"}；{status?.decisionReason ?? "暂无可读理由"}</p>
          <a href={href(projectId,"task",t.id)}>打开原任务、运行与完整接续 →</a></details>}
        {t.legacyDecision && <details className="task-list-legacy-reason"><summary>查看旧判断理由</summary><p>{t.legacyDecision.reason}</p><a href={href(projectId,"task",t.id)}>打开任务核对历史 →</a></details>}</td>
      <td className="task-list-open"><a aria-label={`查看任务：${t.title}`} href={taskLink}><ChevronRight size={17} aria-hidden="true" /><span className="mobile-field-label">完整任务</span></a></td>
    </tr>;
  })}</tbody></table></div>;
}
