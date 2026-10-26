import { useEffect, useRef, useState } from "react";
import type { SessionActivity, SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { ApiError, errorText } from "../api";
import { ActionForm, option, type MutationContext } from "../workflow/ActionForm";
import { Alert, date, href } from "../ui/shared";
import { sessionClient } from "./client";
import { SessionOpenEntry } from "./SessionOpenEntry";
import { AllocationBacklinks } from "../discussions/AllocationBacklinks";
import { queuePosition, queueStateLabel } from "./queuePresentation";
import { activityPresentation } from "./activityPresentation";
import { SessionRecoveryOverview, SessionRecoveryResources } from "./SessionRecoveryObservation";
import { checkedRecoveryView, type RecoveryRead } from "./recoveryPresentation";
import { sessionLifecycleLabel, sessionStatusLabel } from "./sessionStatusPresentation";
import { sessionMessageEntry } from "./sessionMessageEntry";
import "./workspace.css";

type Tab = "activity" | "queue" | "results" | "responsibilities" | "resources";
const tabLabels: Record<Tab, string> = { activity: "活动与对话", queue: "任务队列", results: "结果与使用", responsibilities: "职责与分派", resources: "资源" };
function tabFromHash(sessionKey: string): Tab {
  const values = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const value = values.get("tab");
  return values.get("session") === sessionKey && value && value in tabLabels ? value as Tab : "activity";
}
const remember = new Map<string, SessionSnapshot>();
export function clearSessionSnapshots() { remember.clear(); }
function rememberSnapshot(scope: string, snapshot: SessionSnapshot) {
  remember.delete(scope); remember.set(scope, snapshot);
  while (remember.size > 2) remember.delete(remember.keys().next().value!);
}
const bounded = (old: SessionActivity[], newer: SessionActivity[]) => {
  const merged = new Map(old.map(item => [item.id, item]));
  for (const item of newer) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => BigInt(a.sequence) === BigInt(b.sequence) ? 0 : BigInt(a.sequence) > BigInt(b.sequence) ? -1 : 1).slice(0, 300);
};

export function SessionWorkspace({ context, sessionKey, active, refresh }: { context: MutationContext; sessionKey: string; active: boolean; refresh: number }) {
  const scope = `${context.principal.actorId}:${context.projectId}:${sessionKey}`;
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(() => remember.get(scope) ?? null);
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyPartial, setHistoryPartial] = useState(false);
  const [historyLimitations, setHistoryLimitations] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>(() => tabFromHash(sessionKey));
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [loading, setLoading] = useState(true);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [readAgain, setReadAgain] = useState(0);
  const [recoveryRead, setRecoveryRead] = useState<RecoveryRead>({ status: "loading" });
  const epoch = useRef(0);
  const historyAbort = useRef<AbortController | null>(null);
  const historyScope = useRef("");
  historyScope.current = `${context.token}\0${scope}\0${active}\0${refresh}\0${readAgain}`;
  const cursor = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const pollInterval = snapshot?.session.key === sessionKey && snapshot.session.busy === false ? 15000 : 5000;
  useEffect(() => {
    const sync = () => { if (active) setTab(tabFromHash(sessionKey)); };
    sync(); window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [sessionKey, active]);
  useEffect(() => {
    if (!active) return;
    const current = ++epoch.current;
    historyAbort.current?.abort(); historyAbort.current = null;
    const controller = new AbortController();
    const client = sessionClient(context.token, context.projectId);
    let checking = false;
    let recoveryChecking = false;
    let recoveryTarget: string | null = null;
    cursor.current = null;
    const saved = remember.get(scope) ?? null;
    setSnapshot(saved); setActivity(saved?.activity ?? []); setHistoryCursor(null); setHistoryLoaded(false);
    setHistoryPartial(false); setHistoryLimitations([]); setHistoryError(""); setHistoryBusy(false); setError(""); setLoading(true);
    setRecoveryRead({ status: "loading" });
    async function readRecovery(sessionId: string) {
      if (document.visibilityState === "hidden" || recoveryChecking) return;
      recoveryChecking = true;
      try {
        const view = checkedRecoveryView(await client.recovery(sessionId, controller.signal), context.projectId, sessionId);
        if (epoch.current === current && recoveryTarget === sessionId) setRecoveryRead({ status: "ready", view });
      } catch (cause) {
        if (controller.signal.aborted || epoch.current !== current || recoveryTarget !== sessionId) return;
        if (cause instanceof ApiError && cause.status === 404) setRecoveryRead({ status: "unavailable", message: "接口或对象不可用；请核对当前会话与服务记录。" });
        else if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setRecoveryRead({ status: "forbidden", message: "请核对项目读取权限。" });
        else if (cause instanceof ApiError && cause.status === 0) setRecoveryRead({ status: "failed", message: "连接中断或超时；无法据此判断恢复状态。" });
        else setRecoveryRead({ status: "failed", message: errorText(cause) });
      } finally { recoveryChecking = false; }
    }
    async function read() {
      const version = ++requestVersion.current;
      try {
        const result = await client.snapshot(sessionKey, controller.signal);
        if (epoch.current !== current || version !== requestVersion.current) return;
        if (result.session.key !== sessionKey) throw new Error("会话响应与所选 Session 不符");
        cursor.current = result.observationCursor;
        rememberSnapshot(scope, result); setSnapshot(result);
        setActivity(old => bounded(old, result.activity)); setError("");
        recoveryTarget = result.session.kind === "owned" && result.session.target.kind === "owned" ? result.session.target.sessionId : null;
        if (recoveryTarget) void readRecovery(recoveryTarget);
      } catch (cause) { if (!controller.signal.aborted && epoch.current === current && version === requestVersion.current) {
        setError(errorText(cause)); setRecoveryRead({ status: "failed", message: "请先重新读取当前会话。" });
      } }
      finally { if (epoch.current === current && version === requestVersion.current) setLoading(false); }
    }
    void read();
    async function checkChanges() {
      if (document.visibilityState === "hidden" || !cursor.current || checking) return;
      checking = true;
      try {
        const seen = new Set<string>();
        const startedFrom = cursor.current;
        let next: string | null = startedFrom;
        let affected = false;
        for (let batch = 0; batch < 3; batch++) {
          const changes = await client.changes(next!, sessionKey, controller.signal);
          if (epoch.current !== current) return;
          if (changes.resetRequired) { affected = true; next = null; break; }
          if (seen.has(changes.nextCursor)) break;
          seen.add(changes.nextCursor);
          affected ||= changes.items.some(item => !item.sessionKeys.length || item.sessionKeys.includes(sessionKey));
          next = changes.nextCursor;
          if (!changes.hasMore) break;
        }
        if (epoch.current !== current || cursor.current !== startedFrom) return;
        if (next) cursor.current = next;
        if (affected) await read();
      } catch (cause) { if (!controller.signal.aborted && epoch.current === current) setError(`变化读取失败：${errorText(cause)}`); }
      finally { checking = false; }
    }
    const timer = window.setInterval(() => { void checkChanges(); if (recoveryTarget) void readRecovery(recoveryTarget); }, pollInterval);
    const visible = () => { if (document.visibilityState === "visible") { void read(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); historyAbort.current?.abort(); epoch.current++; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [context.token, context.projectId, context.principal.actorId, sessionKey, scope, active, refresh, readAgain, pollInterval]);
  async function moreActivity() {
    if (historyBusy || historyLoaded && !historyCursor) return;
    const requestScope = historyScope.current, requestEpoch = epoch.current;
    const controller = new AbortController();
    historyAbort.current = controller;
    const currentRequest = () => !controller.signal.aborted && historyScope.current === requestScope && epoch.current === requestEpoch;
    setHistoryBusy(true); setHistoryError("");
    try {
      const page = await sessionClient(context.token, context.projectId).activities(sessionKey, historyCursor ?? undefined, controller.signal);
      if (!currentRequest()) return;
      if (page.items.some(item => item.sessionKey !== sessionKey)) throw new Error("活动历史与所选 Session 不符");
      setActivity(old => bounded(old, page.items)); setHistoryCursor(page.nextCursor); setHistoryLoaded(true);
      setHistoryPartial(old => old || page.metadata.partial);
      setHistoryLimitations(old => [...new Set([...old, ...page.metadata.limitations])]);
    } catch (cause) { if (currentRequest()) setHistoryError(errorText(cause)); }
    finally { if (currentRequest()) { historyAbort.current = null; setHistoryBusy(false); } }
  }
  const current = snapshot?.session.key === sessionKey ? snapshot : null;
  if (!current) return <div className="content"><h1>Session</h1>{loading ? <p>正在读取会话工作区…</p> : <Alert kind="error">会话暂不可读取：{error || "未找到当前项目的会话"}。<button onClick={() => setReadAgain(value => value + 1)}>重试</button></Alert>}</div>;
  const session = current.session;
  const work = current.currentWork;
  const limitation = [...new Set([...session.metadata.limitations, ...current.metadata.limitations, ...historyLimitations])];
  return <div className="content session-workspace">
    <div className="session-workspace-head"><div><p className="eyebrow">{session.kind === "owned" ? "项目受管 Session" : "外部连接 Session"} · {session.membership === "current" ? "当前团队" : session.membership === "historical" ? "历史" : "待归类"}</p><h1>{session.title}</h1><p>{session.profile?.purpose || session.roles.map(role => role.responsibility).filter(Boolean).join("；") || "用途尚未登记"}</p></div><div className="session-workspace-actions"><button type="button" onClick={() => setReadAgain(value => value + 1)} disabled={loading}>重新读取</button><SessionOpenEntry session={session} token={context.token} projectId={context.projectId} currentRead={active && !loading && !error} active={active} /></div></div>
    {error && <Alert kind="error">{error}。显示上次读回；请重新读取。</Alert>}
    <section className="session-current-work"><div><small>当前任务</small><strong>{work ? <a href={href(context.projectId, "task", work.id)}>{work.title}</a> : "尚无可确认的当前任务"}</strong><span>{work ? work.relation === "accepted" ? "具体 Session 已接手" : work.relation === "assigned" ? "已分派，待确认接手" : work.relation === "claimed" || work.relation === "run" ? "有正式运行关联" : "角色责任" : "角色责任不等于已接手"}</span></div>{work && <a className="session-task-link" href={href(context.projectId, "task", work.id)}>查看任务</a>}</section>
    <div className="session-workspace-summary"><div><small>会话状态</small><strong>{sessionStatusLabel(session)}</strong><span>{sessionLifecycleLabel(session)}；实际运行仍以 Run 记录为准</span></div><div><small>待处理问题</small><strong>{current.questions.filter(question => !question.answered).length}</strong><span>来自任务讨论记录</span></div><div><small>最近进展</small><strong>{date(session.lastProgressAt ?? undefined)}</strong><span>来源记录时间，未知时不推断</span></div></div>
    {session.kind === "owned" && session.target.kind === "owned" && <SessionRecoveryOverview read={recoveryRead} runtimeState={session.runtimeState} queueHref={`${href(context.projectId, "runtime")}?view=execution`} />}
    <p className="session-workspace-freshness">工作区读于 {date(current.metadata.generatedAt)}；来源最近观察 {date(current.metadata.sourceObservedAt ?? undefined)}。{current.metadata.partial || historyPartial ? "来源仅展示已读范围。" : ""}</p>
    {limitation.length > 0 && <details className="session-workspace-limitations"><summary>来源限制与未确认信息</summary><ul>{limitation.map(item => <li key={item}>{item}</li>)}</ul></details>}
    <nav className="session-workspace-tabs" aria-label="Session 工作区栏目">{(Object.keys(tabLabels) as Tab[]).map(key => <button key={key} type="button" className={tab === key ? "selected" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(key); window.location.hash = `${href(context.projectId, "runtime")}?session=${encodeURIComponent(sessionKey)}&tab=${key}`; }}>{tabLabels[key]}{key === "activity" && ` · ${activity.length}`}</button>)}</nav>
    {tab === "activity" && <><section className="session-workspace-section"><h2>活动</h2><p className="muted">这里也包含关联任务的背景记录；查看每条的来源与登记者，不能据此认定由本 Session 执行。</p>{activity.length ? <ol className="session-activity-list">{activity.map(item => {
      const presented = activityPresentation(item, context.projectId);
      return <li key={item.id}><time>{date(item.occurredAt ?? item.recordedAt)}</time><div><strong>{item.summary}</strong><small>{presented.sourceLabel}</small><details className="session-activity-source"><summary>来源标识</summary><small>{item.source.kind} · <code>{item.source.id}</code>{item.source.revision && <> · 修订 <code>{item.source.revision}</code></>}</small></details></div><span className="session-activity-links">{presented.discussionHref && <a href={presented.discussionHref}>原讨论</a>}{item.taskId && <a href={href(context.projectId, "task", item.taskId)}>关联任务</a>}</span></li>;
    })}</ol> : <p className="empty">当前范围尚无活动记录。</p>}{(!historyLoaded || historyCursor) && <button type="button" disabled={historyBusy} onClick={() => void moreActivity()}>{historyBusy ? "读取中…" : historyCursor ? "加载更早活动" : "读取活动历史"}</button>}{historyError && <Alert kind="error">{historyError}</Alert>}</section>{active && <SessionMessages key={current.session.key} context={context} snapshot={current} onApplied={() => setReadAgain(value => value + 1)} />}</>}
    {tab === "queue" && <section className="session-workspace-section"><div className="session-section-head"><div><h2>任务队列</h2><p className="muted">按已确认的顺序逐项处理；排队不表示已开始运行。</p></div><a href={`${href(context.projectId, "runtime")}?view=execution`}>管理受管队列</a></div>{current.queue.length ? <ol className="session-queue-list">{current.queue.map(item => <li key={item.entryId}><span className="session-queue-position" aria-label={`第 ${queuePosition(item.position)} 项`}>{queuePosition(item.position)}</span><div><strong><a href={href(context.projectId, "task", item.taskId)}>{item.taskTitle}</a></strong><small>{queueStateLabel(item.state)}{item.holdReason && ` · ${item.holdReason}`}</small></div></li>)}</ol> : <p className="empty">当前范围没有关联队列条目。</p>}</section>}
    {tab === "results" && <section className="session-workspace-section"><h2>结果与实际使用</h2>{current.results.length ? <ul>{current.results.map(item => <li key={item.deliveryId}><a href={href(context.projectId, "task", item.taskId)}>{item.taskTitle}</a> · 技术结果 {item.technicalResult} · {item.latestUse ? `使用观察：${item.latestUse.result}（${item.latestUse.observerKind}）` : "尚无实际使用观察"}</li>)}</ul> : <p className="empty">当前范围没有交付记录。</p>}</section>}
    {tab === "responsibilities" && <section className="session-workspace-section"><h2>职责与分派</h2>{session.roles.map(role => <p key={role.id}><a href={href(context.projectId, "roles")}>{role.title}</a> · {role.responsibility}</p>)}<h3>具体分派</h3>{current.assignments.length ? <ul>{current.assignments.map(({ assignment, task, stale }) => <li key={`${assignment.taskId}:${assignment.version}`}><a href={href(context.projectId, "task", task.id)}>{task.title}</a> · {stale ? "任务修订已变化，需重新确认" : assignment.state === "accepted" ? `已接手（${assignment.ack?.method === "direct" ? "本人确认" : "负责人观察"}）` : assignment.state === "assigned" ? "待确认" : "已释放"}</li>)}</ul> : <p>没有具体分派。</p>}<details><summary>角色责任范围 · {current.roleTasks.length} 项</summary><p>角色负责这些任务，不表示此 Session 已接手。</p><ul>{current.roleTasks.map(task => <li key={task.id}><a href={href(context.projectId, "task", task.id)}>{task.title}</a></li>)}</ul></details>{active && <AllocationBacklinks context={context} filter={{ sessionKey }} refresh={refresh + readAgain} />}<SessionProfileForm context={context} snapshot={current} onApplied={() => setReadAgain(value => value + 1)} /></section>}
    {tab === "resources" && <section className="session-workspace-section"><h2>资源观察</h2><p className="muted">配置模型、实际模型和用量分别列示；缺少可靠来源时显示不可用原因，不填零。</p>{session.kind === "owned" && session.target.kind === "owned" && <SessionRecoveryResources read={recoveryRead} queueHref={`${href(context.projectId, "runtime")}?view=execution`} />}<dl className="session-resource-list">{([
      ["configuredModel", "配置模型"], ["actualModel", "实际运行模型"], ["inputTokens", "输入 Token"], ["outputTokens", "输出 Token"], ["cost", "费用"], ["processMemory", "进程内存"],
    ] as const).map(([key, label]) => { const item = current.resources[key]; return <div key={key}><dt>{label}</dt><dd><strong>{item.value === null ? "不可用" : `${item.value}${item.unit ? ` ${item.unit}` : ""}`}</strong><small>{item.value === null ? item.unavailableReason ?? "没有可靠观察来源" : `${item.scope} · ${item.source ?? "来源未记录"} · ${date(item.observedAt ?? undefined)}`}</small></dd></div>; })}</dl></section>}
  </div>;
}

function SessionProfileForm({ context, snapshot, onApplied }: { context: MutationContext; snapshot: SessionSnapshot; onApplied(): void }) {
  const profile = snapshot.session.profile;
  return <ActionForm context={{ ...context, draftScope: `session-profile:${snapshot.session.key}`, draftBaseline: `${profile?.version ?? 0}` }} review title="设置 Session 展示信息" fields={[
    { name: "displayName", label: "展示名称", value: profile?.displayName ?? snapshot.session.title },
    { name: "purpose", label: "用途", kind: "textarea", optional: true, value: profile?.purpose ?? "" },
    { name: "membership", label: "团队归属", kind: "select", value: profile?.membership ?? snapshot.session.membership, options: [option("current", "当前团队"), option("historical", "历史"), option("unclassified", "待归类")] },
    { name: "tenure", label: "会话性质", kind: "select", value: profile?.tenure ?? "unknown", options: [option("resident", "常驻"), option("temporary", "临时"), option("unknown", "未知")] },
    { name: "reason", label: "变更依据", kind: "textarea" },
  ]} build={v => ({ type: "session.profile.set", target: snapshot.session.target, expectedVersion: profile?.version ?? 0, displayName: v.displayName, purpose: v.purpose, membership: v.membership, tenure: v.tenure, reason: v.reason })} onApplied={onApplied} />;
}

function SessionMessages({ context, snapshot, onApplied }: { context: MutationContext; snapshot: SessionSnapshot; onApplied(): void }) {
  const entry = sessionMessageEntry(snapshot.session.kind, snapshot.session.capabilities);
  const messageScope = `${context.token}\0${context.projectId}\0${snapshot.session.key}`;
  const currentMessageScope = useRef(messageScope);
  currentMessageScope.current = messageScope;
  useEffect(() => {
    currentMessageScope.current = messageScope;
    return () => { if (currentMessageScope.current === messageScope) currentMessageScope.current = ""; };
  }, [messageScope]);
  const [messages, setMessages] = useState<SessionMessageRecord[]>([]);
  const [selected, setSelected] = useState<{ message: SessionMessageRecord; processing: SessionMessageProcessing | null } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const olderCursor = useRef<{ expanded: boolean; value: string | null }>({ expanded: false, value: null });
  useEffect(() => {
    const controller = new AbortController();
    const client = sessionClient(context.token, context.projectId);
    let active = true;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const page = await client.messages(snapshot.session.key, undefined, controller.signal);
        if (!active) return;
        setMessages(previous => {
          if (!olderCursor.current.expanded) return page.items;
          const byId = new Map([...previous, ...page.items].map(item => [item.id, item]));
          return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300);
        });
        setNextCursor(olderCursor.current.expanded ? olderCursor.current.value : page.nextCursor); setListError("");
      } catch (cause) { if (active && !controller.signal.aborted) setListError(errorText(cause)); }
      finally { if (active) setLoading(false); }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [context.token, context.projectId, snapshot.session.key, reload]);
  useEffect(() => { olderCursor.current = { expanded: false, value: null }; setMessages([]); setSelected(null); setNextCursor(null); setLoading(true); }, [snapshot.session.key, context.projectId]);
  useEffect(() => {
    const id = selected?.message.id;
    if (!id) return;
    const controller = new AbortController();
    const refreshDetail = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const value = await sessionClient(context.token, context.projectId).message(id, controller.signal);
        if (!controller.signal.aborted && value.message.id === id && value.message.projectId === context.projectId)
          setSelected(previous => previous?.message.id === id ? value : previous);
      } catch { /* The visible list still shows its last confirmed detail; explicit reread reports errors. */ }
    };
    const timer = window.setInterval(() => void refreshDetail(), 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [context.token, context.projectId, selected?.message.id]);
  async function more() {
    if (!nextCursor) return;
    try {
      const page = await sessionClient(context.token, context.projectId).messages(snapshot.session.key, nextCursor);
      setMessages(old => { const ids = new Set(old.map(item => item.id)); return [...old, ...page.items.filter(item => !ids.has(item.id))].slice(0, 300); });
      olderCursor.current = { expanded: true, value: page.nextCursor };
      setNextCursor(page.nextCursor); setListError("");
    } catch (cause) { setListError(errorText(cause)); }
  }
  async function detail(messageId: string) {
    const scope = messageScope;
    if (currentMessageScope.current !== scope) return;
    try {
      const value = await sessionClient(context.token, context.projectId).message(messageId);
      if (currentMessageScope.current !== scope) return;
      if (value.message.id !== messageId || value.message.projectId !== context.projectId) throw new Error("消息详情与所选项目记录不符");
      const target = value.message.target;
      const targetKey = target.kind === "owned" ? `owned:${target.sessionId}` : `external:${target.linkId}`;
      if (targetKey !== snapshot.session.key) throw new Error("消息详情与所选 Session 不符");
      setSelected(value); setDetailError("");
    } catch (cause) { if (currentMessageScope.current === scope) setDetailError(errorText(cause)); }
  }
  const status: Record<SessionMessageRecord["state"], string> = { queued: "待派发", processing: "原会话处理中", replied: "已回复", completed_without_reply: "已完成但无回复", failed: "失败", unknown: "结果未知", cancelled: "已取消", manual_pending: "待人工转交" };
  const canRecordRead = selected?.message.target.kind === "owned" && !selected.message.readReceipt
    && selected.processing?.receiverActorId === context.principal.actorId && !!selected.processing.nativeTurnId
    && (selected.processing.state === "completed" || selected.processing.state === "failed")
    && (selected.message.state === "replied" || selected.message.state === "completed_without_reply" || selected.message.state === "failed");
  return <section className="session-workspace-section"><h2>普通对话</h2><p>{entry.introduction}</p>
    {entry.canSave && entry.sendReason && <p className="muted">保存能力：{entry.sendReason}</p>}
    <p role="status">自动处理：{entry.executionLabel}。{entry.executionReason}{entry.executionObservedAt && <> 状态读于 {date(entry.executionObservedAt)}；配置变化后请点上方“重新读取”。</>}</p>
    {!entry.canSave ? <Alert>{entry.sendReason || "当前不可保存消息。"}</Alert> : <ActionForm context={{ ...context, draftScope: `session-message:${snapshot.session.key}` }} title={entry.actionTitle} fields={[{ name: "content", label: "消息内容", kind: "textarea" }]} build={v => ({ type: "session.message.post", messageId: crypto.randomUUID(), target: snapshot.session.target, content: v.content })} onApplied={result => { if (currentMessageScope.current !== messageScope) return; setReload(value => value + 1); void detail(result.entityId); onApplied(); }} />}
    <h3>消息记录</h3>{loading && <p>正在读取消息…</p>}{listError && <Alert kind="error">消息列表暂不可读取：{listError}。<button onClick={() => setReload(value => value + 1)}>重试列表</button></Alert>}
    {detailError && <Alert kind="error">消息详情暂不可读取：{detailError}。</Alert>}
    {messages.length ? <ul className="session-message-list">{messages.map(item => <li key={item.id}><button type="button" className="quiet" onClick={() => void detail(item.id)}>{item.content.slice(0, 130)}{item.content.length > 130 ? "…" : ""}</button><small>{status[item.state]} · {date(item.createdAt)}</small></li>)}</ul> : !loading && !listError && <p className="empty">没有已保存的普通消息。</p>}
    {nextCursor && messages.length < 300 && <button type="button" onClick={() => void more()}>加载更早消息</button>}
    {nextCursor && messages.length >= 300 && <p className="muted">当前最多展示 300 条消息；可在原会话查看更早记录。</p>}
    {selected && <div className="session-message-detail"><div className="panel-head"><h3>消息详情 · {status[selected.message.state]}</h3><button type="button" onClick={() => setSelected(null)}>关闭</button></div><p className="muted">发送 {date(selected.message.createdAt)} · 更新 {date(selected.message.updatedAt)}</p><pre>{selected.message.content}</pre>
      {selected.processing?.response && <><h4>原会话回复</h4><pre>{selected.processing.response}</pre></>}
      {selected.processing?.failure && <Alert kind="error">处理失败：{selected.processing.failure}</Alert>}
      {selected.message.blockedReason && <p>等待原因：{selected.message.blockedReason}</p>}
      {selected.message.readReceipt && <p>已读回执：{selected.message.readReceipt.evidence} · {date(selected.message.readReceipt.at)}</p>}
      {canRecordRead && <ActionForm context={{ ...context, draftScope: `message-read:${selected.message.id}` }} title="记录本人已读原消息" fields={[{ name: "evidence", label: "阅读证据", kind: "textarea" }]} build={v => ({ type: "session.message.receipt", messageId: selected.message.id, stage: "read", evidence: v.evidence })} onApplied={() => { void detail(selected.message.id); setReload(value => value + 1); }} />}
      {(selected.message.state === "queued" || selected.message.state === "manual_pending") && selected.message.senderActorId === context.principal.actorId && <ActionForm context={{ ...context, draftScope: `message-cancel:${selected.message.id}`, draftBaseline: `${selected.message.version}` }} title="取消待处理消息" fields={[{ name: "reason", label: "取消原因", kind: "textarea" }]} build={v => ({ type: "session.message.cancel", messageId: selected.message.id, expectedVersion: selected.message.version, reason: v.reason })} onApplied={() => { void detail(selected.message.id); setReload(value => value + 1); }} />}
      {selected.message.state === "manual_pending" && <p className="muted">外部消息仍待人工转交，不能据此登记原生会话已读。</p>}
      {selected.message.target.kind === "owned" && !selected.message.readReceipt && !canRecordRead && <p className="muted">仅配置的实际收件人能在原生 Turn 结束后记录本人已读；不能由发送者或会话创建者代签。</p>}
    </div>}
    <p className="muted">任务问答与正式交付请进入原任务的讨论和验收记录。</p>
  </section>;
}
