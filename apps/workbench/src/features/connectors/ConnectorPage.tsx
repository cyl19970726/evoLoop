import { useEffect, useState, type FormEvent } from "react";
import type { ConnectorRoute, ConnectorRouteRecord } from "@evoloop/contracts/message-connectors";
import { ApiError, errorText } from "../../shared/api";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, Field, Input, Notice, Textarea, cn } from "@evoloop/ui";
import { date, href } from "../../shared/ui/shared";
import { SettingsPage, SettingsSection } from "../../shared/ui/SettingsParts";
import type { MutationContext } from "../../shared/ActionForm";
import { connectorClient, type ConnectorDeliverySummary, type ConnectorDeliveryDetail } from "./client";

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
  return <div className="connector-deliveries flex flex-col gap-1.5 text-small">
    <Button size="compact" variant="ghost" className="w-fit" onClick={() => void load()}>读取最近的投递</Button>
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {items && (items.length === 0 ? <p className="text-caption text-muted-foreground">尚无已关联的来源事件。</p>
      : <ul className="flex flex-col gap-1">{items.map(item => <li key={item.deliveryId}><button type="button" onClick={() => void show(item.deliveryId)} className="text-left text-caption text-text-secondary hover:text-foreground hover:underline">
        投递 {item.deliveryId} · {item.eventCount} 个来源事件{item.unhandledCount ? ` · ${item.unhandledCount} 个需人工处理` : ""} · {item.latestMessageState}{item.decision ? ` · ${item.decision.decision}/${item.decision.state}` : ""}
      </button></li>)}</ul>)}
    {detail && <details open className="rounded-lg bg-field px-3 py-2 text-caption text-text-secondary"><summary className="cursor-pointer text-foreground">投递 {detail.deliveryId} 的原操作</summary>
      {detail.messages.map(message => <p key={message.messageId}>事件 {message.eventCursor} → 消息 <code className="font-mono">{message.messageId}</code> · {message.messageState}/{message.processingState ?? "未开始"} · 运行轮次 <code className="font-mono">{message.nativeTurnId ?? "未绑定"}</code></p>)}
      {detail.unhandled.map(event => <p key={`unhandled-${event.eventCursor}`}>事件 {event.eventCursor} · {event.eventKind}/{event.direction} · {event.reason} · 原长度 {event.contentLength}，未创建平台消息</p>)}
      <p>出站决定：{detail.decision ? `${detail.decision.decision}/${detail.decision.state}` : "尚无"}{detail.decision?.requestId && <> · 原请求 <code className="font-mono">{detail.decision.requestId}</code></>}</p>
    </details>}
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
  const fields = ([["connectionId", "微信连接 ID"], ["conversationId", "来源会话 ID"], ["conversationLabel", "会话名称"], ["conversationKind", "会话类型 group|private"],
    ["targetSessionId", "专用智能体 ID"], ["targetThreadId", "原生会话线程 ID"], ["targetActorId", "接收 actor"], ["senderActorId", "发送 actor"],
    ["owner", "wx owner"], ["epoch", "wx epoch"], ["sessionRef", "wx session_ref"], ["policyHash", "已审策略 SHA-256"], ["bindingId", "绑定 ID"]] as const);
  const areas = ([["sendTargets", "允许发送的会话 ID（每行一个，必须含来源）", true], ["senderIds", "允许触发智能体的微信发送者 ID（每行一个，至少一个）", true],
    ["internalTargets", "允许内部转交的智能体 ID（每行一个；留空即禁止）", false]] as const);
  const muted = "text-caption text-muted-foreground";
  return <SettingsPage title="微信连接" description="查看固定来源与接收智能体，按已审策略保存和停订。路由状态不代表来源消息已处理或微信收件已确认。" className="connector-page"
    action={<Button onClick={() => { setError(""); setReadAgain(value => value + 1); }} disabled={busy}><RefreshCw aria-hidden="true" />重新读取</Button>}>
    <Notice tone="waiting">标准模式使用完整权限的专用智能体，启用前须核对群 / 私聊类型、发送者白名单、actor、精确的原生会话线程、生效中的执行配置与网关授权。受限模式仍缺隔离证明，不能激活。停订后不再领取新的投递；已领取的在途记录按冻结策略继续结算，或保留为结果未知。</Notice>
    {pending && <Notice tone="error" action={<Button size="compact" disabled={busy} onClick={() => void reconcile()}>按原 ID 查回</Button>}>有未确认的原操作 <code className="break-all font-mono">{pending}</code>。</Notice>}
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice>{notice}</Notice>}
    <SettingsSection title="当前路由">
      {!loaded ? <p className="text-small text-text-secondary">正在读取…</p> : routes.length === 0 ? <EmptyState title="还没有路由" reason="当前项目没有已读回的微信路由。" />
        : <ul className="flex flex-col gap-3">{routes.map(route => <li key={route.bindingId} className="connector-card flex flex-col gap-2 rounded-xl bg-raised p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-semibold text-foreground">{route.conversationLabel}</h3>
            <span className={cn("rounded-full px-2.5 py-0.5 text-caption", route.state === "active" ? "bg-accent text-foreground" : "bg-field text-text-secondary")}>{route.mode === "standard" ? "标准模式" : "受限模式"} · {route.state} · v{route.version}</span>
          </div>
          <p className="text-small text-text-secondary">{route.source.provider} · {route.conversationKind === "group" ? "群聊" : "私聊"} · 连接 {route.source.connectionId}</p>
          <p className="text-small text-text-secondary">转给 <a href={`${href(projectId, "sessions")}?session=${encodeURIComponent(route.targetSessionId)}`} className="text-foreground underline">智能体 {route.targetSessionId.slice(0, 8)}</a> · 读回更新 {date(route.updatedAt)}</p>
          <details className="text-small"><summary className="cursor-pointer text-text-secondary">路由范围与依据</summary>
            <dl className="mt-2 flex flex-col gap-1.5 text-caption">{([["绑定", route.bindingId], ["来源会话", route.source.conversationId], ["原生会话线程", route.targetThreadId], ["允许发送者", route.senderIds.join("、")],
              ["接收 / 发送 actor", `${route.targetActorId} / ${route.senderActorId}`], ["发送目标", route.sendTargets.join("、") || "无"], ["内部目标", route.internalTargets.join("、") || "无"], ["策略哈希", route.policyHash]] as const)
              .map(([label, value]) => <div key={label} className="flex flex-col"><dt className="text-muted-foreground">{label}</dt><dd className="m-0 break-all font-mono text-foreground">{value}</dd></div>)}</dl>
          </details>
          <DeliveryPeek token={token} projectId={projectId} bindingId={route.bindingId} />
          <p className={muted}>这些状态来自项目消息与原发送意图；微信界面可见不等于对方已收件。</p>
          {canReview && route.mode === "standard" && <div className="flex flex-wrap gap-2">
            {route.state === "active" ? <Button size="compact" disabled={busy || !!pending} onClick={() => void changeState(route, "paused")}>暂停订阅</Button>
              : <Button size="compact" disabled={busy || !!pending} onClick={() => void changeState(route, "active")}>{route.state === "paused" ? "恢复订阅" : "启用路由"}</Button>}
            {route.state === "paused" && <Button size="compact" variant="danger" disabled={busy || !!pending} onClick={() => void changeState(route, "disabled")}>停用配置</Button>}
          </div>}
          {route.mode === "restricted" && <p className={muted}>受限模式资格未获证明；此处不提供激活操作。</p>}
        </li>)}</ul>}
      {cursor && <Button size="compact" variant="ghost" className="w-fit" disabled={busy} onClick={() => void more()}>读取更多路由</Button>}
    </SettingsSection>
    {canReview && <details className="connector-create rounded-xl bg-raised p-4 shadow-sm">
      <summary className="cursor-pointer text-small font-medium text-foreground">创建标准模式路由</summary>
      <p className={cn(muted, "mt-2")}>先固定并审核来源、接收智能体和策略；新路由以停用状态保存，启用另行核验。</p>
      <form onSubmit={event => void create(event)} className="mt-3 flex flex-col gap-3">
        <div className="grid gap-3 compact:grid-cols-2">
          {fields.map(([key, label]) => <Field key={key} label={label}>{control => <Input {...control} required value={form[key]} onChange={event => setForm(previous => ({ ...previous, [key]: event.target.value }))} />}</Field>)}
        </div>
        {areas.map(([key, label, required]) => <Field key={key} label={label}>{control => <Textarea {...control} required={required} value={form[key]} onChange={event => setForm(previous => ({ ...previous, [key]: event.target.value }))} />}</Field>)}
        <Button type="submit" variant="primary" className="w-fit" disabled={busy || !!pending}>保存为停用路由</Button>
      </form>
    </details>}
  </SettingsPage>;
}
