// 知识空间 (docs/frontend/pages/knowledge.md). Inner rail: the 文档 / 知识 switch, filters, 候选与审阅 and the topic
// directory. Center: the space's index, one page read in full, 候选与审阅, or 提出候选. Right column: sources,
// challenges, related pages and versions of the open page (or the open candidate's sources). Reads are project queries;
// writes go through the knowledge API and reread with context.onChanged; publish and retract keep an operation receipt
// until the outside result is reconciled.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { KnowledgeCandidateRecord, KnowledgeRevision } from "@evoloop/contracts/knowledge";
import { Button, Notice, RefreshingIndicator, cn } from "@evoloop/ui";
import { errorCode, errorDetail, errorText, isUnconfirmed } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import type { SourceDocument } from "../../shared/knowledgeClient";
import { currentPath, navigate, onNavigate } from "../../shared/navigation";
import type { ProjectList } from "../../shared/projectList";
import { href } from "../../shared/routes";
import { useContextRailShown } from "../../shared/ui/ContextRail";
import { ReadingSpaceSwitch } from "../../shared/ui/ReadingSpaceSwitch";
import { useRereadOnReturn } from "../../shared/ui/rereadOnReturn";
import { knowledgeReturnHref } from "../../shared/ui/returnRoute";
import { knowledgeAvailability } from "./availability";
import { KnowledgeCompose, emptyDraft, type Draft } from "./KnowledgeCompose";
import { knowledgeApi, useKnowledgeCandidate, useKnowledgeIndex, useKnowledgeReading, useKnowledgeReread } from "./knowledgeData";
import { KnowledgeFacts } from "./KnowledgeFacts";
import { KnowledgeDirectory, KnowledgeFilters, KnowledgeRail, type DirectoryList } from "./KnowledgeRail";
import { serviceState } from "./knowledgeRead";
import { KnowledgeReader } from "./KnowledgeReader";
import { readReceipts, saveReceipts, type ExternalReceipt } from "./knowledgeReceipts";
import { KnowledgeReview, type ReviewActions } from "./KnowledgeReview";
import { knowledgeHref, readKnowledgeRoute, readingOnScreen, type KnowledgeRoute } from "./knowledgeRoute";
import {
  capabilityFacts, emptyFilter, filterKnowledge, isFiltered, knowledgeDirectory, notConfiguredCode, publishOutcome, receiptTitle,
  reconcileOutcome, sourceDocumentId, topicMembers, type KnowledgeFilter, type ListProblem, type Outcome,
} from "./knowledgePresentation";

type Message = Outcome & { ids?: Array<[string, string]> };

function routeHere(projectId: string): KnowledgeRoute {
  const route = readKnowledgeRoute(currentPath(), projectId);
  return route.view === "outside" ? { view: "list" } : route;
}

/** Why a list is not (fully) read: the first page, a reread, the next page, a looping cursor, or no backend at all. */
function listProblem(list: ProjectList<unknown>): ListProblem | null {
  if (!list.error) return list.repeatedCursor ? { kind: "cursor", text: "", detail: null } : null;
  const text = errorText(list.error), detail = errorDetail(list.error);
  if (errorCode(list.error) === notConfiguredCode) return { kind: "unconfigured", text, detail };
  return { kind: list.pageFailed ? "page" : list.stale ? "stale" : "failed", text, detail };
}

function OutcomeNotice({ message, onClose }: { message: Message; onClose(): void }) {
  return <Notice tone={message.tone} title={message.title} action={<Button variant="ghost" size="compact" onClick={onClose}>知道了</Button>}>
    {message.detail}
    {(message.diagnostic || message.ids?.length) && <details className="mt-1 text-caption">
      <summary className="cursor-pointer">{message.ids?.length ? message.diagnostic ? "完整标识与诊断信息" : "完整标识" : "诊断信息"}</summary>
      {message.ids?.map(([name, value]) => <p key={name} className="[overflow-wrap:anywhere]">{name} <code className="font-mono">{value}</code></p>)}
      {message.diagnostic && <p className="[overflow-wrap:anywhere]">服务说明：{message.diagnostic}</p>}
    </details>}
  </Notice>;
}

export function KnowledgePanel({ context }: { context: MutationContext; refresh: number }) {
  const { projectId, principal } = context;
  const canWrite = principal.permissions.includes("write");
  const canReview = principal.permissions.includes("review");
  const [route, setRoute] = useState<KnowledgeRoute>(() => routeHere(projectId));
  // Only a page-to-page switch keeps the previous page on screen while the next loads; opening a page from the index
  // or from 候选与审阅 starts from a loading state instead of resurfacing a page read earlier.
  const routeNow = useRef(route);
  routeNow.current = route;
  const [carryPrevious, setCarryPrevious] = useState(false);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // A note written together with a navigation (候选已保存) is handed to the view it opens.
  const nextMessage = useRef<Message | null>(null);
  useEffect(() => onNavigate(() => {
    const next = readKnowledgeRoute(currentPath(), projectId);
    if (next.view === "outside") return;
    setCarryPrevious(routeNow.current.view === "read" && next.view === "read");
    // A result note belongs to the view it was written in; opening another view drops it (receipts stay).
    setRoute(next); setComposing(false); setMessage(nextMessage.current); nextMessage.current = null;
  }), [projectId]);
  const [filter, setFilter] = useState<KnowledgeFilter>(emptyFilter);
  const index = useKnowledgeIndex(projectId);
  const selectedId = route.view === "read" ? route.id : null;
  const fixedRevision = route.view === "read" ? route.revision : undefined;
  const readQuery = useKnowledgeReading(projectId, selectedId, fixedRevision);
  const candidateId = route.view === "review" ? route.id : undefined;
  const candidateQuery = useKnowledgeCandidate(projectId, candidateId);
  const reread = useKnowledgeReread(projectId);
  useRereadOnReturn(reread);
  const railShown = useContextRailShown();
  const api = knowledgeApi(projectId);

  const [receipts, setReceipts] = useState(readReceipts);
  const visibleReceipts = receipts.filter(item => item.projectId === projectId && item.actorId === principal.actorId);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const updateDraft = (patch: Partial<Draft>) => setDraft(previous => ({ ...previous, ...patch }));

  // ---- service and list
  // A failed next page is the list's own note (这一页没读到), not a failed service read.
  const service = serviceState(index.capabilities, { data: index.pages.items, isFetching: index.pages.reading || index.pages.checking,
    isError: index.pages.failed || index.pages.stale });
  const notConfigured = [index.capabilities.error, index.pages.error].some(cause => errorCode(cause) === notConfiguredCode);
  const availability = knowledgeAvailability(service.capabilities);
  const loadedPages = index.pages.items ?? [];
  const visible = filterKnowledge(loadedPages, filter);
  const directory = knowledgeDirectory(visible);
  const onScreen = readingOnScreen(readQuery.data?.page, readQuery.isPlaceholderData, projectId, selectedId, fixedRevision);
  // Another page kept on screen only stands in while the asked-for page loads; once that read fails, the failure shows
  // instead of the other page.
  const reading = onScreen.previous && (!carryPrevious || readQuery.isError) ? { page: null, previous: false } : onScreen;
  const readingData = reading.page ? readQuery.data : undefined;
  const openTopic = readingData && !reading.previous && readingData.page.pageType === "topic" && readingData.current === readingData.page.revision ? readingData.page : null;
  const list: DirectoryList = {
    topics: directory.topics, pages: directory.pages, members: openTopic ? topicMembers(readingData!.graph, openTopic) : [],
    openTopicId: openTopic?.knowledgeId ?? null, loaded: loadedPages.length, matched: visible.length, filtered: isFiltered(filter),
    more: index.pages.more, fullRead: availability.fullRead, reading: index.pages.reading, checking: index.pages.checking,
    loadingMore: index.pages.loadingMore, coverage: index.pages.coverage, problem: listProblem(index.pages), loadMore: index.pages.loadMore, reread,
  };
  const candidates = index.candidates.items ?? [];
  const pending = candidates.filter(item => item.status === "pending").length;
  const pendingCandidates = pending ? `${pending}${index.candidates.more ? "+" : ""}` : null;
  const sources = index.sources.data?.items;
  // The sources answer as the compose and retract views need it: failed (never read), kept from before, or current.
  const sourcesRead = { error: index.sources.error ? errorText(index.sources.error) : "", stale: index.sources.stale };
  const sourceTitles = new Map((sources ?? []).map(source => [source.documentId, source.title]));
  const pendingTitle = selectedId ? loadedPages.find(item => item.knowledgeId === selectedId)?.title ?? null : null;

  // ---- writes
  const changed = () => context.onChanged();
  const keepReceipt = (receipt: ExternalReceipt) => {
    const next = [...readReceipts().filter(item => item.operationId !== receipt.operationId), receipt];
    if (!saveReceipts(next)) throw new Error("无法在本页保存操作回执，这次没有提交");
    setReceipts(next);
  };
  const dropReceipt = (operationId: string) => {
    const next = readReceipts().filter(item => item.operationId !== operationId);
    if (saveReceipts(next)) setReceipts(next);
  };
  // A receipt is checked by its own operation ID, never a new one.
  async function reconcile(receipt: ExternalReceipt) {
    const { operationId } = receipt;
    setBusy(true); setMessage(null);
    try {
      const { result } = await api.reconcile(operationId);
      const outcome = reconcileOutcome(result, receipt.kind);
      if (outcome.settled) { dropReceipt(operationId); changed(); }
      setMessage(outcome);
    } catch (cause) {
      setMessage({ tone: "error", title: "核对没有完成", detail: `${errorText(cause)}。回执保留，可以稍后再核对。`, diagnostic: errorDetail(cause) ?? undefined });
    } finally { setBusy(false); }
  }
  async function externalWrite(kind: "publish" | "retract", targetId: string) {
    if (!canReview || busy || visibleReceipts.length) return;
    const operationId = crypto.randomUUID();
    try { keepReceipt({ projectId, actorId: principal.actorId, operationId, kind, targetId, createdAt: new Date().toISOString() }); }
    catch (cause) { setMessage({ tone: "error", title: "没有提交", detail: errorText(cause) }); return; }
    setBusy(true); setMessage(null);
    try {
      if (kind === "publish") {
        const result = await api.publish(targetId, operationId);
        if (result.status !== "unknown") dropReceipt(operationId);
        setMessage({ ...publishOutcome(result), ids: [["操作", operationId]] });
      } else {
        const result = await api.retract(targetId, operationId);
        dropReceipt(operationId);
        setMessage({ tone: "info", title: "来源已撤回", detail: result.affected.length ? `${result.affected.length} 个知识页标为待复核。` : "没有知识页引用这份来源。" });
      }
      changed();
    } catch (cause) {
      const unknown = isUnconfirmed(cause);
      if (!unknown) dropReceipt(operationId);
      setMessage({ tone: "error", title: unknown ? `${kind === "publish" ? "发布" : "撤回"}结果未知` : `${kind === "publish" ? "发布" : "撤回"}没有完成`,
        detail: `${errorText(cause)}。${unknown ? "回执已保留，请按原操作核对，不要重复操作。" : "请求没有被接受。"}`,
        diagnostic: errorDetail(cause) ?? undefined, ids: [["操作", operationId]] });
    } finally { setBusy(false); }
  }
  async function propose() {
    if (!canWrite || busy || context.blocked) return;
    const source = sources?.find(item => item.documentId === draft.sourceId && item.state === "reachable");
    if (!source) { setMessage({ tone: "waiting", title: "请选择一份可读取的已采纳来源" }); return; }
    if (!draft.sourceRevision || source.revisionId !== draft.sourceRevision) { updateDraft({ conflict: "所选来源的已采纳版本已经变化。请重新选择来源并核对。" }); return; }
    const target = loadedPages.find(item => item.knowledgeId === draft.relationTarget);
    if (draft.relationTarget && !target) { setMessage({ tone: "waiting", title: "关系目标必须是已发布的知识页" }); return; }
    if (target && target.revision !== draft.relationRevision) { updateDraft({ conflict: "关系目标的发布版本已经变化。请重新选择目标并核对关系。" }); return; }
    setBusy(true); setMessage(null);
    const candidateId = crypto.randomUUID();
    try {
      if (draft.knowledgeId) {
        const current = await api.page(draft.knowledgeId);
        if (!draft.baseRevision || current.revision !== draft.baseRevision) {
          updateDraft({ conflict: "提出时读的版本已经不是当前版。请先阅读当前版，再明确重新整理。" }); return;
        }
      }
      const result = await api.propose({ operationId: crypto.randomUUID(), knowledgeId: draft.knowledgeId ?? crypto.randomUUID(),
        candidateId, candidateRevision: crypto.randomUUID(), expectedRevision: draft.baseRevision,
        title: draft.title.trim(), body: draft.body, pageType: draft.pageType, epistemicStatus: draft.epistemic,
        sources: [{ documentId: source.documentId, revisionId: draft.sourceRevision, fragment: null }],
        relations: target ? [{ toKnowledgeId: target.knowledgeId, toRevision: draft.relationRevision, type: draft.relationType, sourceKeys: [source.sourceKey] }] : [] });
      setDraft(emptyDraft);
      const saved: Message = { tone: "info", title: "候选已保存", detail: "还要经过审阅和发布，当前认识才会改变。" };
      setComposing(false);
      nextMessage.current = saved;
      if (!navigate(knowledgeHref(projectId, { candidateId: result.candidateId }))) { nextMessage.current = null; setMessage(saved); }
      changed();
    } catch (cause) {
      setMessage({ tone: "error", title: isUnconfirmed(cause) ? "候选是否保存没有确认" : "候选没有保存",
        detail: `${errorText(cause)}。草稿还在。${isUnconfirmed(cause) ? "请先在候选列表里找这条候选，不要直接重提。" : ""}`,
        diagnostic: errorDetail(cause) ?? undefined, ids: [["候选", candidateId]] });
    } finally { setBusy(false); }
  }
  const actions: ReviewActions = {
    canReview, busy, receiptPending: visibleReceipts.length > 0,
    async review(candidate: KnowledgeCandidateRecord, decision, reason) {
      if (!canReview || busy || !reason.trim()) return false;
      setBusy(true); setMessage(null);
      try {
        await api.review(candidate.candidateId, { candidateRevision: candidate.candidateRevision, contentHash: candidate.contentHash,
          expectedRevision: candidate.expectedRevision, decision, reason: reason.trim() });
        setMessage(decision === "accept" ? { tone: "info", title: "已接受", detail: "发布是下一步，需要单独确认。" } : { tone: "info", title: "已记录不采纳" });
        changed(); return true;
      } catch (cause) {
        setMessage({ tone: "error", title: isUnconfirmed(cause) ? "审阅结果没有确认" : "审阅没有记录",
          detail: `${errorText(cause)}。${isUnconfirmed(cause) ? "请重新读取这条候选再决定。" : ""}`, diagnostic: errorDetail(cause) ?? undefined });
        return false;
      } finally { setBusy(false); }
    },
    publish: candidate => void externalWrite("publish", candidate.candidateId),
    retract: (source: SourceDocument) => void externalWrite("retract", source.documentId),
  };
  const startNew = () => { if (!draft.touched) setDraft(emptyDraft); setComposing(true); };
  const startRevision = (page: KnowledgeRevision) => {
    if (draft.touched) {
      setMessage({ tone: "waiting", title: "已有没保存的候选草稿", detail: "请先继续原草稿，或清空后再基于此页编辑。" });
      setComposing(true); return;
    }
    setDraft({ ...emptyDraft, knowledgeId: page.knowledgeId, baseRevision: page.revision, baseTitle: page.title, title: page.title, body: page.body,
      pageType: page.pageType, epistemic: page.epistemicStatus, sourceId: sourceDocumentId(page.sources[0]?.sourceKey ?? "") ?? "",
      sourceRevision: page.sources[0]?.originRevision ?? "" });
    setComposing(true);
  };
  const clearDraft = () => { if (draft.touched && !window.confirm("清空没保存的知识候选草稿？")) return; setDraft(emptyDraft); };

  // ---- shared pieces
  const observed = Math.max(index.capabilities.dataUpdatedAt, index.pages.observedAt);
  // Not configured is a setting of this project, not a passing failure: no retry is offered.
  const serviceLine = notConfigured ? { title: "知识后端未配置", detail: "这个项目还没有配置外置知识后端，暂时不能阅读、提出或审阅知识。配置之前，可以去过程文档核对固定原件。" }
    : service.standing === "reading" ? { title: "正在核对知识服务", detail: "先核对服务能力和列表；还没读回不代表没有知识。" }
    : service.standing === "failed" ? { title: "知识服务这次没有读回", detail: `${errorText(index.capabilities.error ?? index.pages.error)}。无法判断有哪些知识，可以重试。` }
      : service.standing === "stale" ? { title: "知识服务这次没有读回", detail: index.pages.stale
        ? "下面是上次读回的列表，当前待核对；不能据此断言正文当前可读。"
        : "服务能力这次没有读回；列表是这次读到的，但不能据此断言正文当前可读。" }
        : availability;
  const facts = (service.capabilities ?? index.capabilities.data);
  const serviceBlock = <section aria-label="知识服务与读取范围" className={cn("flex flex-col gap-1 rounded-lg px-4 py-3", availability.fullRead && service.standing !== "stale" ? "bg-muted" : "bg-warning-soft")}>
    <p className="flex flex-wrap items-center gap-x-2 text-small font-semibold text-foreground">{serviceLine.title}
      {service.standing === "checking" ? <RefreshingIndicator label="正在核对" /> : observed > 0 && <span className="text-caption font-normal text-muted-foreground">{service.standing === "stale" ? "上次读于" : "读于"} {new Date(observed).toLocaleTimeString("zh-CN", { hour12: false })}</span>}</p>
    <p className="text-label text-text-secondary">{serviceLine.detail}</p>
    {facts && <details className="text-caption text-muted-foreground">
      <summary className="cursor-pointer">{index.capabilities.stale ? "上次读回的服务情况（当前待核对）" : "服务与读取范围"}</summary>
      <div className="mt-1 flex flex-col gap-0.5">{capabilityFacts(facts).map(([name, value]) => <p key={name}>{name}：{value}</p>)}
        <p>列表与关系图只覆盖已登记的关系，不能据此推断来源完整或认识正确。</p></div>
    </details>}
  </section>;
  const notices = <>
    {visibleReceipts.map(item => <Notice key={item.operationId} tone="error" title={receiptTitle(item.kind)}
      action={<Button size="compact" disabled={busy} onClick={() => void reconcile(item)}>核对结果</Button>}>
      {new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })} 发起，结果没有确认。按原操作核对，不要重复操作。
      <details className="mt-1 text-caption"><summary className="cursor-pointer">完整标识</summary><p className="[overflow-wrap:anywhere]">操作 <code className="font-mono">{item.operationId}</code></p></details>
    </Notice>)}
    {message && <OutcomeNotice message={message} onClose={() => setMessage(null)} />}
  </>;
  const switcher = !railShown && <ReadingSpaceSwitch projectId={projectId} current="knowledge" className="w-40" />;
  const reviewLink = <Button asChild variant="ghost" size="compact"><a href={knowledgeHref(projectId, "review")}>候选与审阅{pendingCandidates ? ` · ${pendingCandidates}` : ""}</a></Button>;
  const returnHref = knowledgeReturnHref(projectId);

  let center: ReactNode;
  if (composing) center = <KnowledgeCompose projectId={projectId} draft={draft} update={updateDraft} sources={sources}
    sourcesRead={sourcesRead} pages={loadedPages} canWrite={canWrite} busy={busy} blocked={context.blocked}
    onSubmit={() => void propose()} onClear={clearDraft} onClose={() => setComposing(false)}
    backLabel={route.view === "read" ? "返回阅读" : route.view === "review" ? "返回候选与审阅" : "返回知识空间"} />;
  else if (route.view === "read") center = <>
    {!availability.fullRead && service.standing !== "reading" && <Notice tone="waiting" title={serviceLine.title}>{serviceLine.detail}</Notice>}
    <KnowledgeReader projectId={projectId} fixed={!!fixedRevision} returnHref={returnHref} pendingTitle={pendingTitle} canWrite={canWrite}
      read={{ data: readingData, previous: reading.previous, error: readQuery.error, checking: readQuery.checking, observedAt: readQuery.dataUpdatedAt }}
      onRevise={startRevision} onReread={reread} />
    {readingData && <KnowledgeFacts projectId={projectId} reading={readingData} previous={reading.previous}
      stale={!reading.previous && readQuery.stale} sourceTitles={sourceTitles} />}
  </>;
  else if (route.view === "review") center = <KnowledgeReview projectId={projectId} candidateId={candidateId}
    list={{ items: candidates, more: index.candidates.more, reading: index.candidates.reading, checking: index.candidates.checking,
      loadingMore: index.candidates.loadingMore, coverage: index.candidates.coverage, problem: listProblem(index.candidates), loadMore: index.candidates.loadMore }}
    candidate={{ data: candidateQuery.data, error: candidateQuery.error, checking: candidateQuery.checking }}
    sources={sources} sourcesRead={sourcesRead} actions={actions} onReread={reread}
    toolbar={<div className="flex flex-wrap items-center gap-2">{switcher}<a href={knowledgeHref(projectId)} className="text-label font-medium text-primary hover:underline">← 知识空间</a></div>} />;
  else if (route.view === "invalid") center = <section className="flex flex-col items-start gap-3">
    <h1 tabIndex={-1} className="text-title font-semibold outline-none">知识空间</h1>
    <Notice tone="error" title="这个知识链接打不开">{route.message}</Notice>
    <Button asChild size="compact"><a href={knowledgeHref(projectId)}>返回知识空间</a></Button>
  </section>;
  else center = <>
    <header className="flex flex-wrap items-start justify-between gap-3 compact:pr-12">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-title font-semibold leading-[1.3] outline-none">知识空间</h1>
        <p className="mt-1 text-small text-text-secondary">理解当前认识，核对来源与反例，再决定是否提出修订。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="compact" onClick={reread}>重新读取</Button>
        <Button asChild variant="ghost" size="compact"><a href={href(projectId, "evaluations")}>评价</a></Button>
        {canWrite && <Button variant="primary" size="compact" onClick={startNew}>{draft.touched ? "继续候选草稿" : "提出候选"}</Button>}
      </div>
    </header>
    {serviceBlock}
    {!railShown && <div className="flex flex-col gap-2.5">{switcher}<div className="flex flex-wrap items-center gap-2"><KnowledgeFilters filter={filter} update={patch => setFilter(previous => ({ ...previous, ...patch }))} layout="toolbar" />{reviewLink}</div></div>}
    {!availability.fullRead && service.standing !== "reading" && <section aria-label="此时仍可做什么" className="flex flex-col gap-2">
      <h2 className="text-small font-semibold text-foreground">此时仍可做什么</h2>
      <ol className="ml-5 flex list-decimal flex-col gap-1.5 text-label text-text-secondary">
        <li><strong className="font-medium text-foreground">核对固定引用</strong>：打开下面已登记的引用，确认范围与现有结论；正文和来源仍待读取。</li>
        <li><strong className="font-medium text-foreground">查看候选记录</strong>：在候选与审阅里核查待审候选的来源，保留有价值的补充。</li>
        <li><strong className="font-medium text-foreground">{notConfigured ? "配置知识后端后重新读取" : "服务恢复后重新读取"}</strong>：再读正文与来源，判断当前认识。</li>
      </ol>
      <a href={href(projectId, "documents")} className="text-label font-medium text-primary hover:underline">去过程文档核对固定原件 →</a>
    </section>}
    <section aria-label={availability.fullRead ? "知识目录" : "可核对的固定引用"}>
      <KnowledgeDirectory projectId={projectId} list={list} selectedId={null} compact />
    </section>
  </>;
  return <div data-ui="" className="mx-auto flex w-full max-w-[920px] flex-col gap-5 px-4 py-5 compact:px-10 compact:py-7">
    <KnowledgeRail projectId={projectId} filter={filter} update={patch => setFilter(previous => ({ ...previous, ...patch }))} list={list}
      selectedId={selectedId} reviewing={route.view === "review" && !composing} pendingCandidates={pendingCandidates} />
    {notices}
    {center}
  </div>;
}
