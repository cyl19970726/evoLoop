// 候选与审阅 (docs/frontend/pages/knowledge.md): the candidate list, one candidate in full with its decision, the
// separate publish step, and retracting a fixed source. Review, publish and actual use are separate facts; a decision
// is not a published body. Publish and retract change the outside knowledge space and ask for a second confirmation.
import { useState, type ReactNode } from "react";
import { ArrowLeft, PanelRight } from "lucide-react";
import type { KnowledgeCandidateRecord, KnowledgeCandidateSummary } from "@evoloop/contracts/knowledge";
import {
  Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger, EmptyState, ErrorState, Field,
  ListRow, LoadingState, Notice, RefreshingIndicator, StatusTag, Tabs, TabsContent, TabsList, TabsTrigger, Textarea,
} from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { SourceDocument } from "../../shared/knowledgeClient";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { readingProse, readingSource } from "../../shared/ui/readingProse";
import { Block, Fact, quiet } from "./KnowledgeFacts";
import { knowledgeHref, sourceDocumentHref } from "./knowledgeRoute";
import {
  candidateStatusLabel, candidateStatusTone, epistemicLabel, label, pageTypeLabel, relationTypeLabel, sourceDocumentId, sourceStateLabel,
} from "./knowledgePresentation";

/** A second confirmation that names what changes; Escape or 取消 returns focus to the button that opened it. */
export function Confirm({ trigger, title, children, confirm, onConfirm }: { trigger: ReactNode; title: string; children: ReactNode; confirm: string; onConfirm(): void }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>{trigger}</DialogTrigger>
    <DialogContent>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription asChild><div className="flex flex-col gap-2">{children}</div></DialogDescription>
      <DialogFooter>
        <DialogClose asChild><Button variant="ghost">取消</Button></DialogClose>
        <Button variant="primary" onClick={() => { setOpen(false); onConfirm(); }}>{confirm}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export interface CandidateList {
  items: KnowledgeCandidateSummary[]; more: boolean; reading: boolean; checking: boolean; error: string; loadMore(): void;
}
export interface CandidateRead { data: KnowledgeCandidateRecord | undefined; error: unknown; checking: boolean }
export interface ReviewActions {
  canReview: boolean; busy: boolean; receiptPending: boolean;
  review(candidate: KnowledgeCandidateRecord, decision: "accept" | "reject", reason: string): Promise<boolean>;
  publish(candidate: KnowledgeCandidateRecord): void;
  retract(source: SourceDocument): void;
}

export function KnowledgeReview({ projectId, list, candidateId, candidate, sources, sourcesError, actions, toolbar }: {
  projectId: string; list: CandidateList; candidateId: string | undefined; candidate: CandidateRead;
  sources: SourceDocument[] | undefined; sourcesError: string; actions: ReviewActions; toolbar: ReactNode;
}) {
  return <div className="flex flex-col gap-5">
    <header className="flex flex-col gap-2 compact:pr-12">
      {toolbar}
      <h1 tabIndex={-1} className="text-title font-semibold leading-[1.3] outline-none">候选与审阅</h1>
      <p className="text-small text-text-secondary">候选、审阅、发布各自独立：接受只记录决定，发布才写成新的固定版本，之后是否被用上另看使用记录。</p>
    </header>
    {candidateId ? <CandidateDetail key={candidateId} projectId={projectId} read={candidate} actions={actions} />
      : <CandidateIndex projectId={projectId} list={list} />}
    {actions.canReview && <RetractSources projectId={projectId} sources={sources} error={sourcesError} actions={actions} />}
  </div>;
}

function CandidateIndex({ projectId, list }: { projectId: string; list: CandidateList }) {
  return <section aria-label="知识候选" className="flex flex-col gap-2">
    <h2 className="text-small font-semibold text-foreground">候选</h2>
    {list.error && <Notice tone="error" title="候选列表这次没有读回">{list.error}。{list.items.length ? "下面是上次读回的，当前待核对。" : ""}</Notice>}
    {list.reading && !list.error ? <LoadingState lines={3} label="正在读取候选" />
      : !list.items.length && !list.error ? <EmptyState title={list.more ? "这一页没有候选" : "还没有候选"}
        reason={list.more ? "还有后续页面没有读；载入更多才能确认。" : "浏览知识或过程文档时发现的新认识，可以按固定来源提出候选。"} />
        : <ul className="flex flex-col gap-0.5">{list.items.map(item => <li key={item.candidateId}>
          <ListRow href={knowledgeHref(projectId, { candidateId: item.candidateId })} title={item.title}
            meta={item.expectedRevision ? "修订已有知识页" : "新知识页"}
            trailing={<StatusTag tone={candidateStatusTone[item.status] ?? "unknown"} label={label(candidateStatusLabel, item.status)} />} />
        </li>)}</ul>}
    <div className="flex flex-col gap-1.5 text-caption text-muted-foreground">
      {!list.reading && <span>已载入 {list.items.length} 条{list.more ? " · 后续页面未读" : " · 已读完"}</span>}
      {list.checking && <RefreshingIndicator label="正在核对候选" />}
      {list.more && <Button variant="secondary" size="compact" className="self-start" disabled={list.checking} onClick={list.loadMore}>载入更多候选</Button>}
    </div>
  </section>;
}

function CandidateDetail({ projectId, read, actions }: { projectId: string; read: CandidateRead; actions: ReviewActions }) {
  const panel = useContextPanel();
  const [reason, setReason] = useState("");
  const back = <a href={knowledgeHref(projectId, "review")} className="inline-flex items-center gap-1 text-label font-medium text-primary hover:underline"><ArrowLeft size={15} aria-hidden="true" />全部候选</a>;
  const candidate = read.data;
  if (!candidate) return <section className="flex flex-col gap-3">{back}
    {read.error ? <ErrorState title="这条候选没有读回" happened={`${errorText(read.error)}。`} next="可以回到候选列表重新打开。" /> : <LoadingState lines={5} label="正在读取候选" />}
  </section>;
  const here = knowledgeHref(projectId, { candidateId: candidate.candidateId });
  const decide = async (decision: "accept" | "reject") => { if (await actions.review(candidate, decision, reason)) setReason(""); };
  return <section aria-label="候选全文与审阅" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      {back}
      <div className="flex items-center gap-1">
        {read.checking && <RefreshingIndicator label="正在核对这条候选" />}
        {panel && <Button variant="ghost" size="compact" aria-expanded={panel.open} onClick={() => panel.setOpen(!panel.open)}><PanelRight aria-hidden="true" />来源与关系</Button>}
      </div>
    </div>
    <div className="flex flex-col gap-1.5">
      <h2 className="text-heading font-semibold leading-[1.35] [overflow-wrap:anywhere]">{candidate.title}</h2>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-text-secondary">
        <StatusTag tone={candidateStatusTone[candidate.status] ?? "unknown"} label={label(candidateStatusLabel, candidate.status)} />
        <span>{label(pageTypeLabel, candidate.pageType)}</span><span aria-hidden="true">·</span>
        <span>{label(epistemicLabel, candidate.epistemicStatus)}</span><span aria-hidden="true">·</span>
        <span>{candidate.expectedRevision ? "修订已有知识页" : "新知识页"}</span>
      </p>
    </div>
    {read.error ? <Notice tone="error" title="这条候选这次没有读回">{errorText(read.error)}。下面是上次读回的，当前待核对；先重新读取再决定。</Notice> : null}
    <Tabs defaultValue="rendered">
      <TabsList aria-label="阅读方式" className="mb-2"><TabsTrigger value="rendered">排版</TabsTrigger><TabsTrigger value="source">原文</TabsTrigger></TabsList>
      <TabsContent value="rendered" className={readingProse}>
        <MarkdownBody source={candidate.body} identity={`knowledge-candidate-${candidate.candidateId}-${candidate.candidateRevision}`} omitLeadingTitle={candidate.title} projectId={projectId} />
      </TabsContent>
      <TabsContent value="source"><pre className={readingSource}>{candidate.body}</pre></TabsContent>
    </Tabs>
    <section aria-label="审阅与发布" className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 className="text-small font-semibold text-foreground">审阅与发布</h3>
      {candidate.decision && <p className={quiet}>审阅{candidate.decision.decision === "accept" ? "已接受" : "未采纳"}：{candidate.decision.reason}。{candidate.decision.decision === "accept" && candidate.status !== "published" ? "审阅不等于正文已发布。" : ""}</p>}
      {candidate.status === "pending" && (actions.canReview ? <>
        <Field label="审阅意见" hint="写明接受或不采纳的理由；决定会和候选一起保存。">
          {control => <Textarea {...control} value={reason} onChange={event => setReason(event.target.value)} rows={3} />}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={actions.busy || !reason.trim() || !!read.error} onClick={() => void decide("accept")}>接受候选</Button>
          <Button disabled={actions.busy || !reason.trim() || !!read.error} onClick={() => void decide("reject")}>不采纳</Button>
        </div>
      </> : <p className={quiet}>等有审阅权限的人决定。</p>)}
      {candidate.status === "accepted" && (actions.canReview ? <div className="flex flex-col items-start gap-1.5">
        <Confirm title={`发布「${candidate.title}」？`} confirm="确认发布" onConfirm={() => actions.publish(candidate)}
          trigger={<Button variant="primary" disabled={actions.busy || actions.receiptPending || !!read.error}>发布为固定版本</Button>}>
          <p>{candidate.expectedRevision ? "发布会把这条候选写成该知识页的新固定版本，替换当前版。" : "发布会新建一个知识页。"}旧版本仍可回读。</p>
          <p>如果发布时当前版已经变化，不会覆盖；结果未知时请按原操作核对，不要重复发布。</p>
        </Confirm>
        {actions.receiptPending && <p className="text-caption text-warning">有外部操作的结果待核对，先核对再发布。</p>}
      </div> : <p className={quiet}>已接受，等有审阅权限的人发布。</p>)}
      {candidate.status === "published" && <a href={knowledgeHref(projectId, { knowledgeId: candidate.knowledgeId })} className="text-label font-medium text-primary hover:underline">阅读已发布的知识页 →</a>}
      {candidate.status === "rejected" && <p className={quiet}>这条候选没有被采纳，不会发布。</p>}
    </section>
    <ContextPanelContent><div data-ui="" role="region" aria-label="候选的来源与关系">
      <Block title="来源">
        {candidate.sources.length ? <ul className="flex flex-col gap-2.5">{candidate.sources.map((source, index) => {
          const documentId = sourceDocumentId(source.sourceKey);
          return <li key={`${source.sourceKey}:${source.originRevision}`} className="flex flex-col gap-0.5">
            {documentId ? <a href={sourceDocumentHref(projectId, documentId, source.originRevision, here)} className="text-label font-medium text-primary hover:underline">过程文档 {index + 1} · 固定原件</a>
              : <span className="text-label font-medium">已登记的引用 {index + 1}</span>}
            <span className="text-caption text-muted-foreground">{label(sourceStateLabel, source.state)}{source.fragment ? ` · 片段：${source.fragment}` : ""}</span>
          </li>;
        })}</ul> : <p className={quiet}>没有登记来源。</p>}
      </Block>
      <Block title="拟议关系">
        {candidate.relations.length ? <ul className="flex flex-col gap-2">{candidate.relations.map(item => <li key={item.edgeId} className="flex flex-col gap-0.5">
          <a href={knowledgeHref(projectId, { knowledgeId: item.toKnowledgeId, revision: item.toRevision })} className="text-label font-medium text-primary hover:underline">{label(relationTypeLabel, item.type)} · 目标知识页</a>
          <span className="text-caption text-muted-foreground">{item.sourceKeys.length ? `依据 ${item.sourceKeys.length} 个来源` : "未登记依据"}</span>
        </li>)}</ul> : <p className={quiet}>没有拟议页间关系。</p>}
      </Block>
      <Block title="基线">
        <div className="flex flex-col gap-2.5">
          <Fact label="修订对象">{candidate.expectedRevision ? <a href={knowledgeHref(projectId, { knowledgeId: candidate.knowledgeId, revision: candidate.expectedRevision })} className="text-primary hover:underline">阅读提出时的基线版本</a> : "新知识页，没有基线"}</Fact>
          {candidate.decision && <Fact label="审阅">{candidate.decision.decision === "accept" ? "已接受" : "未采纳"}</Fact>}
        </div>
      </Block>
      <Block title="完整标识" defaultOpen={false}>
        <div className="flex flex-col gap-1 text-caption text-muted-foreground [overflow-wrap:anywhere]">
          <p>候选 <code className="font-mono">{candidate.candidateId}</code></p>
          <p>候选版本 <code className="font-mono">{candidate.candidateRevision}</code></p>
          <p>知识页 <code className="font-mono">{candidate.knowledgeId}</code></p>
          <p>固定基线 <code className="font-mono">{candidate.expectedRevision ?? "新页"}</code></p>
          <p>正文 SHA-256 <code className="font-mono">{candidate.contentHash}</code></p>
          <p>提出操作 <code className="font-mono">{candidate.operationId}</code> · 提出人 <code className="font-mono">{candidate.actorId}</code></p>
          {candidate.decision && <p>审阅人 <code className="font-mono">{candidate.decision.reviewerId}</code></p>}
          {candidate.sources.map((source, index) => <p key={`id:${source.sourceKey}`}>来源 {index + 1} <code className="font-mono">{source.sourceKey}</code> · 版本 <code className="font-mono">{source.originRevision}</code></p>)}
          {candidate.relations.map(item => <p key={`id:${item.edgeId}`}>关系目标 <code className="font-mono">{item.toKnowledgeId}</code> · 版本 <code className="font-mono">{item.toRevision}</code></p>)}
        </div>
      </Block>
    </div></ContextPanelContent>
  </section>;
}

function RetractSources({ projectId, sources, error, actions }: { projectId: string; sources: SourceDocument[] | undefined; error: string; actions: ReviewActions }) {
  return <details className="group rounded-lg bg-muted px-4 py-3">
    <summary className="cursor-pointer text-small font-semibold text-foreground outline-none focus-visible:shadow-[var(--focus-ring)]">撤回固定来源</summary>
    <div className="mt-3 flex flex-col gap-3">
      <p className={quiet}>来源被证明错误或不该再用时撤回。撤回会把引用它的知识页标为待复核；旧版本仍可回读。</p>
      {error && <Notice tone="error" title="来源列表这次没有读回">{error}。</Notice>}
      {!sources ? !error && <LoadingState lines={2} label="正在读取来源" />
        : !sources.length ? <p className={quiet}>已读范围内没有已采纳的固定来源。</p>
          : <ul className="flex flex-col gap-2">{sources.map(source => <li key={source.documentId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 flex-col">
              <a href={sourceDocumentHref(projectId, source.documentId, source.revisionId, knowledgeHref(projectId, "review"))} className="text-label font-medium text-primary hover:underline [overflow-wrap:anywhere]">{source.title}</a>
              <span className="text-caption text-muted-foreground">{label(sourceStateLabel, source.state)}</span>
            </span>
            <Confirm title={`撤回来源《${source.title}》？`} confirm="确认撤回" onConfirm={() => actions.retract(source)}
              trigger={<Button variant="danger" size="compact" disabled={actions.busy || actions.receiptPending || source.state !== "reachable"}>撤回</Button>}>
              <p>引用这份来源的知识页会标为待复核，直到有人重新核对。旧版本仍可回读。</p>
              <p>结果未知时请按原操作核对，不要重复撤回。</p>
            </Confirm>
          </li>)}</ul>}
    </div>
  </details>;
}
