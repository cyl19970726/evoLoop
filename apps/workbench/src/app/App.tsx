import { Suspense, lazy, useEffect, useMemo, useRef, useState, useLayoutEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import type { Operation } from "@evoloop/contracts";
import { ApiError, api, errorText, type Session } from "../shared/api";
import { onUnauthorized, signIn, signOut } from "../shared/identity";
import { clearCommandDrafts, type MutationContext, type RecoverableCommand } from "../shared/ActionForm";
import { addReceipt, hasProjectReceipt, readReceipts, removeReceipt, visibleReceipts as forPrincipal, writeReceipts, type OperationReceipt } from "./recovery";
import { clearRecoveryIntents, forgetRecoveryIntent, isSpecialOperation, rememberRecoveryIntent } from "./recoveryIntent";

import { readRoute, href, type Route } from "../shared/ui/shared";
import { clearKnowledgeReturnsOnLogin, rememberKnowledgeSource } from "../shared/ui/returnRoute";
import { appHistory, appPath, currentPath, navigate, onNavigate } from "../shared/navigation";
import { leaveProject, projectChanged, useProjectQuery } from "../shared/query";
import { queryClient } from "./queryClient";
import { sectionLabels } from "./shell/spaces";
import { PageBoundary } from "./PageBoundary";
import { PageActive } from "../shared/ui/pageActive";
import { AuthGate } from "./entry/AuthGate";

// Each page is its own chunk: the first load carries login, the shell and shared code only.
// lazy() accepts any component; the props stay typed through M[K].
function named<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K): LazyExoticComponent<M[K]> {
  return lazy(async () => ({ default: (await load())[name] }));
}
const ReferencePanel = named(() => import("../features/references/ReferencePanel"), "ReferencePanel");
const CollaborationPanel = named(() => import("../features/collaboration/CollaborationPanel"), "CollaborationPanel");
const KnowledgePanel = named(() => import("../features/knowledge/KnowledgePanel"), "KnowledgePanel");
const EvaluationPage = named(() => import("../features/evaluation/EvaluationPage"), "EvaluationPage");
const TeamWorkspace = named(() => import("../features/team/TeamWorkspace"), "TeamWorkspace");
const SchedulingPanel = named(() => import("../features/scheduling/SchedulingPanel"), "SchedulingPanel");
const JourneyBoard = named(() => import("../features/workflow/JourneyBoard"), "JourneyBoard");
const TaskPage = named(() => import("../features/workflow/TaskPage"), "TaskPage");
const DocumentPage = named(() => import("../features/documents/DocumentPage"), "DocumentPage");
const DocumentIndex = named(() => import("../features/documents/DocumentIndex"), "DocumentIndex");
const WorkIndex = named(() => import("../features/workflow/WorkIndex"), "WorkIndex");
const CreateTaskPage = named(() => import("../features/workflow/CreateTaskPage"), "CreateTaskPage");
const ProjectSummary = named(() => import("../features/overview/ProjectSummary"), "ProjectSummary");
const ProjectSettings = named(() => import("../features/settings/ProjectSettings"), "ProjectSettings");
const OperationsPage = named(() => import("../features/settings/OperationsPage"), "OperationsPage");
const RepositoryPage = named(() => import("../features/settings/RepositoryPage"), "RepositoryPage");
const SessionWorkspace = named(() => import("../features/sessions/SessionWorkspace"), "SessionWorkspace");
const ArrangementPage = named(() => import("../features/sessions/ArrangementPage"), "ArrangementPage");
const ConnectorPage = named(() => import("../features/connectors/ConnectorPage"), "ConnectorPage");
// The frame loads after login; the login gate starts fetching it while the token is typed.
const loadShell = () => import("./shell/AppShell");
const AppShell = named(loadShell, "AppShell");
type ShellNoticeItem = import("./shell/AppShell").ShellNoticeItem;
const prefetchShell = () => { void loadShell(); };
// Shown only after login, so they load with the shell instead of the login page.
const ProjectChooser = named(() => import("./entry/ProjectChooser"), "ProjectChooser");
const OperationCheck = named(() => import("./entry/OperationCheck"), "OperationCheck");

/** Session caches live in the Session page module; if it was never loaded there is nothing to clear. */
function clearSessionSnapshots() {
  void import("../features/sessions/SessionWorkspace").then(module => module.clearSessionSnapshots(), () => undefined);
}

function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const projectOf = (path: string) => path.split("?")[0]!.split("/")[2] ?? null;
    const rememberList = () => {
      const current = readRoute();
      if (current.projectId && ["work", "inbox"].includes(current.section)) {
        try { sessionStorage.setItem(`evoloop:list:${current.projectId}`, currentPath()); } catch { /* memory-only navigation remains available */ }
      }
    };
    rememberList();
    let previousPath = currentPath();
    // Leaving the project with unsaved drafts asks first; Back and Forward are asked too.
    const unblock = appHistory().block({
      blockerFn: ({ currentLocation, nextLocation }) => projectOf(nextLocation.pathname) !== projectOf(currentLocation.pathname)
        && !!document.querySelector('[data-dirty="true"]')
        && !window.confirm("还有未提交的草稿。离开当前项目会清除页面草稿，确定离开？"),
      enableBeforeUnload: false,
    });
    const stop = onNavigate(() => {
      const nextPath = currentPath();
      if (nextPath === previousPath) return;
      const next = readRoute();
      if (next.projectId !== projectOf(previousPath)) clearCommandDrafts();
      const oldParts = previousPath.split("?")[0]!.split("/");
      if (next.section === "document" && next.projectId && oldParts[2] === next.projectId && !(oldParts[3] === "documents" && oldParts[4])) {
        try { sessionStorage.setItem(`evoloop:document-return:${next.projectId}`, previousPath); } catch { /* optional navigation state */ }
      }
      if (next.section === "knowledge" && next.projectId && oldParts[2] === next.projectId && oldParts[3] !== "knowledge") {
        rememberKnowledgeSource(next.projectId, previousPath, nextPath);
      }
      window.dispatchEvent(new Event("evoloop:will-navigate"));
      previousPath = nextPath;
      rememberList(); setRoute(next);
    });
    return () => { stop(); unblock(); };
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const [token, setToken] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [authNotice, setAuthNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [receipts, setReceipts] = useState<OperationReceipt[]>(readReceipts);
  const receiptsRef = useRef(receipts);
  const attemptInFlight = useRef(false);
  const [receiptStorageAvailable, setReceiptStorageAvailable] = useState(true);
  const [operationNotice, setOperationNotice] = useState("");
  const projectId = route.projectId && session?.principal.projectIds.includes(route.projectId) ? route.projectId : null;
  const client = useMemo(() => api(token), [token]);
  const visibleReceipts = session ? forPrincipal(receipts, session.principal.actorId, session.principal.projectIds) : [];
  function replaceReceipts(next: OperationReceipt[]) {
    receiptsRef.current = next;
    setReceipts(next);
    setReceiptStorageAvailable(writeReceipts(next));
  }
  async function beginAttempt(command: RecoverableCommand): Promise<boolean> {
    if (!session || attemptInFlight.current || hasProjectReceipt(forPrincipal(receiptsRef.current, session.principal.actorId, [command.projectId]), command.projectId)) return false;
    attemptInFlight.current = true;
    try {
      const commandHash = await rememberRecoveryIntent(session.principal.actorId, command);
      const next = addReceipt(receiptsRef.current, {
        actorId: session.principal.actorId,
        projectId: command.projectId,
        taskId: command.discussionId ?? command.taskId ?? command.goalId ?? command.stageId ?? command.documentId ?? command.projectId,
        operationId: command.operationId,
        commandType: command.type,
        createdAt: new Date().toISOString(),
        ...(commandHash ? { commandHash } : {}),
      });
      if (!writeReceipts(next)) { forgetRecoveryIntent(command.operationId); setReceiptStorageAvailable(false); return false; }
      receiptsRef.current = next;
      setReceipts(next);
      setReceiptStorageAvailable(true);
      return true;
    } catch { forgetRecoveryIntent(command.operationId); return false; }
    finally { attemptInFlight.current = false; }
  }
  function finishKnown(operationId: string) {
    forgetRecoveryIntent(operationId);
    replaceReceipts(removeReceipt(receiptsRef.current, operationId));
  }
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!receiptsRef.current.length && !document.querySelector('[data-dirty="true"]')) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  const projectRead = useProjectQuery(projectId ?? "", ["project"], () => client.project(projectId!), { enabled: !!session });
  const projectTitle = projectRead.data?.title ?? "";
  const acceptance = useProjectQuery(projectId ?? "", ["acceptance", "mine"], () => client.acceptanceMine(projectId!), { enabled: !!session });
  const acceptanceCount = acceptance.data?.items.length ?? 0;
  const projectError = projectRead.error ? errorText(projectRead.error) : "";
  const shownProject = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownProject.current;
    shownProject.current = projectId;
    if (previous && previous !== projectId) void leaveProject(queryClient, previous);
  }, [projectId]);
  /** Logout or a lost login: nothing read or drafted under this identity stays in the page. Receipts stay for the same identity. */
  function endSession() {
    clearCommandDrafts(); clearRecoveryIntents(); clearSessionSnapshots(); queryClient.clear(); signOut(); setToken(""); setSession(null);
  }
  const ended = useRef(endSession);
  ended.current = endSession;
  useEffect(() => onUnauthorized(() => {
    if (!sessionRef.current) return;
    setAuthNotice("登录已失效，页面内容已清除。请重新登录；未确认的操作回执仍保留，用原身份登录后可核对。");
    ended.current();
  }), []);
  // A 403 on the project itself means the grant is gone: reread the identity, and leave the project if it is no longer granted.
  useEffect(() => {
    if (!(projectRead.error instanceof ApiError) || projectRead.error.status !== 403 || !route.projectId) return;
    let active = true;
    void api(token).session().then(next => {
      if (!active) return;
      setSession(next);
      if (!next.principal.projectIds.includes(route.projectId!)) {
        void leaveProject(queryClient, route.projectId!);
        setOperationNotice("你已无权访问该项目，已回到项目列表。");
        navigate("/", { replace: true });
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [projectRead.error, route.projectId, token]);
  /** A write applied: pages reread (refresh) and the project's queries go stale. */
  const changed = () => { setRefresh(v => v + 1); if (projectId) void projectChanged(queryClient, projectId); };
  if (!session) return <AuthGate hasReceipts={receipts.length > 0} notice={authNotice} prefetch={prefetchShell} onSuccess={(value, next) => {
    clearKnowledgeReturnsOnLogin(next.principal.projectIds);
    queryClient.clear();
    signIn(value); setAuthNotice("");
    setToken(value); setSession(next);
  }} />;
  const principal = session.principal;
  const context: MutationContext = { token, projectId: projectId ?? "", principal, blocked: visibleReceipts.some(r => r.projectId === projectId), onAttempt: beginAttempt, onKnown: finishKnown, onChanged: changed };
  function logout() {
    if (document.querySelector('[data-dirty="true"]') && !window.confirm("还有未提交的草稿。退出会清除本页草稿，确定退出？")) return;
    if (visibleReceipts.length && !window.confirm(`仍有 ${visibleReceipts.length} 个结果未确认的操作。回执会留在当前浏览器会话；退出后请用同一身份登录核对。确定退出？`)) return;
    endSession();
  }
  function confirmReceipt(receipt: OperationReceipt, result: Operation["result"]) {
    forgetRecoveryIntent(receipt.operationId);
    const scope = isSpecialOperation(receipt.commandType) ? "已核到服务端同身份、同项目、同类型及同 ID 的操作结果；浏览器未核对原提交正文摘要。" : "";
    setOperationNotice(`${result.status === "applied" ? `操作 ${receipt.operationId} 已应用；正在回读当前数据。` : `操作 ${receipt.operationId} 被拒绝：${result.message}`} ${scope}`.trim());
    replaceReceipts(removeReceipt(receiptsRef.current, receipt.operationId)); changed();
  }
  if (!projectId) return <Suspense fallback={<p role="status" className="p-8 text-small">正在打开项目列表…</p>}><ProjectChooser context={context} token={token} principal={principal} receipts={visibleReceipts} operationNotice={operationNotice} onConfirmed={confirmReceipt} onRefreshSession={async () => setSession(await api(token).session())} logout={logout} /></Suspense>;
  const projectReceipts = visibleReceipts.filter(r => r.projectId === projectId);
  // OperationCheck loads on demand; its own boundary keeps a first receipt from suspending the page around it.
  const operationChecks = projectReceipts.map(receipt => <Suspense key={receipt.operationId} fallback={null}><OperationCheck receipt={receipt} token={token} onConfirmed={result => confirmReceipt(receipt, result)} /></Suspense>);
  const notices: ShellNoticeItem[] = [
    ...route.section !== "operations" && projectReceipts.length > 0 ? [{ key: "receipts", tone: "error" as const, text: `${projectReceipts.length} 项操作结果尚未确认，提交已暂缓。`, link: { href: href(projectId, "operations"), label: "按原操作 ID 核对" } }] : [],
    ...!receiptStorageAvailable ? [{ key: "storage", tone: "error" as const, text: "浏览器未能暂存操作回执。请保留原操作 ID，并在待核对操作中查询。" }] : [],
    ...operationNotice ? [{ key: "operation", tone: "info" as const, text: operationNotice, button: { label: "关闭", onClick: () => setOperationNotice(""), quiet: true } }] : [],
    ...projectError ? [{ key: "project", tone: "error" as const, text: `项目暂不可读取：${projectError}`, button: { label: "重试读取项目", onClick: context.onChanged } }] : [],
  ];
  return <Suspense fallback={<p className="content" role="status">正在打开工作台…</p>}><AppShell route={route} projectId={projectId} projectTitle={projectTitle} actor={principal.actorId} permissions={principal.permissions}
    receiptCount={projectReceipts.length} inboxCount={acceptanceCount} token={token} logout={logout} notices={notices}>
    <WorkspacePages key={`${principal.actorId}:${projectId}`} route={route} context={context} refresh={refresh} operations={operationChecks} />
  </AppShell></Suspense>;
}

function WorkspacePages({ route, context, refresh, operations }: { route: Route; context: MutationContext; refresh: number; operations: ReactNode[] }) {
  // Visited pages stay mounted for this authenticated project. No form text or token is persisted.
  const cache = useRef(new Map<string, Route>());
  const positions = useRef(new Map<string, number>());
  const key = `${route.section}:${route.id ?? ""}:${route.revision ?? ""}:${route.action ?? ""}:${route.session ?? ""}`;
  const positionKey = `evoloop:scroll:${context.principal.actorId}:${context.projectId}:${key}`;
  cache.current.set(key, route);
  useLayoutEffect(() => {
    let position = positions.current.get(key);
    if (position === undefined) {
      try { position = Number(sessionStorage.getItem(positionKey)) || 0; } catch { position = 0; }
    }
    let cancelled = false, frame = 0, handle = 0;
    const stop = () => { cancelled = true; cancelAnimationFrame(handle); };
    const restore = () => {
      if (cancelled) return;
      window.scrollTo(0, position);
      if (Math.abs(window.scrollY - position) > 2 && ++frame < 120) handle = requestAnimationFrame(restore);
    };
    handle = requestAnimationFrame(() => {
      restore();
      // The landmark stays focusable while page titles may still be loading.
      document.getElementById("workspace-main")?.focus({ preventScroll: true });
    });
    window.addEventListener("wheel", stop, { once: true });
    window.addEventListener("touchstart", stop, { once: true });
    return () => { stop(); window.removeEventListener("wheel", stop); window.removeEventListener("touchstart", stop); };
  }, [key, positionKey]);
  useEffect(() => {
    const remember = () => {
      positions.current.set(key, window.scrollY);
      try { sessionStorage.setItem(positionKey, String(window.scrollY)); } catch { /* optional position persistence */ }
    };
    let leaving = false;
    const beforeLink = (event: MouseEvent) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
      const path = link ? appPath(link.getAttribute("href") ?? "") : null;
      if (path && path !== currentPath()) { remember(); leaving = true; }
    };
    const onScroll = () => { if (!leaving) remember(); };
    document.addEventListener("click", beforeLink, true);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", remember);
    return () => { document.removeEventListener("click", beforeLink, true); window.removeEventListener("scroll", onScroll); window.removeEventListener("pagehide", remember); };
  }, [key, positionKey]);
  const { projectId, token, principal } = context;
  function page(r: Route, active: boolean) {
    if (r.section === "documents") return <DocumentIndex context={context} refresh={refresh} />;
    if (["work", "inbox"].includes(r.section)) return <WorkIndex context={context} refresh={refresh} view={r.section as "work" | "inbox"} />;
    if (r.section === "create-task") return <CreateTaskPage context={context} refresh={refresh} />;
    if (r.section === "task" && r.id) return <TaskPage context={context} token={token} projectId={projectId} id={r.id} selectedRevision={r.revision} refresh={refresh} onChanged={context.onChanged} onAttempt={context.onAttempt} onKnown={context.onKnown} blockedByUnknown={context.blocked} canReview={principal.permissions.includes("review")} active={active} />;
    if (r.section === "document" && r.id) return <DocumentPage context={context} refresh={refresh} projectId={projectId} id={r.id} selectedRevision={r.revision} />;
    if (r.section === "knowledge") return <KnowledgePanel context={context} refresh={refresh} />;
    if (r.section === "evaluations") {
      const query = new URLSearchParams(currentPath().split("?")[1] ?? "");
      return <EvaluationPage context={context} evaluationId={r.id} selectedRevision={r.revision} refresh={refresh}
        taskId={query.get("taskId") ?? undefined} knowledgePageId={query.get("knowledgePageId") ?? undefined} />;
    }
    if (r.section === "operations") return <OperationsPage projectId={projectId} checks={operations} />;
    if (r.section === "repository") return <RepositoryPage projectId={projectId} reference={<ReferencePanel context={context} />} />;
    if (r.section === "sessions") return r.session
      ? <SessionWorkspace context={context} refresh={refresh} sessionKey={r.session} active={active} />
      : <ArrangementPage context={context} refresh={refresh} />;
    if (r.section === "schedules") return <SchedulingPanel context={context} refresh={refresh} />;
    if (r.section === "overview") return <ProjectSummary token={token} projectId={projectId} refresh={refresh} active={active} />;
    if (r.section === "settings") return <ProjectSettings context={context} refresh={refresh} />;
    if (r.section === "connectors") return <ConnectorPage context={context} />;
    const components = { reviews: <TeamWorkspace context={context} refresh={refresh} section="reviews" />, journey: <JourneyBoard context={context} refresh={refresh} propose={r.action === "propose"} />, discussions: <TeamWorkspace context={context} refresh={refresh} section="discussions" />, runtime: r.session?.includes(":") ? <SessionWorkspace context={context} refresh={refresh} sessionKey={r.session} active={active} /> : <TeamWorkspace context={context} refresh={refresh} section="runtime" sessionId={r.session} />, schedules: <SchedulingPanel context={context} refresh={refresh} />, roles: <TeamWorkspace context={context} refresh={refresh} section="roles" />, collaboration: <CollaborationPanel context={context} refresh={refresh} /> };
    if (r.section === "runtime" || r.section === "discussions" || r.section === "reviews" || r.section === "roles") return components[r.section];
    return <div className="content"><h1 tabIndex={-1}>{sectionLabels[r.section]}</h1>{components[r.section as keyof typeof components]}</div>;
  }
  return <>{Array.from(cache.current.entries()).map(([pageKey, r]) => <div key={pageKey} data-page-key={pageKey} hidden={pageKey !== key}>
    <PageActive.Provider value={pageKey === key}><PageBoundary><Suspense fallback={<p className="content" role="status">正在打开页面…</p>}>{page(r, pageKey === key)}</Suspense></PageBoundary></PageActive.Provider></div>)}</>;
}
