// 协作回执 (Feishu projection, docs/frontend/pages/team.md): how each task projection read back, the edits made in
// Feishu that wait for review, and the receipts of writes whose result is not yet known. Reads and rereads go through
// project queries; a write whose answer is lost keeps a receipt (IDs only) until it is read back by the same IDs.
// Rows after the overview's first page are read one page more at a time (useProjectList) and reread with the project;
// rows whose reread failed stay as 上次读回 and offer no write until they are read again.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { DeliveryRecord, IncomingRecord } from "@evoloop/contracts/delivery";
import type { Page, TaskDetail } from "@evoloop/contracts";
import {
  Badge, Button, CollapsibleRow, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, EmptyState, ErrorState, Field, Input,
  LoadingState, Notice, RefreshingIndicator, StatusTag,
} from "@evoloop/ui";
import { api, errorText, isUnconfirmed } from "../../shared/api";
import { diagnosticOf, errorDiagnostic } from "../../shared/errorPresentation";
import { listEndText } from "../../shared/listCoverage";
import { useProjectList } from "../../shared/projectList";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";
import type { MutationContext } from "../../shared/ActionForm";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { ContextPanelContent } from "../../shared/ui/ContextPanel";
import { date, href } from "../../shared/ui/shared";
import { collaborationClient } from "./client";
import {
  attemptActionLabel, canApplyIncoming, clearReceipt, connectionSummary, deliveryTag, incomingTag, mergeById, reasonText, receiptKindLabel,
  receiptSettled, receiptsFor, rememberReceipt, type Receipt, type ReceiptKind,
} from "./collaborationPresentation";
import { actorIdentifier, actorText } from "../../shared/actorPresentation";
import { ActorIdentifiers } from "../../shared/ui/ActorIdentifiers";

const muted = "text-caption text-muted-foreground";
const code = "font-mono text-caption [overflow-wrap:anywhere]";
const link = "text-primary underline-offset-4 hover:underline outline-none focus-visible:shadow-[var(--focus-ring)] rounded-sm";
const store = () => { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } };
type Act = (kind: ReceiptKind, id: string, operationId: string | undefined, send: () => Promise<unknown>) => Promise<void>;

/** A task by its title; the ID stays in 完整标识. */
function TaskName({ projectId, taskId }: { projectId: string; taskId: string }) {
  const read = useProjectQuery(projectId, ["task", taskId, "title"], async () => {
    const detail: TaskDetail = await api().task(projectId, taskId);
    if (detail.task.projectId !== projectId || detail.task.id !== taskId) throw new Error("任务名称来源不匹配");
    return detail.task.title.trim();
  });
  return <a className={`${link} text-small font-medium`} href={href(projectId, "task", taskId)}>{read.data || (read.isError ? "任务名称暂不可读" : "正在读取任务名称")}</a>;
}

/** The reason in Chinese. A reason the page does not know is not shown in the text; its original sits in 完整标识. */
function Reason({ raw, fallback }: { raw: string | null | undefined; fallback?: string }) {
  const { text } = reasonText(raw);
  if (!text && !fallback) return null;
  return <p className="text-small text-text-secondary">{text || fallback}</p>;
}

/** The untranslated original of a reason, for the 完整标识 list. */
function ReasonOriginal({ raw, label = "原因原文" }: { raw: string | null | undefined; label?: string }) {
  const { original } = reasonText(raw);
  return original ? <li>{label} <code className={code}>{original}</code></li> : null;
}

function RailBlock({ title, children }: { title: string; children: ReactNode }) {
  return <details open className="group border-b border-border py-3 first:pt-0 last:border-b-0">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label font-semibold text-foreground outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight size={14} aria-hidden="true" className="text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />{title}
    </summary>
    <div className="mt-2.5 flex flex-col gap-2 pl-5">{children}</div>
  </details>;
}

/** Said on a row whose last reread failed: it may have changed, so nothing is written on it until it is read again. */
const staleRow = "上次读回，当前待核对；重新读取成功后才能处理。";
/** How current a row is: read, being read again (writes wait silently), or its reread failed (上次读回). */
type RowRead = "current" | "checking" | "stale";

function DeliveryRow({ item, projectId, allowed, busy, read, configured, onAction }: {
  item: DeliveryRecord; projectId: string; allowed: boolean; busy: boolean; read: RowRead; configured: boolean; onAction: Act;
}) {
  const stale = read !== "current";
  const [reason, setReason] = useState("");
  const [showAttempts, setShowAttempts] = useState(false);
  const client = collaborationClient("", projectId);
  const attempts = useProjectQuery(projectId, ["collaboration", "attempts", item.eventId], () => client.attempts(item.eventId), { enabled: showAttempts });
  const tag = deliveryTag[item.state];
  const actionable = item.state === "unknown" || item.state === "failed";
  return <li className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 first:pt-0">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5"><TaskName projectId={projectId} taskId={item.taskId} />
        <span className={muted}>本地第 {item.taskVersion} 版 · 更新于 {date(item.updatedAtUtc)}</span></div>
      <StatusTag tone={tag.tone} label={tag.label} />
    </div>
    <Reason raw={item.lastReason} fallback={tag.detail} />
    {read === "stale" && actionable && configured && allowed && <p className={muted} data-row-stale="">{staleRow}</p>}
    {actionable && configured && allowed && <form className="flex flex-col gap-2" onSubmit={event => {
      event.preventDefault();
      if (!reason.trim() || stale) return;
      void onAction(item.state === "unknown" ? "reconcile" : "retry", item.eventId, item.operationId,
        () => item.state === "unknown" ? client.reconcile(item.eventId, reason) : client.retry(item.eventId, reason));
    }}>
      <Field label="处理依据" className="flex-1" hint={item.state === "unknown" ? "结果未知时只能按稳定键对账，不会重发。" : undefined}>
        {control => <Input {...control} value={reason} autoComplete="off" onChange={event => setReason(event.target.value)} />}</Field>
      <Button type="submit" className="self-start" disabled={busy || stale || !reason.trim()}>{item.state === "unknown" ? "按稳定键对账" : "请求重新投影"}</Button>
    </form>}
    <CollapsibleRow summary="尝试记录与完整标识">
      <div className="flex flex-col gap-2">
        {!showAttempts && <Button size="compact" variant="ghost" className="self-start" onClick={() => setShowAttempts(true)}>读取尝试记录</Button>}
        {showAttempts && attempts.isPending && <LoadingState lines={2} label="正在读取尝试记录" />}
        {attempts.isError && <div className="text-caption text-destructive">尝试记录没有读回：{errorText(attempts.error)}<ErrorDetails error={attempts.error} /></div>}
        {attempts.data && (attempts.data.length === 0 ? <p className="text-small text-text-secondary">还没有尝试记录。</p>
          : <ol className="flex flex-col gap-1.5">{attempts.data.map(attempt => <li key={attempt.id} className="flex flex-col gap-0.5">
            <span className="text-small text-foreground">{attemptActionLabel[attempt.action]} → {deliveryTag[attempt.outcome].label}</span>
            <Reason raw={attempt.reason} />
            <span className={muted}>{actorText(attempt.actorId)} · {date(attempt.createdAtUtc)}</span>
            <ActorIdentifiers actors={[["处理人", attempt.actorId]]} />
          </li>)}</ol>)}
        <ul className="flex flex-col gap-0.5 text-caption text-muted-foreground">
          <li>投影事件 <code className={code}>{item.eventId}</code></li>
          <li>任务 <code className={code}>{item.taskId}</code></li>
          <li>原操作 <code className={code}>{item.operationId}</code></li>
          <ReasonOriginal raw={item.lastReason} />
          {attempts.data?.map(attempt => <ReasonOriginal key={attempt.id} raw={attempt.reason} label={`${attemptActionLabel[attempt.action]}的原因原文`} />)}
        </ul>
      </div>
    </CollapsibleRow>
  </li>;
}

function IncomingRow({ item, projectId, allowed, busy, read, onAction }: {
  item: IncomingRecord; projectId: string; allowed: boolean; busy: boolean; read: RowRead; onAction: Act;
}) {
  const stale = read !== "current";
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<"apply" | "reject" | null>(null);
  const client = collaborationClient("", projectId);
  const tag = incomingTag[item.state];
  const reviewable = item.state === "pending" || item.state === "review-only";
  const decide = (decision: "apply" | "reject") => { setConfirm(null); if (!stale) void onAction("review", item.id, item.operationId, () => client.review(item.id, decision, reason)); };
  // A confirmation asked on rows that are now being read again is dropped, not kept for when the read ends.
  useEffect(() => { if (stale) setConfirm(null); }, [stale]);
  return <li className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 first:pt-0">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5"><TaskName projectId={projectId} taskId={item.entityId} />
        <span className={muted}>修改人 {item.actor?.verified ? actorText(item.actor.projectActorId) : "身份未核实"} · 观察于 {date(item.observedAtUtc)} · 基于本地第 {item.observedLocalVersion} 版</span></div>
      <div className="flex shrink-0 items-center gap-1.5">{item.reviewOnly && item.state === "pending" && <Badge>仅供审阅</Badge>}<StatusTag tone={tag.tone} label={tag.label} /></div>
    </div>
    <p className="text-small text-foreground">{item.patch.title ? `建议把标题改为「${item.patch.title}」` : "没有标题修改"}
      {item.patch.status && <span className="text-text-secondary">；远端状态改为「{item.patch.status}」，状态变化要走普通任务流程</span>}</p>
    <Reason raw={item.reason} />
    {item.reviewedBy && <span className={muted}>由 {actorText(item.reviewedBy)} 于 {date(item.reviewedAtUtc ?? undefined)} 处理</span>}
    {item.state === "unknown" && <Notice tone="waiting">任务操作的结果还不知道。按原操作回读后再决定，不要另建新操作。</Notice>}
    {reviewable && allowed && read === "stale" && <p className={muted} data-row-stale="">{staleRow}</p>}
    {reviewable && allowed && <form className="flex flex-col gap-2" onSubmit={event => event.preventDefault()}>
      <Field label="审阅理由">{control => <Input {...control} value={reason} autoComplete="off" onChange={event => setReason(event.target.value)} />}</Field>
      <div className="flex flex-wrap gap-2">
        {canApplyIncoming(item) && <Button disabled={busy || stale || !reason.trim()} onClick={() => setConfirm("apply")}>采纳为任务修订</Button>}
        <Button variant="danger" disabled={busy || stale || !reason.trim()} onClick={() => setConfirm("reject")}>拒绝回写</Button>
      </div>
      {!canApplyIncoming(item) && <p className={muted}>只有修改人身份已核实、只改标题、不改状态的修改可以采纳；其余只能审阅后拒绝回写。</p>}
    </form>}
    <Dialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }}>
      <DialogContent>
        <DialogTitle>{confirm === "apply" ? "采纳这条远端修改？" : "拒绝这条远端修改？"}</DialogTitle>
        <DialogDescription>{confirm === "apply"
          ? `将按当前基线为这项任务提出标题修订「${item.patch.title ?? ""}」，修订仍走普通任务流程。`
          : "保留这条远端记录，不把它写回任务。"} 审阅理由：{reason}</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirm(null)}>取消</Button>
          <Button variant={confirm === "reject" ? "danger" : "primary"} onClick={() => confirm && decide(confirm)}>{confirm === "apply" ? "确认采纳" : "确认拒绝"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <CollapsibleRow summary="完整标识">
      <ul className="flex flex-col gap-0.5 text-caption text-muted-foreground">
        <li>远端候选 <code className={code}>{item.id}</code></li>
        <li>远端记录 <code className={code}>{item.remoteRecordId}</code>{item.observedRemoteOperationId && <> · 远端操作 <code className={code}>{item.observedRemoteOperationId}</code></>}</li>
        <li>任务 <code className={code}>{item.entityId}</code> · 原操作 <code className={code}>{item.operationId}</code></li>
        <li>来源事件 <code className={code}>{item.sourceEventId}</code></li>
        {item.actor?.verified && actorIdentifier(item.actor.projectActorId) && <li>修改人 <code className={code}>{item.actor.projectActorId}</code></li>}
        {actorIdentifier(item.reviewedBy) && <li>处理人 <code className={code}>{item.reviewedBy}</code></li>}
        <ReasonOriginal raw={item.reason} label="限制原文" />
      </ul>
    </CollapsibleRow>
  </li>;
}

/**
 * Rows after the overview's first page (`first` is its cursor): read on request one page more at a time under one key,
 * reread with the project. When the overview's cursor moves (a write changed the first page), they are read again from
 * the new cursor; a reread that fails keeps them as 上次读回 (`stale`), so their writes wait.
 */
function useMore<T>(projectId: string, which: "deliveries" | "incoming", first: string | null | undefined,
  load: (cursor: string) => Promise<Page<T>>, identity: (item: T) => string) {
  const [asked, setAsked] = useState(false);
  const queryClient = useQueryClient();
  const list = useProjectList(projectId, ["collaboration", which, "more"], cursor => load(cursor ?? first!), identity, { enabled: asked && !!first });
  const lastFirst = useRef(first);
  useEffect(() => {
    if (lastFirst.current === first) return;
    lastFirst.current = first;
    if (asked && first) void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId, "collaboration", which, "more") });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);
  const shown = asked && !!first;
  return {
    items: shown ? list.items ?? [] : [],
    /** More rows exist than are on screen. */
    cursor: shown ? list.items === undefined || list.more : !!first,
    /** A cursor came back that was already read: the reading stopped, and the rows may not be all of them. */
    repeatedCursor: shown && list.repeatedCursor,
    reading: shown && (list.reading || list.loadingMore),
    checking: shown && list.checking,
    stale: shown && list.stale,
    failed: shown && (list.failed || list.pageFailed),
    error: list.error,
    loadMore: () => { if (!asked) setAsked(true); else list.loadMore(); },
  };
}

export function CollaborationPanel({ context }: { context: MutationContext; refresh: number }) {
  const { projectId, principal } = context;
  const client = collaborationClient("", projectId);
  const overview = useProjectQuery(projectId, ["collaboration", "overview"], () => client.overview());
  const moreDeliveries = useMore(projectId, "deliveries", overview.data?.deliveries.nextCursor, cursor => client.deliveries(cursor), (item: DeliveryRecord) => item.eventId);
  const moreIncoming = useMore(projectId, "incoming", overview.data?.incoming.nextCursor, cursor => client.incoming(cursor), (item: IncomingRecord) => item.id);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean; detail?: string | undefined } | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>(() => receiptsFor(store(), projectId, principal.actorId));
  const reloadReceipts = () => setReceipts(receiptsFor(store(), projectId, principal.actorId));
  const allowed = principal.permissions.includes("review") && principal.permissions.includes("write") && !context.blocked;
  const data = overview.data;
  const deliveries = data ? mergeById([...data.deliveries.items, ...moreDeliveries.items], item => item.eventId) : [];
  const incoming = data ? mergeById([...data.incoming.items, ...moreIncoming.items], item => item.id) : [];
  const deliveryCursor = moreDeliveries.cursor;
  const incomingCursor = moreIncoming.cursor;
  const deliveryEnd = listEndText({ more: deliveryCursor, repeatedCursor: moreDeliveries.repeatedCursor });
  const incomingEnd = listEndText({ more: incomingCursor, repeatedCursor: moreIncoming.repeatedCursor });
  // A row is as current as the read it came from: the overview's first page, or the later pages.
  const overviewRead: RowRead = overview.isError ? "stale" : overview.isFetching ? "checking" : "current";
  const laterRead = (more: { stale: boolean; checking: boolean }): RowRead => more.stale ? "stale" : more.checking ? "checking" : "current";
  const laterDeliveries = new Set(moreDeliveries.items.map(item => item.eventId));
  const laterIncoming = new Set(moreIncoming.items.map(item => item.id));
  const deliveryRead = (id: string) => laterDeliveries.has(id) ? laterRead(moreDeliveries) : overviewRead;
  const incomingRead = (id: string) => laterIncoming.has(id) ? laterRead(moreIncoming) : overviewRead;
  const connection = data ? connectionSummary(data.configured, data.verifiedAtUtc, data.error) : null;
  const pendingIds = new Set(receipts.map(item => item.id));

  const act: Act = async (kind, id, operationId, send) => {
    if (busy || !allowed) return;
    setBusy(true); setMessage(null);
    const receipt: Receipt = { projectId, actorId: principal.actorId, kind, id, ...(operationId ? { operationId } : {}), createdAt: new Date().toISOString() };
    try {
      const result = await send();
      if (typeof result === "object" && result !== null && "state" in result && result.state === "unknown") {
        rememberReceipt(store(), receipt); reloadReceipts();
        setMessage({ text: "原操作的结果还没核实，已保留回执，稍后按原 ID 回读。", error: true }); context.onChanged(); return;
      }
      clearReceipt(store(), receipt); reloadReceipts();
      setMessage({ text: `${receiptKindLabel[kind]}已提交，正在回读。`, error: false }); context.onChanged();
    } catch (cause) {
      const unconfirmed = isUnconfirmed(cause);
      if (unconfirmed) { rememberReceipt(store(), receipt); reloadReceipts(); }
      setMessage({ text: `${errorText(cause)}${unconfirmed ? "。已保留对象与操作 ID，请按原 ID 回读，确认前不要重复提交。" : ""}`, error: true, detail: diagnosticOf(cause) });
    } finally { setBusy(false); }
  };

  async function check(receipt: Receipt) {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      let text = "结果还没核实，保留原对象与操作 ID，稍后再回读。";
      let settled: boolean;
      if (receipt.kind === "review") {
        const item = await client.incomingItem(receipt.id);
        settled = receiptSettled(receipt, { incoming: item });
        if (!settled && receipt.operationId) {
          try {
            const operation = await api().operation(projectId, receipt.operationId);
            text = `原任务操作已记录为${operation.result.status === "applied" ? "已应用" : "被拒绝"}，这条候选还要审阅结案；保留回执。`;
          } catch { text = "原任务操作还没核实；保留回执，不要重发。"; }
        }
      } else if (receipt.kind === "poll") settled = receiptSettled(receipt, { verifiedAt: (await client.overview()).verifiedAtUtc });
      else settled = receiptSettled(receipt, { delivery: await client.delivery(receipt.id) });
      if (settled) { clearReceipt(store(), receipt); reloadReceipts(); setMessage({ text: "已按原 ID 读回结果。", error: false }); context.onChanged(); }
      else setMessage({ text, error: true });
    } catch (cause) { setMessage({ text: `核对失败：${errorText(cause)}。回执保留。`, error: true, detail: diagnosticOf(cause) }); }
    finally { setBusy(false); }
  }

  const receiptObject = (receipt: Receipt): ReactNode => {
    if (receipt.kind === "poll") return "本项目";
    const taskId = receipt.kind === "review" ? incoming.find(item => item.id === receipt.id)?.entityId : deliveries.find(item => item.eventId === receipt.id)?.taskId;
    return taskId ? <TaskName projectId={projectId} taskId={taskId} /> : "一条记录（不在已读列表里）";
  };

  return <div data-ui="" className="collaboration-page mx-auto flex w-full max-w-[980px] flex-col gap-5 px-4 py-5 compact:px-8 compact:py-7">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>协作回执</h1>
        <p className="mt-1 text-small text-text-secondary">任务投影到飞书后的回读结果，以及在飞书里改动、等待审阅的修改。</p>
        <p className={`${muted} mt-1`} role="status">{overview.isPending ? "正在读取协作状态…" : data ? `协作状态读于 ${date(new Date(overview.dataUpdatedAt).toISOString())}${overview.isError ? "；这次重读失败，以下是上次读回，当前待核对。" : ""}` : "协作状态尚未读回。"}
          {overview.checking && <RefreshingIndicator className="ml-2" />}</p>
      </div>
      <div className="flex items-center gap-2">
        {data?.configured && allowed && <Button disabled={busy || receipts.some(item => item.kind === "poll")} onClick={() => void act("poll", projectId, undefined, () => client.poll())}>回读远端变化</Button>}
        <Button variant="ghost" disabled={overview.isFetching} onClick={context.onChanged}><RefreshCw aria-hidden="true" className={overview.isFetching ? "animate-spin motion-reduce:animate-none" : undefined} />重新读取</Button>
      </div>
    </header>

    {overview.isPending && <LoadingState lines={5} label="正在读取协作状态" />}
    {overview.isError && !data && <ErrorState title="协作状态没有读回" happened={errorText(overview.error)} diagnostics={diagnosticOf(overview.error)} next="现在无法判断投影和远端修改的情况。请重新读取。"
      action={<Button size="compact" onClick={() => void overview.refetch()}>重新读取</Button>} />}
    {message && <Notice tone={message.error ? "error" : "info"}>{message.text}<ErrorDetails failure={message} /></Notice>}
    {data && !allowed && <p className={muted}>{context.blocked ? "本项目还有结果未确认的操作，先在“结果未知的操作”里核对，再处理这里。" : "当前身份没有审阅与写入权限，只能查看。"}</p>}

    {receipts.length > 0 && <section aria-label="待核对的写入" className="flex flex-col gap-3">
      <Notice tone="error" title={`有 ${receipts.length} 项写入结果尚未核实`}>只保存了项目、对象和操作 ID，没有保存令牌。先按原 ID 回读；结果未知的投影只能对账。</Notice>
      <ul className="flex flex-col">{receipts.map(receipt => <li key={`${receipt.kind}:${receipt.id}`} className="flex flex-col gap-2 border-t border-border py-2.5 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-small text-foreground">{receiptKindLabel[receipt.kind]} · {receiptObject(receipt)}<span className={`${muted} ml-2`}>{date(receipt.createdAt)}</span></span>
          <div className="flex flex-wrap gap-2">
            <Button size="compact" disabled={busy} onClick={() => void check(receipt)}>按原 ID 核对</Button>
            {receipt.kind === "review" && allowed && incoming.some(item => item.id === receipt.id && item.state === "unknown") &&
              <Button size="compact" disabled={busy} onClick={() => void act("review", receipt.id, receipt.operationId, () => client.review(receipt.id, "apply", "按原任务操作 ID 复核结案"))}>按原任务操作结案</Button>}
          </div>
        </div>
        <CollapsibleRow summary="完整标识"><ul className="flex flex-col gap-0.5 text-caption text-muted-foreground">
          <li>对象 <code className={code}>{receipt.id}</code></li>{receipt.operationId && <li>原操作 <code className={code}>{receipt.operationId}</code></li>}
        </ul></CollapsibleRow>
      </li>)}</ul>
    </section>}

    {data && <>
      <section aria-label="投影状态" className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold text-foreground">投影状态 <span className={muted}>· 已读 {deliveries.length} 条{deliveryEnd ? `，${deliveryEnd}` : ""}</span></h2>
        {deliveries.length === 0 ? <EmptyState title="还没有任务投影记录" reason="没有记录不等于已经同步：可能没有配置连接，也可能还没有要投影的任务变化。" />
          : <ul className="flex flex-col rounded-xl bg-raised px-4 py-3 shadow-sm">{deliveries.map(item => <DeliveryRow key={item.eventId} item={item} projectId={projectId} allowed={allowed}
            busy={busy || pendingIds.has(item.eventId)} read={deliveryRead(item.eventId)} configured={data.configured} onAction={act} />)}</ul>}
        {moreDeliveries.stale && <Notice tone="waiting" title="上次读回，当前待核对">后续投影重新读取失败：{errorText(moreDeliveries.error)}。后面这些行是上次读到的，重新读取成功前不能处理。<ErrorDetails error={moreDeliveries.error} /></Notice>}
        {moreDeliveries.failed && <div className="text-caption text-destructive">后续投影没有读回：{errorText(moreDeliveries.error)}<ErrorDetails error={moreDeliveries.error} /></div>}
        {deliveryCursor && <Button size="compact" variant="ghost" className="self-start" disabled={moreDeliveries.reading || moreDeliveries.checking} onClick={moreDeliveries.loadMore}>{moreDeliveries.reading ? "正在读取…" : moreDeliveries.failed ? "再读一次" : "加载更多投影"}</Button>}
      </section>
      <section aria-label="远端修改" className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold text-foreground">远端修改 <span className={muted}>· 已读 {incoming.length} 条{incomingEnd ? `，${incomingEnd}` : ""}</span></h2>
        {incoming.length === 0 ? <EmptyState title="还没有远端修改" reason="回读远端变化后，飞书里对任务的改动会作为候选出现在这里；没有可靠的修改人身份时只能人工审阅。" />
          : <ul className="flex flex-col rounded-xl bg-raised px-4 py-3 shadow-sm">{incoming.map(item => <IncomingRow key={item.id} item={item} projectId={projectId} allowed={allowed}
            busy={busy || pendingIds.has(item.id)} read={incomingRead(item.id)} onAction={act} />)}</ul>}
        {moreIncoming.stale && <Notice tone="waiting" title="上次读回，当前待核对">后续远端修改重新读取失败：{errorText(moreIncoming.error)}。后面这些行是上次读到的，重新读取成功前不能采纳或拒绝。<ErrorDetails error={moreIncoming.error} /></Notice>}
        {moreIncoming.failed && <div className="text-caption text-destructive">后续远端修改没有读回：{errorText(moreIncoming.error)}<ErrorDetails error={moreIncoming.error} /></div>}
        {incomingCursor && <Button size="compact" variant="ghost" className="self-start" disabled={moreIncoming.reading || moreIncoming.checking} onClick={moreIncoming.loadMore}>{moreIncoming.reading ? "正在读取…" : moreIncoming.failed ? "再读一次" : "加载更多远端修改"}</Button>}
      </section>
    </>}

    <ContextPanelContent><div className="flex flex-col">
      <RailBlock title="飞书连接">
        {connection ? <>
          <StatusTag tone={connection.tone} label={connection.label} className="self-start" />
          <p className="text-small text-text-secondary">{connection.sentence}</p>
          <p className={muted}>最近核实：{data?.verifiedAtUtc ? date(data.verifiedAtUtc) : "还没有核实记录"}</p>
          {data?.error && <CollapsibleRow summary="连接诊断"><code className={`${code} whitespace-pre-wrap text-muted-foreground`} data-connection-diagnostic="">{data.error}</code></CollapsibleRow>}
          {overview.isError && <CollapsibleRow summary="连接诊断（这次重读）"><code className={`${code} whitespace-pre-wrap text-muted-foreground`}>{errorDiagnostic(overview.error)}</code></CollapsibleRow>}
        </> : <>
          <p className="text-small text-text-secondary">{overview.isError ? "连接状态没有读回，无法判断。" : "正在读取连接状态。"}</p>
          {overview.isError && <CollapsibleRow summary="连接诊断"><code className={`${code} whitespace-pre-wrap text-muted-foreground`} data-connection-diagnostic="">{errorDiagnostic(overview.error)}</code></CollapsibleRow>}
        </>}
      </RailBlock>
      <RailBlock title="待处理">
        {data ? <ul className="flex flex-col gap-1 text-small text-text-secondary">
          <li>待审阅的远端修改：{data.incomingPending} 条</li>
          <li>结果未知的投影：已读到 {deliveries.filter(item => item.state === "unknown").length} 条{deliveryCursor ? "（后续页未读）" : moreDeliveries.repeatedCursor ? "（后续页没有前进，可能不完整）" : ""}</li>
          <li>本机保留的待核对回执：{receipts.length} 项</li>
        </ul> : <p className="text-small text-text-secondary">{overview.isError ? "无法判断。" : "正在读取。"}</p>}
      </RailBlock>
      <RailBlock title="规则">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-small text-text-secondary">
          <li>任务、投影、通知和实际阅读分别核对，飞书已同步不等于有人读过。</li>
          <li>结果未知的投影只能按稳定键对账，不会重发。</li>
          <li>远端表格不会直接改写已接受的任务；采纳只是按当前基线提出修订。</li>
        </ul>
      </RailBlock>
    </div></ContextPanelContent>
  </div>;
}
