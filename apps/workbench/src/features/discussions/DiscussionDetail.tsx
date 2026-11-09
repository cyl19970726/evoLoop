// One discussion. The center reads 准备 → 交接 → 决定, each with the write it allows now; the right column holds
// what the discussion fixed, the tasks, roles and documents linked after its decision, and the full identifiers.
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { DiscussionEvent, DiscussionRecord, DiscussionTarget } from "@evoloop/contracts";
import { Badge, Button, CollapsibleRow, Notice, RefreshingIndicator, StatusTag, cn } from "@evoloop/ui";
import { errorText, safeArtifactHref } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { ContextPanelContent } from "../../shared/ui/ContextPanel";
import { date } from "../../shared/ui/shared";
import { AllocationRelations } from "./AllocationRelationsPanel";
import { canWrite, muted } from "./CommandForm";
import { discussionCopyEnvelope } from "./commands";
import { readDocumentHead, readVerifiedPackage, type Choices } from "./discussionClient";
import { DecisionForm, HandoffForm, LinkForm, targetChoices } from "./DiscussionForms";
import { decisionHistory, eventLabel, kindLabel, nameOr, statusSentence, statusTag, targetKindLabel } from "./discussionPresentation";

const link = "text-primary underline-offset-4 hover:underline outline-none focus-visible:shadow-[var(--focus-ring)] rounded-sm";
const code = "font-mono text-caption [overflow-wrap:anywhere]";
const project = (projectId: string) => `/p/${encodeURIComponent(projectId)}`;
// One stable empty list: useAllocationNames reruns its lookups whenever these arrays change identity.
const noKnownNames = { tasks: [], roles: [], documents: [] };
const fixedDocument = (projectId: string, documentId: string, revisionId: string) =>
  `${project(projectId)}/documents/${encodeURIComponent(documentId)}?revision=${encodeURIComponent(revisionId)}`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-3 border-t border-border pt-5">
    <h3 className="text-body font-semibold text-foreground">{title}</h3>{children}
  </section>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-0.5"><span className={muted}>{label}</span>
    <div className="text-small leading-[1.6] text-foreground [overflow-wrap:anywhere]">{children}</div></div>;
}

/** A right-column block that folds on its own (docs/frontend/layout.md 右栏). */
function RailBlock({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return <details open={defaultOpen} className="group border-b border-border py-3 first:pt-0 last:border-b-0">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label font-semibold text-foreground outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight size={14} aria-hidden="true" className="text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />{title}
    </summary>
    <div className="mt-2.5 flex flex-col gap-2 pl-5">{children}</div>
  </details>;
}

/** Name of a linked object from the choices that were read; the ID stays in the source block. */
function TargetLink({ target, choices, projectId }: { target: DiscussionTarget; choices: Choices | undefined; projectId: string }) {
  const id = encodeURIComponent(target.id);
  const reading = !choices;
  if (target.kind === "task") return <a className={link} href={`${project(projectId)}/tasks/${id}?revision=${encodeURIComponent(target.revisionId)}`}>
    {nameOr(choices?.tasks.find(item => item.id === target.id)?.title, "任务", reading)}</a>;
  if (target.kind === "document") return <a className={link} href={fixedDocument(projectId, target.id, target.revisionId)}>
    {nameOr(choices?.documents.find(item => item.id === target.id)?.title, "文档", reading)}</a>;
  if (target.kind === "role") return <a className={link} href={`${project(projectId)}/roles?role=${id}`}>
    {nameOr(choices?.roles.find(item => item.id === target.id)?.proposal.title, "职责", reading)}</a>;
  return <a className={link} href={`${project(projectId)}/journey`}>{nameOr(choices?.stages.find(item => item.id === target.id)?.deliverable, "阶段", reading)} · 第 {target.version} 版</a>;
}

function usePackage(projectId: string, documentId: string, revisionId: string, enabled = true) {
  return useProjectQuery(projectId, ["discussions", "package", documentId, revisionId],
    signal => readVerifiedPackage(projectId, documentId, revisionId, signal), { enabled });
}

/** A fixed package revision: verified against its SHA-256, copied whole, read in full when unfolded. */
function PackageView({ projectId, documentId, revisionId, label, read }: { projectId: string; documentId: string; revisionId: string; label: string;
  read: ReturnType<typeof usePackage> }) {
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  const copy = async () => {
    if (!read.data) return;
    try { await navigator.clipboard.writeText(discussionCopyEnvelope(window.location.origin, projectId, documentId, revisionId, read.data.body)); setCopied("done"); }
    catch { setCopied("failed"); }
  };
  return <div className="flex flex-col gap-2 rounded-lg bg-muted p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-small font-medium text-foreground">{label}</span>
      {/* A failed read wins over an older answer: the tag never says 已核对 next to a failed check. */}
      {read.isError ? <StatusTag tone="blocked" label="无法核对" /> : read.data ? <StatusTag tone="done" label="原文已核对" /> : <StatusTag tone="unknown" label="正在核对" />}
    </div>
    {read.isError && <p className="text-caption text-destructive">原文没有核对通过：{errorText(read.error)}。现在无法判断交接包是否完整，核对通过之前不能据此登记承接或决定。</p>}
    {read.data && !read.isError && <>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="compact" onClick={() => void copy()}>{copied === "done" ? "已复制完整交接包" : "复制完整交接包"}</Button>
        <a className={`${link} text-label`} href={fixedDocument(projectId, documentId, revisionId)}>在文档页阅读</a>
      </div>
      {copied === "failed" && <p className="text-caption text-destructive">剪贴板不可用，请展开下方原文手动选择复制。</p>}
      <p className={muted}>复制时会在原文前加上工作台入口和固定原件链接，方便对方定位；SHA-256 只核对原文本身。复制不代表对方已收到、读过或同意。</p>
      <CollapsibleRow summary="展开完整原文">
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-raised p-3 font-mono text-caption leading-[1.6] text-foreground [overflow-wrap:anywhere]">{read.data.body}</pre>
      </CollapsibleRow>
    </>}
  </div>;
}

function EventEntry({ event, record, choices, projectId, corrected }: { event: DiscussionEvent; record: DiscussionRecord; choices: Choices | undefined; projectId: string; corrected: boolean }) {
  const payload = event.collaborationPayload;
  return <li className="flex flex-col gap-1 border-t border-border py-2.5 first:border-t-0 first:pt-0">
    <span className="text-small font-medium text-foreground">{eventLabel[event.kind]}{corrected && <span className="font-normal text-muted-foreground"> · 已被纠正</span>}</span>
    {event.choice && <p className="text-small text-text-secondary">取舍：{event.choice}</p>}
    {event.evidence && <p className="text-small text-text-secondary">依据：{event.evidence}</p>}
    {event.reason && <p className="text-small text-text-secondary">理由：{event.reason}</p>}
    {event.unresolved && <p className="text-small text-text-secondary">未解决：{event.unresolved}</p>}
    {event.relookCondition && <p className="text-small text-text-secondary">重看条件：{event.relookCondition}</p>}
    {event.target && <p className="text-small text-text-secondary">后续{targetKindLabel[event.target.kind]}：<TargetLink target={event.target} choices={choices} projectId={projectId} /></p>}
    {payload?.type === "message" && <a className={`${link} text-small`} href={fixedDocument(projectId, payload.body.documentId, payload.body.revisionId)}>阅读消息原文</a>}
    {event.documentRevisionId && <a className={`${link} text-caption`} href={fixedDocument(projectId, record.documentId, event.documentRevisionId)}>阅读当次的固定讨论文档</a>}
    <span className={muted}>{event.actorId} · {date(event.createdAt)}</span>
  </li>;
}

type FormName = "handoff" | "decision" | "link";

export function DiscussionDetail({ context, record, events, choices, choicesLoading, refresh, checking }: {
  context: MutationContext; record: DiscussionRecord; events: DiscussionEvent[]; choices: Choices | undefined; choicesLoading: boolean;
  refresh: number; checking: boolean;
}) {
  const { projectId } = context;
  const samePackage = record.currentDocumentRevisionId === record.preparedDocumentRevisionId;
  const prepared = usePackage(projectId, record.documentId, record.preparedDocumentRevisionId, record.kind !== "task_collaboration");
  const later = usePackage(projectId, record.documentId, record.currentDocumentRevisionId, record.kind !== "task_collaboration" && !samePackage);
  const current = samePackage ? prepared : later;
  const head = useProjectQuery(projectId, ["discussions", "head", record.documentId, record.version],
    // Same document, newer discussion version: the last head stays on screen (and an open form stays mounted) until it is read again.
    signal => readDocumentHead(projectId, record.documentId, signal), { enabled: record.kind !== "task_collaboration", keepPrevious: true });
  const [open, setOpen] = useState<FormName | null>(null);
  const [opened, setOpened] = useState<FormName[]>([]);
  const show = (name: FormName) => { setOpen(name); setOpened(list => list.includes(name) ? list : [...list, name]); };
  const { latest, earlier, corrected } = decisionHistory(events, record.latestDecisionEventId);
  const handoffs = events.filter(event => event.kind === "handoff");
  const links = events.filter(event => event.kind === "action" && event.target);
  // Only a fresh, successful read counts: a failed reread or the previous version's head kept on screen while the new
  // one loads cannot decide whether the two versions differ, so nothing that depends on it can be sent.
  const headFresh = head.data && !head.isError && !head.isPlaceholderData ? head.data : undefined;
  const currentFresh = current.data && !current.isError ? current.data : undefined;
  const mismatch = !!headFresh && headFresh.revisionId !== record.currentDocumentRevisionId;
  const verified = !!currentFresh && !!headFresh;
  const ordinaryReady = verified && !mismatch, recoveryReady = verified && mismatch;
  const unverifiedReason = current.isError ? "交接包原文没有核对通过，无法判断它是否完整，暂不能保存。"
    : head.isError ? "文档当前版没有核实，无法判断它与讨论登记版是否一致，暂不能保存。"
      : !verified ? "正在核对交接包原文和文档当前版，核对完成后才能保存。" : undefined;
  const ordinaryReason = unverifiedReason ?? (mismatch ? "文档当前版与讨论登记版不同，先在“决定”里对照两版并登记恢复。" : undefined);
  const rereading = checking || head.isFetching || current.isFetching;
  const targets = choices ? targetChoices(choices) : [];
  const canReview = canWrite(context, "review");
  const status = statusTag(record.status);
  const title = record.kind === "task_collaboration"
    ? `任务协作 · ${nameOr(choices?.tasks.find(task => task.id === record.task?.id)?.title, "任务", choicesLoading)}` : record.question;
  // An opened form stays mounted (hidden when folded) so its text survives rereads; whether it may send is `notReady`.
  const formSlot = (name: FormName, node: ReactNode) => opened.includes(name) && <div hidden={open !== name}>{node}</div>;
  const goal = record.goal && choices?.goals.find(item => item.id === record.goal!.id);
  const stage = record.stage && choices?.stages.find(item => item.id === record.stage!.id);
  const task = record.task && choices?.tasks.find(item => item.id === record.task!.id);

  const header = <header className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <Badge>{kindLabel[record.kind]}</Badge>
      {record.kind !== "task_collaboration" && <StatusTag tone={status.tone} label={status.label} />}
      {checking && <RefreshingIndicator />}
    </div>
    <h2 className="text-heading font-semibold leading-[1.35] text-foreground [overflow-wrap:anywhere]" tabIndex={-1}>{title}</h2>
    <p className={muted}>由 {record.actorId} 于 {date(record.createdAt)} 准备 · 最近更新 {date(record.updatedAt)} · 第 {record.version} 版</p>
    <p className="text-small leading-[1.6] text-text-secondary">{statusSentence(record, !!latest?.supersedesDecisionEventId)}</p>
  </header>;

  const sources = <RailBlock title="来源与完整标识" defaultOpen={false}>
    <ul className="flex flex-col gap-1 text-caption text-muted-foreground">
      <li>讨论 <code className={code}>{record.id}</code> · 第 {record.version} 版</li>
      <li>讨论文档 <code className={code}>{record.documentId}</code></li>
      {record.kind !== "task_collaboration" && <>
        <li>最初交接包修订 <code className={code}>{record.preparedDocumentRevisionId}</code></li>
        <li>当前登记修订 <code className={code}>{record.currentDocumentRevisionId}</code></li>
        {!samePackage && prepared.data && <li>最初交接包 SHA-256 <code className={code}>{prepared.data.revision.contentHash}</code></li>}
        {current.data && <li>登记修订 SHA-256 <code className={code}>{current.data.revision.contentHash}</code></li>}
        {head.data && <li>文档当前修订 <code className={code}>{head.data.revisionId}</code> · 第 {head.data.version} 版 · SHA-256 <code className={code}>{head.data.contentHash}</code></li>}
      </>}
      {record.goal && <li>目标 <code className={code}>{record.goal.id}</code> · 第 {record.goal.version} 版</li>}
      {record.stage && <li>阶段 <code className={code}>{record.stage.id}</code> · 第 {record.stage.version} 版</li>}
      {record.task && <li>任务 <code className={code}>{record.task.id}</code> · 修订 <code className={code}>{record.task.revisionId}</code></li>}
      {record.adoptedDocuments.map(item => <li key={item.documentId}>采纳文档 <code className={code}>{item.documentId}</code> · 修订 <code className={code}>{item.revisionId}</code></li>)}
      {record.collaboration && <>
        <li>运行 <code className={code}>{record.collaboration.runId}</code></li>
        <li>智能体 <code className={code}>{record.collaboration.sessionId}</code></li>
        <li>派出者 {record.collaboration.issuerActorId} · 执行者 {record.collaboration.recipientActorId}</li>
      </>}
      {record.latestDecisionEventId && <li>当前决定事件 <code className={code}>{record.latestDecisionEventId}</code></li>}
    </ul>
  </RailBlock>;

  if (record.kind === "task_collaboration") return <article aria-label="所选讨论" className="flex max-w-[760px] flex-col gap-5">
    {header}
    {record.task && <a className={`${link} text-small`} href={`${project(projectId)}/tasks/${encodeURIComponent(record.task.id)}`}>在任务页处理协作 →</a>}
    <Section title="协作记录">
      {events.length === 0 ? <Notice tone="waiting">协作记录为空；不能据此判断过程完整。</Notice>
        : <ol className="flex flex-col">{events.map(event => <EventEntry key={event.id} event={event} record={record} choices={choices} projectId={projectId} corrected={false} />)}</ol>}
    </Section>
    <ContextPanelContent><div className="flex flex-col">
      <RailBlock title="关联任务">{record.task
        ? <a className={`${link} text-small`} href={`${project(projectId)}/tasks/${encodeURIComponent(record.task.id)}?revision=${encodeURIComponent(record.task.revisionId)}`}>{nameOr(task?.title, "任务", choicesLoading)}</a>
        : <p className="text-small text-text-secondary">没有绑定任务。</p>}</RailBlock>
      {sources}
    </div></ContextPanelContent>
  </article>;

  return <article aria-label="所选讨论" className="flex max-w-[760px] flex-col gap-5">
    {header}

    <Section title="准备">
      <div className="flex flex-col gap-3">
        <Fact label="备选做法"><ol className="flex list-decimal flex-col gap-1 pl-5">{record.options.map((item, index) => <li key={index} className="whitespace-pre-wrap">{item}</li>)}</ol></Fact>
        <Fact label="授权与不能自行决定的边界"><span className="whitespace-pre-wrap">{record.authorizationBoundary}</span></Fact>
        <Fact label="拟交接的智能体">{record.targetSessionLabel}
          {record.targetSessionRef && (safeArtifactHref(record.targetSessionRef, projectId)
            ? <> · <a className={link} href={safeArtifactHref(record.targetSessionRef, projectId)!} target="_blank" rel="noopener noreferrer">打开引用</a></>
            : <> · <code className={code}>{record.targetSessionRef}</code></>)}
          <span className={`${muted} block`}>记下的是拟交接对象，不表示已送达或已承接。</span></Fact>
      </div>
      <PackageView projectId={projectId} documentId={record.documentId} revisionId={record.preparedDocumentRevisionId} label="最初准备的交接包" read={prepared} />
      {!samePackage && <PackageView projectId={projectId} documentId={record.documentId} revisionId={record.currentDocumentRevisionId} label="当前登记的交接包" read={later} />}
    </Section>

    <Section title="交接">
      {handoffs.length > 0 ? <ol className="flex flex-col">{handoffs.map(event => <EventEntry key={event.id} event={event} record={record} choices={choices} projectId={projectId} corrected={false} />)}</ol>
        : <p className="text-small text-text-secondary">{record.status === "prepared" ? "还没有登记承接观察。" : "讨论记录里没有单独的承接条目。"}</p>}
      {record.status === "prepared" && !canWrite(context, "write") && <p className={muted}>当前身份没有写入权限，不能登记承接观察。</p>}
      {record.status === "prepared" && canWrite(context, "write") && (ordinaryReady
        ? open !== "handoff" && <Button className="self-start" onClick={() => show("handoff")}>登记承接观察</Button>
        : open !== "handoff" && <p className={muted}>{ordinaryReason}</p>)}
      {record.status === "prepared" && canWrite(context, "write") && formSlot("handoff",
        <HandoffForm context={context} record={record} notReady={ordinaryReason} rereading={rereading} onCancel={() => setOpen(null)} />)}
    </Section>

    <Section title="决定">
      {latest ? <div className="flex flex-col gap-1.5 rounded-lg bg-muted p-3">
        <span className="text-small font-medium text-foreground">{latest.supersedesDecisionEventId ? "当前决定（已纠正前一项）" : "当前决定"}</span>
        <Fact label="取舍"><span className="whitespace-pre-wrap">{latest.choice}</span></Fact>
        {latest.unresolved && <Fact label="还没解决"><span className="whitespace-pre-wrap">{latest.unresolved}</span></Fact>}
        {latest.relookCondition && <Fact label="重看条件"><span className="whitespace-pre-wrap">{latest.relookCondition}</span></Fact>}
        {latest.evidence && <Fact label="依据"><span className="whitespace-pre-wrap">{latest.evidence}</span></Fact>}
        {latest.reason && <Fact label="理由"><span className="whitespace-pre-wrap">{latest.reason}</span></Fact>}
        <span className={muted}>{latest.actorId} · {date(latest.createdAt)}{latest.documentRevisionId && <> · <a className={link} href={fixedDocument(projectId, record.documentId, latest.documentRevisionId)}>阅读决定时的固定文档</a></>}</span>
      </div> : <p className="text-small text-text-secondary">{record.status === "prepared" ? "还没有决定；登记承接观察后才能登记决定。" : "还没有登记讨论决定。"}</p>}
      {earlier.length > 0 && <CollapsibleRow summary={`已纠正的决定 · ${earlier.length} 项`}>
        <ol className="flex flex-col">{earlier.map(event => <EventEntry key={event.id} event={event} record={record} choices={choices} projectId={projectId} corrected={corrected.has(event.id)} />)}</ol>
      </CollapsibleRow>}
      {links.length > 0 && <p className="text-small text-text-secondary">已链接 {links.length} 个后续对象，见右栏“关联的任务、职责与文档”。</p>}
      {head.isPending && <p className={muted}>正在读回文档当前版并核对 SHA-256…</p>}
      {head.isPlaceholderData && !head.isError && <p className={muted}>讨论已更新，正在重新核对文档当前版；核对完成前不判断两版是否一致。</p>}
      {head.isError && <Notice tone="error" title="文档当前版没有核实">{errorText(head.error)}。现在无法判断它与讨论登记版是否一致；核实之前不能登记承接、决定或链接对象。</Notice>}
      {mismatch && headFresh && <Notice tone="waiting" title="讨论登记版与文档当前版不同">
        讨论登记的是另一份修订，文档后来又被修订到第 {headFresh.version} 版（作者 {headFresh.author}）。旧讨论原件不会被改写；只有明确确认后，才能从文档当前版接续登记决定。完整标识见右栏。
      </Notice>}
      {mismatch && headFresh && <CollapsibleRow summary={`对照文档当前版原文 · 第 ${headFresh.version} 版`}>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-caption leading-[1.6] text-foreground [overflow-wrap:anywhere]">{headFresh.body}</pre>
      </CollapsibleRow>}
      {record.status !== "prepared" && !canReview && <p className={muted}>当前身份没有审阅权限，不能登记决定或链接后续对象。</p>}
      {record.status !== "prepared" && canReview && (ordinaryReady || recoveryReady) && <div className="flex flex-wrap gap-2">
        {open !== "decision" && <Button onClick={() => show("decision")}>{latest ? "纠正当前决定" : "登记讨论决定"}</Button>}
        {ordinaryReady && latest && open !== "link" && (targets.length > 0
          ? <Button onClick={() => show("link")}>链接后续对象</Button>
          : <span className={muted}>{choicesLoading ? "正在读取可链接的对象…" : "可链接的对象清单没有读回，暂不能链接。"}</span>)}
      </div>}
      {record.status !== "prepared" && canReview && !verified && !open && <p className={muted}>{unverifiedReason}</p>}
      {record.status !== "prepared" && canReview && head.data && formSlot("decision",
        <DecisionForm context={context} record={record} latest={latest} head={head.data} notReady={unverifiedReason} rereading={rereading} onCancel={() => setOpen(null)} />)}
      {canReview && latest && formSlot("link",
        <LinkForm context={context} record={record} decision={latest} choices={targets} notReady={ordinaryReason} rereading={rereading || choicesLoading} onCancel={() => setOpen(null)} />)}
    </Section>

    <CollapsibleRow summary={`讨论记录 · ${events.length} 条`}>
      {events.length === 0 ? <Notice tone="waiting">讨论记录为空；不能据摘要判断过程完整。</Notice>
        : <ol className="flex flex-col">{events.map(event => <EventEntry key={event.id} event={event} record={record} choices={choices} projectId={projectId} corrected={corrected.has(event.id)} />)}</ol>}
    </CollapsibleRow>

    <ContextPanelContent><div className="flex flex-col">
      <RailBlock title="讨论依据">
        {record.goal && <Fact label="目标">{goal ? goal.outcome : choicesLoading ? "正在读取目标名称" : "目标名称暂不可读"} · 第 {record.goal.version} 版</Fact>}
        {record.stage && <Fact label="阶段"><a className={link} href={`${project(projectId)}/journey`}>{nameOr(stage?.deliverable, "阶段", choicesLoading)}</a> · 第 {record.stage.version} 版</Fact>}
        {record.task && <Fact label="任务"><a className={link} href={`${project(projectId)}/tasks/${encodeURIComponent(record.task.id)}?revision=${encodeURIComponent(record.task.revisionId)}`}>{nameOr(task?.title, "任务", choicesLoading)}</a></Fact>}
        <Fact label="已采纳文档">{record.adoptedDocuments.length === 0 ? "没有固定已采纳文档。"
          : <ul className="flex flex-col gap-1">{record.adoptedDocuments.map(item => <li key={item.documentId}>
            <a className={link} href={fixedDocument(projectId, item.documentId, item.revisionId)}>{nameOr(choices?.documents.find(document => document.id === item.documentId)?.title, "文档", choicesLoading)}</a></li>)}</ul>}</Fact>
      </RailBlock>
      <RailBlock title="关联的任务、职责与文档">
        {record.kind === "allocation"
          ? <AllocationRelations context={context} record={record} refresh={refresh} known={choices ?? noKnownNames} namesReady={!choicesLoading} />
          : links.length === 0 ? <p className="text-small text-text-secondary">还没有链接后续对象。讨论内容和拟交接的智能体都不算实际承接。</p>
            : <ul className="flex flex-col gap-1.5">{links.map(event => <li key={event.id} className={cn("text-small", corrected.has(event.decisionEventId ?? "") && "text-muted-foreground")}>
              {targetKindLabel[event.target!.kind]} · <TargetLink target={event.target!} choices={choices} projectId={projectId} />
              {event.decisionEventId !== record.latestDecisionEventId && <span className={`${muted} block`}>关联的是历史决定，需要重新核对。</span>}
            </li>)}</ul>}
      </RailBlock>
      {sources}
    </div></ContextPanelContent>
  </article>;
}
