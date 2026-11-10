import { Fragment, useEffect, useState, type FormEvent } from "react";
import type { ConnectorRoute, ConnectorRouteRecord } from "@evoloop/contracts/message-connectors";
import { ApiError, errorDiagnostic, errorText } from "../../shared/api";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, Field, Input, ListRow, LoadingState, Notice, RefreshingIndicator, StatusTag, Textarea, cn } from "@evoloop/ui";
import { date, href } from "../../shared/ui/shared";
import { SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";
import { useProjectQuery } from "../../shared/query";
import { sessionClient } from "../../shared/sessionClient";
import { agentDisplayName } from "../../shared/agentNamePresentation";
import type { MutationContext } from "../../shared/ActionForm";
import { connectorClient, type ConnectorDeliverySummary, type ConnectorDeliveryDetail } from "./client";
import {
  agentLinkText, conversationKindLabel, createdNotice, decisionLabel, deliverySummary, messageStateLabel, processingStateLabel,
  providerLabel, reconciledNotice, routeListView, routeModeLine, routeStateLabel, routeStateTone, stateChangedNotice,
  unhandledEventLabel, unhandledReasonLabel,
} from "./connectorPresentation";

const hash = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lines = (value: string) => value.split(/\r?\n/).map(part => part.trim()).filter(Boolean);
const pendingKey = (projectId: string, actorId: string) => `connector-operation:${projectId}:${actorId}`;
const wrap = "[overflow-wrap:anywhere]";

/** The receiving agent's name, read from its own record. Until then the link says the name is not read yet. */
async function readAgentName(projectId: string, sessionId: string, signal: AbortSignal): Promise<string | null> {
  const key = `owned:${sessionId}`;
  const session = (await sessionClient("", projectId).snapshot(key, signal))?.session;
  if (!session || (session.key !== key && !session.aliases?.some(alias => alias.kind === "owned" && alias.sessionId === sessionId)))
    throw new Error("智能体名称来源不匹配");
  return agentDisplayName(session) || null;
}

function TargetAgent({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const read = useProjectQuery(projectId, ["connectors", "agent-name", sessionId], signal => readAgentName(projectId, sessionId, signal));
  return <a href={`${href(projectId, "sessions")}?session=${encodeURIComponent(sessionId)}`} className={cn("text-foreground underline", wrap)}>
    {agentLinkText({ name: read.data, loading: read.isPending })}
  </a>;
}

function DeliveryPeek({token,projectId,bindingId}:{token:string;projectId:string;bindingId:string}){
  const [items,setItems]=useState<ConnectorDeliverySummary[]|null>(null);
  const [detail,setDetail]=useState<ConnectorDeliveryDetail|null>(null);
  const [error,setError]=useState('');
  const client=connectorClient(token,projectId);
  async function load(){try{setItems((await client.deliveries(bindingId)).items);setError('');}
    catch(cause){setError(`最近的投递没有读到：${errorText(cause)}`);}}
  async function show(deliveryId:number){try{setDetail(await client.delivery(bindingId,deliveryId));setError('');}
    catch(cause){setError(`投递 ${deliveryId} 的明细没有读到：${errorText(cause)}`);}}
  return <div className="connector-deliveries flex min-w-0 flex-col gap-1.5 text-small">
    <Button size="compact" variant="ghost" className="w-fit" onClick={() => void load()}>读取最近的投递</Button>
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {items && (items.length === 0 ? <p className="text-caption text-muted-foreground">这条路由还没有投递记录。</p>
      : <ul aria-label="最近的投递" className="flex flex-col">{items.map(item => <li key={item.deliveryId}>
        <ListRow title={`投递 ${item.deliveryId}`} meta={deliverySummary(item)} selected={detail?.deliveryId === item.deliveryId}
          onSelect={() => void show(item.deliveryId)} />
      </li>)}</ul>)}
    {detail && <details open className={cn("rounded-lg bg-field px-3 py-2 text-caption text-text-secondary", wrap)}>
      <summary className="cursor-pointer text-foreground">投递 {detail.deliveryId} 的明细</summary>
      {detail.messages.map(message => <p key={message.messageId}>事件 {message.eventCursor}：{messageStateLabel(message.messageState)} · {processingStateLabel(message.processingState)}
        <span className="text-muted-foreground"> · 消息 <code className="font-mono">{message.messageId}</code>{message.nativeTurnId && <> · 一轮 <code className="font-mono">{message.nativeTurnId}</code></>}</span></p>)}
      {detail.unhandled.map(event => <p key={`unhandled-${event.eventCursor}`}>事件 {event.eventCursor}：{unhandledEventLabel(event)}，{unhandledReasonLabel(event.reason)}，原长 {event.contentLength} 字，没有转给智能体</p>)}
      <p>出站：{decisionLabel(detail.decision)}{detail.decision?.requestId && <> · 原请求 <code className="font-mono">{detail.decision.requestId}</code></>}</p>
    </details>}
  </div>;
}

type FormKey = "bindingId" | "connectionId" | "conversationId" | "conversationLabel" | "targetSessionId" | "targetThreadId" |
  "targetActorId" | "senderActorId" | "owner" | "epoch" | "sessionRef" | "policyHash";
/** Labels in product language; the field's technical name, where a person needs it to look the value up, is in the hint. */
const fields: Array<[FormKey, string, string]> = [
  ["connectionId", "微信连接 ID", "微信网关里这条连接的标识（connectionId）。"],
  ["conversationId", "来源会话 ID", "群聊或私聊在微信网关里的标识（conversationId）。"],
  ["conversationLabel", "会话名称", "便于辨认；路由只认来源会话 ID。"],
  ["targetSessionId", "接收的智能体 ID", "完整权限的专用智能体，在智能体页的完整标识里可以查到。"],
  ["targetThreadId", "对话线程 ID", "这个智能体在运行时里的对话线程（Thread）；一条线程只接一个微信会话。"],
  ["targetActorId", "接收身份", "智能体接收微信消息时使用的身份（actor）。"],
  ["senderActorId", "发送身份", "智能体发回微信时使用的身份（actor）。"],
  ["owner", "网关所有者", "微信网关登记的所有者（owner）。"],
  ["epoch", "网关轮次", "微信网关的轮次（epoch），正整数。"],
  ["sessionRef", "网关会话引用", "微信网关的会话引用（session_ref），要和网关里的绑定一致。"],
  ["policyHash", "已审策略哈希", "已审核授权策略的 SHA-256，64 位十六进制。"],
  ["bindingId", "路由 ID", "已自动生成，一般不用改。"],
];
const areas = ([["sendTargets", "允许发送的会话 ID（每行一个，必须含来源）", true], ["senderIds", "允许触发智能体的微信发送者 ID（每行一个，至少一个）", true],
  ["internalTargets", "允许内部转交的智能体 ID（每行一个；留空即禁止）", false]] as const);

type RouteRead = { projectId: string; routes: ConnectorRouteRecord[] | null; cursor: string | null; error: string; reading: boolean };
const firstRead = (projectId: string): RouteRead => ({ projectId, routes: null, cursor: null, error: "", reading: true });

export function ConnectorPage({ context }: { context: MutationContext }) {
  const { token, projectId, principal } = context;
  const client = connectorClient(token, projectId);
  const canReview = principal.permissions.includes("write") && principal.permissions.includes("review");
  const [read, setRead] = useState<RouteRead>(() => firstRead(projectId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [readAgain, setReadAgain] = useState(0);
  const [pending, setPending] = useState(() => sessionStorage.getItem(pendingKey(projectId, principal.actorId)) ?? "");
  const [form, setForm] = useState({ bindingId: crypto.randomUUID(), connectionId: "", conversationId: "",
    conversationLabel: "", conversationKind: "group", senderIds: "", targetSessionId: "",
    targetThreadId: "", targetActorId: "", senderActorId: "",
    owner: "", epoch: "1", sessionRef: "",
    policyHash: "", sendTargets: "", internalTargets: "" });
  // Another project's routes never stay on screen while this project's are read.
  const current = read.projectId === projectId ? read : firstRead(projectId);
  useEffect(() => {
    let active = true;
    setRead(previous => previous.projectId === projectId ? { ...previous, reading: true } : firstRead(projectId));
    client.list().then(page => {
      if (page.items.some(route => route.projectId !== projectId)) throw new Error("路由响应不属于当前项目");
      if (active) setRead({ projectId, routes: page.items, cursor: page.nextCursor, error: "", reading: false });
    }).catch(cause => { if (active) setRead(previous => ({ ...previous, error: errorDiagnostic(cause), reading: false })); });
    return () => { active = false; };
  }, [token, projectId, readAgain]);
  const remember = (id: string) => { sessionStorage.setItem(pendingKey(projectId, principal.actorId), id); setPending(id); };
  const forget = () => { sessionStorage.removeItem(pendingKey(projectId, principal.actorId)); setPending(""); };
  async function reconcile() {
    if (!pending) return;
    setBusy(true); setError("");
    try {
      const operation = await client.operation(pending);
      if (operation.id !== pending || operation.result.projectId !== projectId) throw new Error("操作回执范围不匹配");
      forget(); setNotice(reconciledNotice(operation.result.conversationLabel, operation.result.version)); setReadAgain(value => value + 1);
    } catch (cause) { setError(`原操作仍未确认：${errorText(cause)}。保留原 ID 和原请求，稍后再查回。`); }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!canReview || busy || pending) return;
    const sendTargets = lines(form.sendTargets), internalTargets = lines(form.internalTargets);
    const senderIds = lines(form.senderIds);
    if (!uuid.test(form.bindingId) || !uuid.test(form.targetSessionId) || !hash.test(form.policyHash) ||
      !form.conversationLabel.trim() || !form.targetThreadId.trim() ||
      !senderIds.length || !["group","private"].includes(form.conversationKind) ||
      !sendTargets.includes(form.conversationId) || internalTargets.some(id => !uuid.test(id)) ||
      new Set(senderIds).size !== senderIds.length ||
      new Set(sendTargets).size !== sendTargets.length || new Set(internalTargets).size !== internalTargets.length) {
      setError("请核对：路由 ID 和各智能体 ID 的格式、会话类型、发送者名单（至少一个）、64 位策略哈希，各名单不能重复；允许发送的会话必须包含来源会话。"); return;
    }
    const route: ConnectorRoute = { projectId, bindingId: form.bindingId,
      source: { provider: "wechat", connectionId: form.connectionId.trim(), conversationId: form.conversationId.trim() },
      conversationLabel: form.conversationLabel.trim(), conversationKind: form.conversationKind as "group" | "private",
      targetSessionId: form.targetSessionId,
      targetThreadId: form.targetThreadId.trim(), targetActorId: form.targetActorId.trim(),
      senderActorId: form.senderActorId.trim(),
      owner: form.owner.trim(), epoch: Number(form.epoch), sessionRef: form.sessionRef.trim(), mode: "standard",
      readScope: "project", sendTargets, senderIds, internalTargets, state: "disabled",
      capabilities: { history: false, search: false, subscribe: true, sendText: true, sendMedia: false, receipt: "local_observed" },
      policyHash: form.policyHash };
    const operationId = crypto.randomUUID(); remember(operationId); setBusy(true); setError(""); setNotice("");
    let accepted = false;
    try {
      const result = await client.create(route, operationId);
      if (result.operationId !== operationId || result.route.bindingId !== route.bindingId || result.route.state !== "disabled")
        throw new Error("创建响应与原操作不符");
      accepted = true;
      const saved = await client.route(route.bindingId);
      if (saved.version !== result.route.version || saved.projectId !== projectId) throw new Error("保存结果尚未读回");
      forget(); setForm(previous => ({ ...previous, bindingId: crypto.randomUUID() }));
      setNotice(createdNotice(saved.conversationLabel)); setReadAgain(value => value + 1);
    } catch (cause) {
      if (!accepted && cause instanceof ApiError && cause.status > 0) { forget(); setError(`创建被拒绝：${errorText(cause)}`); }
      else setError(`创建结果未确认：${errorText(cause)}。原操作已保存，请先按原 ID 查回。`);
    }
    finally { setBusy(false); }
  }
  async function changeState(route: ConnectorRouteRecord, state: "active" | "paused" | "disabled") {
    if (!canReview || busy || pending || route.mode !== "standard") return;
    setBusy(true); setError(""); setNotice("");
    let operationId = "";
    let accepted = false;
    try {
      const current = await client.route(route.bindingId);
      if (current.version !== route.version || current.projectId !== projectId) throw new Error("路由已变化，请重新读取后操作");
      operationId = crypto.randomUUID(); remember(operationId);
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = current;
      const result = await client.update({ ...value, state, version: current.version + 1 }, current.version, operationId);
      if (result.operationId !== operationId || result.route.state !== state || result.route.version !== current.version + 1)
        throw new Error("更新响应与原操作不符");
      accepted = true;
      const saved = await client.route(route.bindingId);
      if (saved.version !== result.route.version || saved.state !== state) throw new Error("更新结果尚未读回");
      forget(); setNotice(stateChangedNotice(saved.conversationLabel, saved.state, saved.version)); setReadAgain(value => value + 1);
    } catch (cause) {
      if (!operationId || !accepted && cause instanceof ApiError && cause.status > 0) {
        forget(); setError(`状态变更未提交：${errorText(cause)}`); setReadAgain(value => value + 1);
      } else setError(`状态变更结果未确认：${errorText(cause)}。原操作已保存，请先按原 ID 查回。`);
    }
    finally { setBusy(false); }
  }
  async function more() {
    if (!current.cursor || busy) return;
    setBusy(true); setError("");
    try { const page = await client.list(current.cursor); if (page.items.some(route => route.projectId !== projectId)) throw new Error("路由响应不属于当前项目");
      setRead(previous => previous.projectId !== projectId ? previous
        : { ...previous, routes: [...previous.routes ?? [], ...page.items], cursor: page.nextCursor });
    } catch (cause) { setError(`更多路由没有读到：${errorText(cause)}`); } finally { setBusy(false); }
  }
  const muted = "text-caption text-muted-foreground";
  const list = routeListView(current);
  return <SettingsPage title="微信连接" description="查看固定来源与接收智能体，按已审策略保存和停订。路由状态不代表来源消息已处理或微信收件已确认。" className="connector-page"
    action={<Button onClick={() => { setError(""); setReadAgain(value => value + 1); }} disabled={busy}><RefreshCw aria-hidden="true" />重新读取</Button>}>
    <Notice tone="waiting">标准模式使用完整权限的专用智能体。启用前要核对：群聊还是私聊、允许的发送者、收发身份、智能体的对话线程、生效中的执行配置和网关授权。受限模式还缺隔离证明，不能启用。暂停或停用后不再领取新的投递；已领取的按原策略处理完，或标为结果未知。</Notice>
    {pending && <Notice tone="error" action={<Button size="compact" disabled={busy} onClick={() => void reconcile()}>按原 ID 查回</Button>}>有一项操作的结果还没确认，原操作 ID <code className="break-all font-mono">{pending}</code>。查回之前不再提交新的修改。</Notice>}
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice>{notice}</Notice>}
    <SettingsSection title="当前路由">
      {list.checking && <RefreshingIndicator />}
      {list.view === "loading" && <LoadingState label="正在读取路由" />}
      {list.view === "error" && <ErrorState title="无法读取路由" happened="这次没有读到当前项目的微信路由，不能判断有没有路由。"
        next="稍后点“重新读取”再试；仍然失败时，请检查协调器是否在运行。" diagnostics={current.error} />}
      {list.stale && <ErrorState title="重新读取失败" happened="这次没有读到最新的路由。" previousContentKept
        next="下面是上次读回的内容，当前待核对；稍后点“重新读取”再试。" diagnostics={current.error} />}
      {list.view === "empty" && <EmptyState title={list.stale ? "上次读回时没有路由" : "还没有路由"} reason="当前项目没有已读回的微信路由。" />}
      {list.view === "list" && <ul className="flex flex-col gap-3">{current.routes!.map(route => <li key={route.bindingId} className="connector-card flex min-w-0 flex-col gap-2 rounded-xl bg-raised p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cn("min-w-0 text-body font-semibold text-foreground", wrap)}>{route.conversationLabel}</h3>
            <StatusTag tone={routeStateTone[route.state]} label={routeStateLabel[route.state]} />
            <span className={muted}>{routeModeLine(route)}</span>
          </div>
          <p className={cn("text-small text-text-secondary", wrap)}>{providerLabel(route.source.provider)} · {conversationKindLabel(route.conversationKind)} · 连接 {route.source.connectionId}</p>
          <p className={cn("text-small text-text-secondary", wrap)}>转给 <TargetAgent projectId={projectId} sessionId={route.targetSessionId} /> · 读回更新 {date(route.updatedAt)}</p>
          <details className="text-small"><summary className="cursor-pointer text-text-secondary">完整标识与范围</summary>
            <dl className="mt-2 flex flex-col gap-1.5 text-caption">{([["路由 ID", route.bindingId], ["接收的智能体 ID", route.targetSessionId], ["来源会话 ID", route.source.conversationId],
              ["对话线程 ID", route.targetThreadId], ["允许的发送者", route.senderIds.join("、")], ["接收 / 发送身份", `${route.targetActorId} / ${route.senderActorId}`],
              ["网关所有者 / 轮次 / 会话引用", `${route.owner} / ${route.epoch} / ${route.sessionRef}`],
              ["允许发送的会话", route.sendTargets.join("、") || "无"], ["允许转交的智能体", route.internalTargets.join("、") || "无"], ["已审策略哈希", route.policyHash]] as const)
              .map(([label, value]) => <div key={label} className="flex flex-col"><dt className="text-muted-foreground">{label}</dt><dd className="m-0 break-all font-mono text-foreground">{value}</dd></div>)}</dl>
          </details>
          <DeliveryPeek token={token} projectId={projectId} bindingId={route.bindingId} />
          <p className={muted}>这些状态来自项目消息与原发送意图；微信界面可见不等于对方已收件。</p>
          {canReview && route.mode === "standard" && <div className="flex flex-wrap gap-2">
            {route.state === "active" ? <Button size="compact" disabled={busy || !!pending} onClick={() => void changeState(route, "paused")}>暂停订阅</Button>
              : <Button size="compact" disabled={busy || !!pending} onClick={() => void changeState(route, "active")}>{route.state === "paused" ? "恢复订阅" : "启用路由"}</Button>}
            {route.state === "paused" && <Button size="compact" variant="danger" disabled={busy || !!pending} onClick={() => void changeState(route, "disabled")}>停用路由</Button>}
          </div>}
          {route.mode === "restricted" && <p className={muted}>受限模式资格未获证明；此处不提供启用操作。</p>}
        </li>)}</ul>}
      {current.routes && current.cursor && <Button size="compact" variant="ghost" className="w-fit" disabled={busy} onClick={() => void more()}>读取更多路由</Button>}
    </SettingsSection>
    {canReview && <details className="connector-create rounded-xl bg-raised p-4 shadow-sm">
      <summary className="cursor-pointer text-small font-medium text-foreground">创建标准模式路由</summary>
      <p className={cn(muted, "mt-2")}>先固定并审核来源、接收的智能体和策略；新路由保存为停用，启用另行核验。</p>
      <form onSubmit={event => void create(event)} className="mt-3 flex flex-col gap-3">
        <div className="grid gap-3 compact:grid-cols-2">
          {fields.map(([key, label, hint]) => <Fragment key={key}>
            <Field label={label} hint={hint}>{control => <Input {...control} required value={form[key]} onChange={event => setForm(previous => ({ ...previous, [key]: event.target.value }))} />}</Field>
            {key === "conversationLabel" && <Field label="会话类型">{control => <select {...control} value={form.conversationKind} onChange={event => setForm(previous => ({ ...previous, conversationKind: event.target.value }))}
              className="h-9 w-full rounded-md border-0 bg-field px-3 text-small text-foreground outline-none focus-visible:shadow-[var(--focus-ring)]">
              <option value="group">群聊</option><option value="private">私聊</option>
            </select>}</Field>}
          </Fragment>)}
        </div>
        {areas.map(([key, label, required]) => <Field key={key} label={label}>{control => <Textarea {...control} required={required} value={form[key]} onChange={event => setForm(previous => ({ ...previous, [key]: event.target.value }))} />}</Field>)}
        <Button type="submit" variant="primary" className="w-fit" disabled={busy || !!pending}>保存为停用路由</Button>
      </form>
    </details>}
  </SettingsPage>;
}
