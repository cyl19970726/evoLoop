import { useEffect, useState, type FormEvent } from "react";
import type { ConnectorRoute, ConnectorRouteRecord } from "@evoloop/contracts/message-connectors";
import { ApiError, errorText } from "../api";
import { Alert, date, href } from "../ui/shared";
import type { MutationContext } from "../workflow/ActionForm";
import { connectorClient, type ConnectorDeliverySummary, type ConnectorDeliveryDetail } from "./client";
import "./connectors.css";

const hash = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lines = (value: string) => value.split(/\r?\n/).map(part => part.trim()).filter(Boolean);
const pendingKey = (projectId: string, actorId: string) => `connector-operation:${projectId}:${actorId}`;

function DeliveryPeek({token,projectId,bindingId}:{token:string;projectId:string;bindingId:string}){
  const [items,setItems]=useState<ConnectorDeliverySummary[]|null>(null);
  const [detail,setDetail]=useState<ConnectorDeliveryDetail|null>(null);
  const [error,setError]=useState('');
  const client=connectorClient(token,projectId);
  async function load(){try{setItems((await client.deliveries(bindingId)).items);setError('');}
    catch(cause){setError(errorText(cause));}}
  async function show(deliveryId:number){try{setDetail(await client.delivery(bindingId,deliveryId));setError('');}
    catch(cause){setError(errorText(cause));}}
  return <div className="connector-deliveries"><button type="button" onClick={()=>void load()}>读取最近 delivery</button>
    {error&&<p role="alert">{error}</p>}{items&&<div>{items.length===0?<p>尚无已关联的来源事件。</p>:
      items.map(item=><div key={item.deliveryId}><button type="button" onClick={()=>void show(item.deliveryId)}>
        delivery {item.deliveryId} · {item.eventCount} 个来源事件
        {item.unhandledCount?` · ${item.unhandledCount} 个需人工处理`:''} · {item.latestMessageState}
        {item.decision?` · ${item.decision.decision}/${item.decision.state}`:''}</button></div>)}</div>}
    {detail&&<details open><summary>delivery {detail.deliveryId} 的原操作</summary>
      {detail.messages.map(message=><p key={message.messageId}>事件 {message.eventCursor} → 消息 <code>{message.messageId}</code>
        {' '}· {message.messageState}/{message.processingState??'未开始'} · Turn <code>{message.nativeTurnId??'未绑定'}</code></p>)}
      {detail.unhandled.map(event=><p key={`unhandled-${event.eventCursor}`}>事件 {event.eventCursor}
        {' '}· {event.eventKind}/{event.direction} · {event.reason} · 原长度 {event.contentLength}，未创建平台消息</p>)}
      <p>出站决定：{detail.decision?`${detail.decision.decision}/${detail.decision.state}`:'尚无'}
        {detail.decision?.requestId&&<> · 原请求 <code>{detail.decision.requestId}</code></>}</p></details>}
  </div>;
}

export function ConnectorPage({ context }: { context: MutationContext }) {
  const { token, projectId, principal } = context;
  const client = connectorClient(token, projectId);
  const canReview = principal.permissions.includes("write") && principal.permissions.includes("review");
  const [routes, setRoutes] = useState<ConnectorRouteRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
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
  useEffect(() => {
    let active = true;
    setLoaded(false);
    client.list().then(page => {
      if (page.items.some(route => route.projectId !== projectId)) throw new Error("路由响应不属于当前项目");
      if (active) { setRoutes(page.items); setCursor(page.nextCursor); }
    }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoaded(true); });
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
      forget(); setNotice(`已读回操作 ${pending}，路由版本 ${operation.result.version}。`); setReadAgain(value => value + 1);
    } catch (cause) { setError(`操作 ${pending} 尚未确认：${errorText(cause)}。保留原 ID 和原请求，先继续对账。`); }
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
      setError("请核对 UUID、会话类型、发送者、64 位策略哈希和去重目标；发送目标须包含来源 conversation。"); return;
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
      setNotice(`已保存并读回 disabled 路由 ${saved.bindingId}。`); setReadAgain(value => value + 1);
    } catch (cause) {
      if (!accepted && cause instanceof ApiError && cause.status > 0) { forget(); setError(`创建被拒绝：${errorText(cause)}`); }
      else setError(`创建结果未确认：${errorText(cause)}。操作 ID ${operationId} 已保存，请先查回。`);
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
      forget(); setNotice(`已读回 ${state} 路由 ${saved.bindingId}，版本 ${saved.version}。`); setReadAgain(value => value + 1);
    } catch (cause) {
      if (!operationId || !accepted && cause instanceof ApiError && cause.status > 0) {
        forget(); setError(`状态变更未提交：${errorText(cause)}`); setReadAgain(value => value + 1);
      } else setError(`状态变更结果未确认：${errorText(cause)}。操作 ID ${operationId} 已保存，请先查回。`);
    }
    finally { setBusy(false); }
  }
  async function more() {
    if (!cursor || busy) return;
    setBusy(true); setError("");
    try { const page = await client.list(cursor); if (page.items.some(route => route.projectId !== projectId)) throw new Error("路由响应不属于当前项目");
      setRoutes(previous => [...previous, ...page.items]); setCursor(page.nextCursor);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <div className="content connector-page"><div className="page-title-row"><div><h1>微信 Connector 路由</h1>
    <p className="lede">查看固定来源与接收 Session，按已审策略保存和停订。路由状态不代表来源消息已处理或微信收件已确认。</p></div>
    <button type="button" onClick={() => {setError("");setReadAgain(value => value + 1);}} disabled={busy}>重新读取</button></div>
    <Alert>标准模式使用完整权限的专用 Session，启用前须核对群/私聊类型、发送者 allowlist、actor、精确原生 Thread、active execution profile 与 gateway 授权。受限模式仍缺隔离证明，不能激活。停订后不再领取新 delivery；已领取的在途记录沿冻结策略继续结算或保留 unknown。</Alert>
    {pending && <Alert kind="error">有未确认的原操作 <code>{pending}</code>。<button type="button" disabled={busy} onClick={() => void reconcile()}>按原 ID 查回</button></Alert>}
    {error && <Alert kind="error">{error}</Alert>}{notice && <Alert kind="success">{notice}</Alert>}
    <section className="panel"><h2>当前路由</h2>{!loaded ? <p>正在读取…</p> : routes.length === 0 ? <p>当前项目没有已读回路由。</p> :
      <div className="connector-list">{routes.map(route => <article key={route.bindingId} className="connector-card">
        <h3>{route.conversationLabel}</h3>
        <p>{route.source.provider} · {route.conversationKind === "group" ? "群聊" : "私聊"}
          {' '}· <code>{route.source.conversationId}</code> · 连接 {route.source.connectionId}</p>
        <p>Thread <code>{route.targetThreadId}</code> → <a href={`${href(projectId, "sessions")}?session=${encodeURIComponent(route.targetSessionId)}`}>Session {route.targetSessionId}</a></p>
        <p><strong>{route.mode === "standard" ? "标准模式" : "受限模式"} · {route.state}</strong> · v{route.version} · 读回更新 {date(route.updatedAt)}</p>
        <details><summary>路由范围与依据</summary><dl><dt>Binding</dt><dd><code>{route.bindingId}</code></dd><dt>允许发送者</dt><dd>{route.senderIds.join("、")}</dd><dt>接收 / 发送 actor</dt><dd>{route.targetActorId} / {route.senderActorId}</dd><dt>发送目标</dt><dd>{route.sendTargets.join("、") || "无"}</dd><dt>内部目标</dt><dd>{route.internalTargets.join("、") || "无"}</dd><dt>策略哈希</dt><dd><code>{route.policyHash}</code></dd></dl></details>
        <DeliveryPeek token={token} projectId={projectId} bindingId={route.bindingId}/>
        <p className="muted">这些状态来自项目消息与原发送意图；微信界面可见不等于对方已收件。</p>
        {canReview && route.mode === "standard" && <div className="connector-actions">
          {route.state === "active" ? <button type="button" disabled={busy || !!pending} onClick={() => void changeState(route, "paused")}>暂停订阅</button>
            : <button type="button" disabled={busy || !!pending} onClick={() => void changeState(route, "active")}>{route.state === "paused" ? "恢复订阅" : "启用路由"}</button>}
          {route.state === "paused" && <button type="button" disabled={busy || !!pending} onClick={() => void changeState(route, "disabled")}>停用配置</button>}
        </div>}
        {route.mode === "restricted" && <p>受限模式资格未获证明；此处不提供激活操作。</p>}
      </article>)}</div>}{cursor && <button type="button" disabled={busy} onClick={() => void more()}>读取更多路由</button>}</section>
    {canReview && <details className="panel connector-create"><summary>创建标准模式路由</summary><p>先固定并审核来源、接收 Session 和策略；新路由以 disabled 保存，启用另行核验。</p>
      <form onSubmit={event => void create(event)}><div className="connector-fields">
      {([ ["connectionId", "微信连接 ID"], ["conversationId", "来源 conversation ID"],
        ["conversationLabel", "会话名称"], ["conversationKind", "会话类型 group|private"],
        ["targetSessionId", "专用 Session UUID"],
        ["targetThreadId", "原生 Thread ID"], ["targetActorId", "接收 actor"], ["senderActorId", "发送 actor"],
        ["owner", "wx owner"], ["epoch", "wx epoch"],
        ["sessionRef", "wx session_ref"], ["policyHash", "已审策略 SHA-256"], ["bindingId", "Binding UUID"] ] as const).map(([key, label]) =>
        <label key={key}>{label}<input required value={form[key]} onChange={event => setForm(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
      <label>允许发送的 conversation ID（每行一个，必须含来源）<textarea required value={form.sendTargets} onChange={event => setForm(previous => ({ ...previous, sendTargets: event.target.value }))} /></label>
      <label>允许触发 Session 的微信发送者 ID（每行一个，至少一个）<textarea required value={form.senderIds} onChange={event => setForm(previous => ({ ...previous, senderIds: event.target.value }))} /></label>
      <label>允许内部转交的 Session UUID（每行一个；留空即禁止）<textarea value={form.internalTargets} onChange={event => setForm(previous => ({ ...previous, internalTargets: event.target.value }))} /></label></div>
      <button type="submit" disabled={busy || !!pending}>保存 disabled 路由</button></form></details>}
  </div>;
}
