import { ReferencePanel } from "./references/ReferencePanel";
import { CollaborationPanel } from "./collaboration/CollaborationPanel";
import { DiscussionPanel } from "./discussions/DiscussionPanel";
import { KnowledgePanel } from "./knowledge/KnowledgePanel";
import { useEffect, useMemo, useRef, useState, useLayoutEffect, type FormEvent } from "react";
import type {
  Operation, Principal, Project,
} from "@evoloop/contracts";
import { api, ApiError, errorText, type Session } from "./api";
import { RuntimePanel } from "./runtime/RuntimePanel";
import { RolesPanel } from "./roles/RolesPanel";
import { SchedulingPanel } from "./scheduling/SchedulingPanel";
import { JourneyBoard } from "./workflow/JourneyBoard";
import { ActionForm, clearCommandDrafts, type MutationContext, type RecoverableCommand } from "./workflow/ActionForm";
import { addReceipt, readReceipts, removeReceipt, visibleReceipts as forPrincipal, writeReceipts, type OperationReceipt } from "./recovery";

import { readRoute, href, date, ShortId, Alert, type Route } from "./ui/shared";
import { TaskPage } from "./workflow/TaskPage";
import { DocumentPage } from "./documents/DocumentPage";
import { WorkbenchShell, sectionNames } from "./ui/WorkbenchShell";
import { WorkIndex } from "./workflow/WorkIndex";
function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const rememberList = () => {
      const current = readRoute();
      if (current.projectId && ["work", "inbox"].includes(current.section)) {
        try { sessionStorage.setItem(`evoloop:list:${current.projectId}`, window.location.hash); } catch { /* memory-only navigation remains available */ }
      }
    };
    rememberList();
    let previousHash = window.location.hash;
    const onHash = () => {
      const next = readRoute();
      if (next.projectId !== (previousHash.split("?")[0].split("/")[2] ?? null) && document.querySelector('[data-dirty="true"]') && !window.confirm("还有未提交的草稿。离开当前项目会清除页面草稿，确定离开？")) {
        window.location.replace(previousHash); return;
      }
      if (next.projectId !== (previousHash.split("?")[0].split("/")[2] ?? null)) clearCommandDrafts();
      const oldParts = previousHash.split("?")[0].split("/");
      if (next.section === "document" && next.projectId && oldParts[2] === next.projectId && !(oldParts[3] === "documents" && oldParts[4])) {
        try { sessionStorage.setItem(`evoloop:document-return:${next.projectId}`, previousHash); } catch { /* optional navigation state */ }
      }
      window.dispatchEvent(new Event("evoloop:will-navigate"));
      previousHash = window.location.hash;
      rememberList(); setRoute(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function AuthGate({ onSuccess, hasReceipts }: { onSuccess: (token: string, session: Session) => void; hasReceipts: boolean }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const value = input.trim();
      const session = await api(value).session();
      setInput("");
      onSuccess(value, session);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <main className="auth-shell">
    <div className="auth-card">
      <div className="eyebrow">evoLoop · 本机工作台</div>
      <h1>进入项目工作台</h1>
      <p>输入本机访问令牌以读取你有权限的项目。令牌只保存在当前页面内存中，刷新后需要重新输入。</p>
      {hasReceipts && <Alert>本浏览器会话保留了尚未核对的操作 ID。用原身份登录后可逐项查询；回执不包含令牌或复核正文。</Alert>}
      <form onSubmit={submit}>
        <label htmlFor="token">访问令牌</label>
        <input id="token" type="password" autoComplete="off" value={input} onChange={e => setInput(e.target.value)} required />
        <button className="primary" type="submit" disabled={busy}>{busy ? "正在核对…" : "进入"}</button>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  </main>;
}

function OperationCheck({ receipt, token, onConfirmed }: {
  receipt: OperationReceipt; token: string;
  onConfirmed: (result: Operation["result"]) => void;
}) {
  const [status, setStatus] = useState("这次操作可能已提交。请按原操作 ID 核对，确认前不要重复提交。");
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    try {
      const operation: Operation = await api(token).operation(receipt.projectId, receipt.operationId);
      if (operation.id !== receipt.operationId || operation.projectId !== receipt.projectId
        || operation.actorId !== receipt.actorId || operation.commandType !== receipt.commandType
        || operation.result.operationId !== receipt.operationId) {
        setStatus("操作记录与本地回执不匹配；仍需人工核对，不能据此重发。");
        return;
      }
      onConfirmed(operation.result);
    } catch (cause) {
      setStatus(cause instanceof ApiError && cause.status === 404
        ? "尚未查到操作记录；结果仍未确认。请核对服务状态后继续用同一 ID 查询。"
        : `暂未核清：${errorText(cause)}`);
    } finally { setBusy(false); }
  }
  return <Alert kind="error">
    <strong>提交结果待核对</strong><p>{status}</p>
    <p>项目 <ShortId value={receipt.projectId} /> · 对象 <ShortId value={receipt.taskId} /> · 提交于 {date(receipt.createdAt)}</p>
    <p>操作 ID：<code>{receipt.operationId}</code></p>
    <div className="actions"><button onClick={check} disabled={busy}>{busy ? "核对中…" : "按操作 ID 核对"}</button></div>
  </Alert>;
}

function ProjectChooser({ token, principal, receipts, onRefreshSession, context }: { token: string; principal: Principal; receipts: OperationReceipt[]; onRefreshSession: () => Promise<void>; context: MutationContext }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all(principal.projectIds.map(async id => {
      try { return { project: await api(token).project(id), id }; }
      catch { return { project: null, id }; }
    })).then(results => {
      if (!active) return;
      setProjects(results.flatMap(r => r.project ? [r.project] : []));
      setMissing(results.filter(r => !r.project).map(r => r.id));
    });
    return () => { active = false; };
  }, [principal.projectIds, token, refresh]);
  async function refreshProjects() {
    if (refreshing) return;
    setRefreshing(true); setRefreshError("");
    try { await onRefreshSession(); setRefresh(value => value + 1); }
    catch (cause) { setRefreshError(errorText(cause)); }
    finally { setRefreshing(false); }
  }
  return <section className="content narrow">
    <div className="eyebrow">选择项目</div><h1>你的项目</h1>
    <button type="button" className="quiet" onClick={refreshProjects} disabled={refreshing}>{refreshing ? "刷新中…" : "刷新项目"}</button>
    {refreshError && <Alert kind="error">刷新失败：{refreshError}</Alert>}
    {projects.length ? <div className="project-list">{projects.map(p => <a className="project-item" key={p.id} href={href(p.id, "work")}><strong>{p.title}</strong><span>{receipts.filter(r => r.projectId === p.id).length > 0 && `待核对操作 ${receipts.filter(r => r.projectId === p.id).length} 项 · `}<ShortId value={p.id} />　进入工作台 →</span></a>)}</div> : <Alert>当前没有可读取的项目。可在授权范围内创建项目，再留下目标与首份需求。</Alert>}
    {missing.length > 0 && <Alert>有 {missing.length} 个授权项目尚未创建或暂不可读取。服务异常时请先重试，已存在项目不会被覆盖。</Alert>}
    {missing.map(id => <section className="panel" key={id}><p>项目范围 <ShortId value={id} /></p><ActionForm context={{ ...context, projectId: id, onChanged: () => { setRefresh(v => v + 1); context.onChanged(); } }} title="创建项目" fields={[{ name: "title", label: "项目名称" }]} build={v => ({ type: "project.create", ...v })} /></section>)}
  </section>;
}

export function App() {
  const route = useRoute();
  const [token, setToken] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [receipts, setReceipts] = useState<OperationReceipt[]>(readReceipts);
  const receiptsRef = useRef(receipts);
  const [receiptStorageAvailable, setReceiptStorageAvailable] = useState(true);
  const [operationNotice, setOperationNotice] = useState("");
  const [projectError, setProjectError] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const projectId = route.projectId && session?.principal.projectIds.includes(route.projectId) ? route.projectId : null;
  const client = useMemo(() => api(token), [token]);
  const visibleReceipts = session ? forPrincipal(receipts, session.principal.actorId, session.principal.projectIds) : [];
  function replaceReceipts(next: OperationReceipt[]) {
    receiptsRef.current = next;
    setReceipts(next);
    setReceiptStorageAvailable(writeReceipts(next));
  }
  function beginAttempt(command: RecoverableCommand): boolean {
    if (!session) return false;
    const next = addReceipt(receiptsRef.current, {
      actorId: session!.principal.actorId,
      projectId: command.projectId,
      taskId: command.discussionId ?? command.taskId ?? command.goalId ?? command.stageId ?? command.documentId ?? command.projectId,
      operationId: command.operationId,
      commandType: command.type,
      createdAt: new Date().toISOString(),
    });
    if (!writeReceipts(next)) { setReceiptStorageAvailable(false); return false; }
    receiptsRef.current = next;
    setReceipts(next);
    setReceiptStorageAvailable(true);
    return true;
  }
  function finishKnown(operationId: string) {
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
  useEffect(() => {
    if (!projectId || !session) return;
    let active = true;
    client.project(projectId).then(p => { if (active) { setProjectError(""); setProjectTitle(p.title); } })
      .catch(cause => { if (active) setProjectError(errorText(cause)); });
    return () => { active = false; };
  }, [client, projectId, session, refresh]);
  if (!session) return <AuthGate hasReceipts={receipts.length > 0} onSuccess={(value, next) => { setToken(value); setSession(next); }} />;
  const principal = session.principal;
  const context: MutationContext = { token, projectId: projectId ?? "", principal, blocked: visibleReceipts.some(r => r.projectId === projectId), onAttempt: beginAttempt, onKnown: finishKnown, onChanged: () => setRefresh(v => v + 1) };
  function logout() {
    if (document.querySelector('[data-dirty="true"]') && !window.confirm("还有未提交的草稿。退出会清除本页草稿，确定退出？")) return;
    if (visibleReceipts.length && !window.confirm(`仍有 ${visibleReceipts.length} 个结果未确认的操作。回执会留在当前浏览器会话；退出后请用同一身份登录核对。确定退出？`)) return;
    clearCommandDrafts(); setToken(""); setSession(null);
  }
  if (!projectId) return <div className="app-shell"><header className="project-chooser-header"><a className="brand" href="#/">evoLoop</a><button className="quiet" onClick={logout}>退出</button></header><ProjectChooser context={context} token={token} principal={principal} receipts={visibleReceipts} onRefreshSession={async () => setSession(await api(token).session())} /></div>;
  const projectReceipts = visibleReceipts.filter(r => r.projectId === projectId);
  const operationChecks = <>{projectReceipts.map(receipt => <div className="global-alert" key={receipt.operationId}><OperationCheck receipt={receipt} token={token} onConfirmed={result => {
    setOperationNotice(result.status === "applied" ? `操作 ${receipt.operationId} 已应用；正在回读当前数据。` : `操作 ${receipt.operationId} 被拒绝：${result.message}`);
    replaceReceipts(removeReceipt(receiptsRef.current, receipt.operationId)); setRefresh(v => v + 1);
  }} /></div>)}{!projectReceipts.length && <p className="empty">当前身份没有待核对的共同命令回执。知识、外部来源和协作操作的专用回执仍在各自页面核对。</p>}</>;
  return <WorkbenchShell route={route} projectTitle={projectTitle} actor={principal.actorId} receiptCount={projectReceipts.length} logout={logout}>
    {route.section !== "operations" && projectReceipts.length > 0 && <div className="global-alert"><Alert kind="error">{projectReceipts.length} 项操作结果尚未确认，提交已暂缓。<a href={href(projectId, "operations")}>按原操作 ID 核对</a></Alert></div>}
    {!receiptStorageAvailable && <div className="global-alert"><Alert kind="error">浏览器未能暂存操作回执。请保留原操作 ID，并在待核对操作中查询。</Alert></div>}
    {operationNotice && <div className="global-alert"><Alert>{operationNotice} <button className="quiet" onClick={() => setOperationNotice("")}>关闭</button></Alert></div>}
    {projectError && <div className="global-alert"><Alert kind="error">项目暂不可读取：{projectError} <button onClick={context.onChanged}>重试读取项目</button></Alert></div>}
    <WorkspacePages key={`${principal.actorId}:${projectId}`} route={route} context={context} refresh={refresh} operations={operationChecks} />
  </WorkbenchShell>;
}

function WorkspacePages({ route, context, refresh, operations }: { route: Route; context: MutationContext; refresh: number; operations: React.ReactNode }) {
  // Visited pages stay mounted for this authenticated project. No form text or token is persisted.
  const cache = useRef(new Map<string, Route>());
  const positions = useRef(new Map<string, number>());
  const key = `${route.section}:${route.id ?? ""}:${route.revision ?? ""}:${route.action ?? ""}`;
  cache.current.set(key, route);
  useLayoutEffect(() => {
    const handle = requestAnimationFrame(() => {
      window.scrollTo(0, positions.current.get(key) ?? 0);
      document.querySelector<HTMLElement>(`[data-page-key="${CSS.escape(key)}"] h1`)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(handle);
  }, [key]);
  useEffect(() => {
    const remember = () => positions.current.set(key, window.scrollY);
    window.addEventListener("evoloop:will-navigate", remember);
    return () => window.removeEventListener("evoloop:will-navigate", remember);
  }, [key]);
  const { projectId, token, principal } = context;
  function page(r: Route) {
    if (["work", "inbox", "documents"].includes(r.section)) return <WorkIndex context={context} refresh={refresh} view={r.section as "work" | "inbox" | "documents"} />;
    if (r.section === "task" && r.id) return <TaskPage context={context} token={token} projectId={projectId} id={r.id} selectedRevision={r.revision} refresh={refresh} onChanged={context.onChanged} onAttempt={context.onAttempt} onKnown={context.onKnown} blockedByUnknown={context.blocked} canReview={principal.permissions.includes("review")} />;
    if (r.section === "document" && r.id) return <DocumentPage context={context} refresh={refresh} token={token} projectId={projectId} id={r.id} selectedRevision={r.revision} />;
    if (r.section === "knowledge") return <div className="content knowledge-page"><h1 tabIndex={-1}>知识空间</h1><KnowledgePanel context={context} refresh={refresh} /></div>;
    if (r.section === "operations") return <div className="content"><h1 tabIndex={-1}>待核对操作</h1><p className="lede">结果未知时先查原操作 ID，确认前不要重复提交。</p>{operations}</div>;
    if (r.section === "repository") return <div className="content"><h1 tabIndex={-1}>仓库规范</h1><p className="lede">产品、架构与开发规范由仓库 docs 维护。它们与过程文档分别保存。</p><section className="panel"><h2>正式文档</h2><div className="repository-links"><a href="https://github.com/cyl19970726/evoLoop/blob/main/CONTRIBUTING.md" target="_blank" rel="noreferrer">贡献与变更入口 ↗</a><a href="https://github.com/cyl19970726/evoLoop/blob/main/docs/README.md" target="_blank" rel="noreferrer">文档目录 ↗</a><a href="https://github.com/cyl19970726/evoLoop/blob/main/docs/decisions.md" target="_blank" rel="noreferrer">当前决定 ↗</a></div><p className="muted">以上打开仓库现行文档；任务实际采用的固定 commit 与摘要在相应任务依据中查阅。</p></section><details className="workflow-detail"><summary>登记固定 Git 来源与正式采用</summary><ReferencePanel context={context} /></details></div>;
    if (r.section === "overview") return <div className="content"><h1 tabIndex={-1}>总览</h1><p className="lede">总览将在工作、文档知识与协作路径经实际使用反馈后整理。</p><section className="panel"><h2>从当前工作开始</h2><p>先阅读真实对象与证据，再判断下一步。</p><div className="context-links"><a href={href(projectId, "work")}>查看任务</a><a href={href(projectId, "journey")}>目标与阶段</a><a href={href(projectId, "discussions")}>负责人讨论</a><a href={href(projectId, "knowledge")}>阅读知识</a></div></section></div>;
    const components = { journey: <JourneyBoard context={context} refresh={refresh} propose={r.action === "propose"} />, discussions: <DiscussionPanel context={context} refresh={refresh} />, runtime: <RuntimePanel context={context} refresh={refresh} />, schedules: <SchedulingPanel context={context} refresh={refresh} />, roles: <RolesPanel context={context} refresh={refresh} />, collaboration: <CollaborationPanel context={context} refresh={refresh} /> };
    return <div className="content"><h1 tabIndex={-1}>{sectionNames[r.section]}</h1>{components[r.section as keyof typeof components]}</div>;
  }
  return <>{Array.from(cache.current.entries()).map(([pageKey, r]) => <div key={pageKey} data-page-key={pageKey} hidden={pageKey !== key}>{page(r)}</div>)}</>;
}
