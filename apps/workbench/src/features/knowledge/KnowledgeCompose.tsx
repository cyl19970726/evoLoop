// 提出候选 (docs/frontend/pages/knowledge.md): a new page or a revision of the current version, always from a fixed
// process-document source. The draft lives in the page (not storage) and survives leaving and coming back; a changed
// source, relation target or base version stops the save and keeps the draft instead of silently replacing it.
import type { FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import type { EpistemicStatus, KnowledgePageType, KnowledgeRelation, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import { Button, Field, Input, Notice, Textarea } from "@evoloop/ui";
import type { SourceDocument } from "../../shared/knowledgeClient";
import { ContextPanelContent } from "../../shared/ui/ContextPanel";
import { Block, Fact, quiet } from "./KnowledgeFacts";
import { knowledgeHref } from "./knowledgeRoute";
import { epistemicLabel, epistemicStates, label, pageTypeLabel, pageTypes, relationTypeLabel, relationTypes } from "./knowledgePresentation";

export interface Draft {
  knowledgeId: string | null; baseRevision: string | null; baseTitle: string;
  title: string; body: string; pageType: KnowledgePageType; epistemic: EpistemicStatus;
  sourceId: string; sourceRevision: string; relationTarget: string; relationRevision: string; relationType: KnowledgeRelation["type"];
  touched: boolean; conflict: string;
}
export const emptyDraft: Draft = {
  knowledgeId: null, baseRevision: null, baseTitle: "", title: "", body: "", pageType: "concept", epistemic: "inference",
  sourceId: "", sourceRevision: "", relationTarget: "", relationRevision: "", relationType: "related", touched: false, conflict: "",
};

const select = "h-9 w-full rounded-md bg-field px-3 text-small text-foreground outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50";

export function KnowledgeCompose({ projectId, draft, update, sources, sourcesError, pages, canWrite, busy, blocked, onSubmit, onClear, onClose, backLabel }: {
  projectId: string; draft: Draft; update(patch: Partial<Draft>): void; sources: SourceDocument[] | undefined; sourcesError: string;
  pages: KnowledgeSummary[]; canWrite: boolean; busy: boolean; blocked: boolean;
  onSubmit(): void; onClear(): void; onClose(): void; backLabel: string;
}) {
  const reachable = (sources ?? []).filter(source => source.state === "reachable");
  const edit = (patch: Partial<Draft>) => update({ ...patch, touched: true });
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  return <section aria-label="提出知识候选" data-dirty={draft.touched ? "true" : undefined} className="flex flex-col gap-5">
    <header className="flex flex-col gap-2 compact:pr-12">
      <button type="button" onClick={onClose} className="inline-flex items-center gap-1 self-start text-label font-medium text-primary hover:underline"><ArrowLeft size={15} aria-hidden="true" />{backLabel}</button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 tabIndex={-1} className="text-title font-semibold leading-[1.3] outline-none">{draft.knowledgeId ? "提出修订候选" : "提出知识候选"}</h1>
        <Button variant="ghost" size="compact" onClick={onClear}>清空草稿</Button>
      </div>
      <p className="text-small text-text-secondary">来源只能选本项目已采纳的固定文档版本。保存只是候选，仍要审阅、发布，当前认识才会改变。</p>
      {draft.knowledgeId && <p className="text-label text-text-secondary">基线是「{draft.baseTitle}」正在读的当前版；当前版变化时不会自动替换草稿。</p>}
    </header>
    {draft.conflict && <Notice tone="waiting" title="草稿已保留，没有保存" action={draft.knowledgeId
      ? <Button asChild size="compact"><a href={knowledgeHref(projectId, { knowledgeId: draft.knowledgeId })}>阅读当前版</a></Button> : undefined}>{draft.conflict}</Notice>}
    {sourcesError && <Notice tone="error" title="可选来源这次没有读回">{sourcesError}。</Notice>}
    <form onSubmit={submit} className="flex max-w-[720px] flex-col gap-4">
      <Field label="标题">{control => <Input {...control} required value={draft.title} onChange={event => edit({ title: event.target.value })} />}</Field>
      <div className="grid grid-cols-1 gap-4 compact:grid-cols-2">
        <Field label="页面类型">{control => <select {...control} className={select} value={draft.pageType} onChange={event => edit({ pageType: event.target.value as KnowledgePageType })}>
          {pageTypes.map(type => <option key={type} value={type}>{pageTypeLabel[type]}</option>)}</select>}</Field>
        <Field label="认识性质" hint="假设要写明怎样会被证伪；解释保留依据和反例。">{control => <select {...control} className={select} value={draft.epistemic} onChange={event => edit({ epistemic: event.target.value as EpistemicStatus })}>
          {epistemicStates.map(state => <option key={state} value={state}>{epistemicLabel[state]}</option>)}</select>}</Field>
      </div>
      <Field label="完整 Markdown 正文">{control => <Textarea {...control} required rows={12} value={draft.body} onChange={event => edit({ body: event.target.value })} className="font-mono" />}</Field>
      <Field label="已采纳的固定来源" hint={sources === undefined && !sourcesError ? "正在读取可选来源…" : reachable.length ? "选一份可读取的过程文档版本。" : "已读范围内没有可读取的来源，暂时不能保存。"}>
        {control => <select {...control} required className={select} value={draft.sourceId} onChange={event => {
          const id = event.target.value;
          edit({ sourceId: id, sourceRevision: reachable.find(source => source.documentId === id)?.revisionId ?? "", conflict: "" });
        }}><option value="">请选择</option>{reachable.map(source => <option key={source.documentId} value={source.documentId}>{source.title}</option>)}</select>}
      </Field>
      <div className="grid grid-cols-1 gap-4 compact:grid-cols-2">
        <Field label="关系目标（可选）" hint="只能选已发布的知识页。">{control => <select {...control} className={select} value={draft.relationTarget} onChange={event => {
          const id = event.target.value;
          edit({ relationTarget: id, relationRevision: pages.find(page => page.knowledgeId === id)?.revision ?? "", conflict: "" });
        }}><option value="">无</option>{pages.map(page => <option key={page.knowledgeId} value={page.knowledgeId}>{page.title}</option>)}</select>}</Field>
        {draft.relationTarget && <Field label="关系类型">{control => <select {...control} className={select} value={draft.relationType} onChange={event => edit({ relationType: event.target.value as KnowledgeRelation["type"] })}>
          {relationTypes.map(type => <option key={type} value={type}>{relationTypeLabel[type]}</option>)}</select>}</Field>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={!canWrite || busy || blocked || !!draft.conflict}>保存候选</Button>
        {blocked && <span className="text-caption text-warning">有操作结果待核对，提交已暂缓。</span>}
      </div>
    </form>
    <ContextPanelContent><div data-ui="" role="region" aria-label="候选的基线与来源">
      <Block title="基线">
        {draft.knowledgeId ? <div className="flex flex-col gap-2.5">
          <Fact label="修订对象"><a href={knowledgeHref(projectId, { knowledgeId: draft.knowledgeId, revision: draft.baseRevision ?? undefined })} className="text-primary hover:underline">{draft.baseTitle}</a></Fact>
          <Fact label="基线版本">提出时正在读的当前版</Fact>
        </div> : <p className={quiet}>新知识页，没有基线。</p>}
      </Block>
      <Block title="所选来源">
        {draft.sourceId ? <p className={quiet}>{(sources ?? []).find(source => source.documentId === draft.sourceId)?.title ?? "所选来源不在已读范围内"}；来源版本变化时须重新选择。</p>
          : <p className={quiet}>还没有选来源。</p>}
      </Block>
      <Block title="完整标识" defaultOpen={false}>
        <div className="flex flex-col gap-1 text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {draft.knowledgeId && <p>知识页 <code className="font-mono">{draft.knowledgeId}</code></p>}
          {draft.baseRevision && <p>固定基线 <code className="font-mono">{draft.baseRevision}</code></p>}
          {draft.sourceRevision && <p>来源版本 <code className="font-mono">{draft.sourceRevision}</code></p>}
          {draft.relationRevision && <p>关系目标版本 <code className="font-mono">{draft.relationRevision}</code> · {label(relationTypeLabel, draft.relationType)}</p>}
          {!draft.knowledgeId && !draft.sourceRevision && <p>还没有可列的标识。</p>}
        </div>
      </Block>
    </div></ContextPanelContent>
  </section>;
}
