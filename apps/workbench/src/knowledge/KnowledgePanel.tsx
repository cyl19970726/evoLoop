import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { KnowledgeCandidateRecord, KnowledgeCandidateSummary, KnowledgeCapabilities, KnowledgeGraph,
  KnowledgeRevision, KnowledgeSummary, PublishResult } from "@evoloop/contracts/knowledge";
import { errorText, isUnconfirmed } from "../api";
import { MarkdownBody } from "../ui/MarkdownBody";
import { knowledgeReturnHref } from "../ui/returnRoute";
import { Notice, type MutationContext } from "../workflow/ActionForm";
import { knowledgeClient, type SourceDocument } from "./client";
import { findFixedKnowledgeTitle, matchesKnowledgeRevision, readKnowledgeRoute, transitionKnowledgeRoute,
  unresolvedFixedKnowledgeTitle } from "./knowledgeRoute";
import "./knowledge.css";
import { knowledgeAvailability } from "./availability";
import { currentKnowledgeCapabilities, readKnowledgeOverview, type KnowledgeOverviewRead } from "./overviewRead";

interface ExternalReceipt { projectId: string; actorId: string; operationId: string; kind: "publish" | "retract"; targetId: string; createdAt: string }
const receiptKey = "evoloop.external-knowledge-operations.v1";
function readReceipts(): ExternalReceipt[] {
  try {
    const values: unknown = JSON.parse(sessionStorage.getItem(receiptKey) ?? "[]");
    return Array.isArray(values) ? values.filter((value): value is ExternalReceipt => !!value && typeof value === "object" &&
      typeof value.projectId === "string" && typeof value.actorId === "string" &&
      typeof value.operationId === "string" && (value.kind === "publish" || value.kind === "retract") &&
      typeof value.targetId === "string" && typeof value.createdAt === "string") : [];
  } catch { return []; }
}
function saveReceipts(values: ExternalReceipt[]): boolean {
  try { sessionStorage.setItem(receiptKey, JSON.stringify(values)); return true; } catch { return false; }
}
const sourceId = (key: string) => key.startsWith("document:") ? key.slice(9) : null;
const knowledgeHash = (projectId: string, selection?: { knowledgeId: string; knowledgeRevision?: string } | { candidateId: string }) => {
  const path = `#/p/${encodeURIComponent(projectId)}/knowledge`;
  if (!selection) return path;
  const params = new URLSearchParams();
  if ("candidateId" in selection) params.set("candidateId", selection.candidateId);
  else { params.set("knowledgeId", selection.knowledgeId);
    if (selection.knowledgeRevision) params.set("knowledgeRevision", selection.knowledgeRevision); }
  return `${path}?${params}`;
};
const documentLink = (projectId: string, documentId: string, revision: string, returnHash: string) =>
  `#/p/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}?revision=${encodeURIComponent(revision)}&return=${encodeURIComponent(returnHash)}`;
const statusText = (status: string) => ({ valid: "有效", needs_review: "待复核", withdrawn: "已撤回", pending: "待审",
  accepted: "已接受", rejected: "未采纳", published: "已发布", truncated: "已截断", partial: "部分缺项",
  unavailable: "不可用", complete: "完整", reachable: "可读取", active: "已登记",
  supports: "支持", contradicts: "挑战／反例", related: "相关观察", member_of: "属于", supersedes: "取代",
  topic: "专题", concept: "概念", analysis: "分析", decision: "决定",
  observation: "观察", inference: "推断", hypothesis: "假设", adopted: "已采纳判断",
  disputed: "有争议", superseded: "已取代" } as Record<string, string>)[status] ?? status;

const graphNodeKey = (id: string, revision: string) => `${id}\0${revision}`;
const relationTitleKey = (id: string, revision: string) => `${id}\0${revision}`;

interface RelationTitleCache { scope: string; entries: Record<string, string | null> }

function Graph({ graph, onOpen }: { graph: KnowledgeGraph; onOpen(id: string, revision: string): void }) {
  const positions = new Map(graph.nodes.map((node, index) => [graphNodeKey(node.knowledgeId, node.revision),
    index === 0 ? { x: 300, y: 150 } : { x: 300 + 205 * Math.cos(2 * Math.PI * (index - 1) / Math.max(1, graph.nodes.length - 1)),
      y: 150 + 110 * Math.sin(2 * Math.PI * (index - 1) / Math.max(1, graph.nodes.length - 1)) }]));
  return <div><p>关系图：{statusText(graph.status)} · 水位 {graph.watermark}。只显示已登记的固定关系。</p>
    <svg aria-hidden="true" viewBox="0 0 600 300" style={{ width: "100%", maxWidth: 700, background: "#f5f7fc", borderRadius: 10 }}>
      {graph.edges.map(edge => { const a = positions.get(graphNodeKey(edge.fromKnowledgeId, edge.fromRevision)), b = positions.get(graphNodeKey(edge.toKnowledgeId, edge.toRevision));
        return a && b ? <g key={edge.edgeId}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke={edge.state === "active" ? "#536ec3" : "#a36a68"} strokeWidth="2" />
          <title>{edge.type} · {edge.state} · {edge.fromRevision} → {edge.toRevision}</title></g> : null; })}
      {graph.nodes.map(node => { const point = positions.get(graphNodeKey(node.knowledgeId, node.revision))!;
        return <g key={graphNodeKey(node.knowledgeId, node.revision)}>
          <circle cx={point.x} cy={point.y} r="30" fill={node.validity === "valid" ? "#e6ebfc" : "#f6ded6"} stroke="#596ba4" />
          <text x={point.x} y={point.y + 4} textAnchor="middle" fontSize="11">{node.title.slice(0, 8)}</text>
          <title>{node.title} · {node.revision} · {statusText(node.validity)}</title>
        </g>; })}
    </svg>
    <div className="knowledge-graph-nodes" aria-label="关系图中的知识页">{graph.nodes.map(node =>
      <button key={graphNodeKey(node.knowledgeId, node.revision)} onClick={() => onOpen(node.knowledgeId, node.revision)}>
        {node.title} · 固定版 {node.revision.slice(0, 8)}</button>)}</div>
    {graph.status !== "complete" && <Notice error>关系数据{statusText(graph.status)}，不能据此断言没有其他关联。</Notice>}
  </div>;
}

export function KnowledgePanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const client = useMemo(() => knowledgeClient(context.token, context.projectId), [context.token, context.projectId]);
  const [pages, setPages] = useState<KnowledgeSummary[]>([]);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<KnowledgeCandidateSummary[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceDocument[]>([]);
  const [lastCapabilities, setLastCapabilities] = useState<KnowledgeCapabilities | null>(null);
  const [overviewRead, setOverviewRead] = useState<KnowledgeOverviewRead>({ key: "", status: "reading" });
  const [selectedId, setSelectedId] = useState<string | null>(() => { const route = readKnowledgeRoute(window.location.hash, context.projectId); return route.view === "read" ? route.id : null; });
  const [fixedRevision, setFixedRevision] = useState<string | undefined>(() => { const route = readKnowledgeRoute(window.location.hash, context.projectId); return route.view === "read" ? route.revision : undefined; });
  const [page, setPage] = useState<KnowledgeRevision | null>(null);
  const [currentHead, setCurrentHead] = useState<{ knowledgeId: string; revision: string } | null>(null);
  const [history, setHistory] = useState<KnowledgeSummary[]>([]);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [relationTitleCache, setRelationTitleCache] = useState<RelationTitleCache>({ scope: "", entries: {} });
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(() => { const route = readKnowledgeRoute(window.location.hash, context.projectId); return route.view === "review" ? route.id ?? null : null; });
  const [candidate, setCandidate] = useState<KnowledgeCandidateRecord | null>(null);
  const [error, setError] = useState("");
  const [routeError, setRouteError] = useState(() => { const route = readKnowledgeRoute(window.location.hash, context.projectId); return route.view === "invalid" ? route.message : ""; });
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pageType, setPageType] = useState<"topic" | "concept" | "analysis" | "decision">("concept");
  const [epistemic, setEpistemic] = useState<"observation" | "inference" | "hypothesis" | "adopted" | "disputed" | "superseded">("inference");
  const [selectedSource, setSelectedSource] = useState("");
  const [selectedSourceRevision, setSelectedSourceRevision] = useState("");
  const [relationTarget, setRelationTarget] = useState("");
  const [relationRevision, setRelationRevision] = useState("");
  const [relationType, setRelationType] = useState<"supports" | "contradicts" | "related" | "member_of" | "supersedes">("related");
  const [reviewReason, setReviewReason] = useState("");
  const [composeKnowledgeId, setComposeKnowledgeId] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState<string | null>(null);
  const [composeTouched, setComposeTouched] = useState(false);
  const [composeConflict, setComposeConflict] = useState("");
  const [externalReceipts, setExternalReceipts] = useState(readReceipts);
  const [busy, setBusy] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);
  const overviewKey = JSON.stringify([context.token, context.projectId, context.principal.actorId, refresh, localRefresh]);
  const capabilities = currentKnowledgeCapabilities(overviewRead, overviewKey);
  const listingReading = overviewRead.key !== overviewKey || overviewRead.status === "reading";
  const overviewError = overviewRead.key === overviewKey && overviewRead.status === "failed" ? overviewRead.error : "";
  const [view, setView] = useState<"list" | "read" | "review" | "compose" | "invalid">(() => {
    const route = readKnowledgeRoute(window.location.hash, context.projectId);
    return route.view === "outside" ? "list" : route.view;
  });
  const canWrite = context.principal.permissions.includes("write");
  const canReview = context.principal.permissions.includes("review");
  useEffect(() => {
    const sync = () => {
      const next = transitionKnowledgeRoute({ route: { view: "list" }, page: null, history: [], graph: null }, window.location.hash, context.projectId);
      if (next.route.view === "outside") return;
      setPage(next.page); setCurrentHead(null); setHistory(next.history); setGraph(next.graph);
      setError(""); setRouteError(""); setCandidate(null);
      if (next.route.view === "read") {
        setSelectedId(next.route.id); setFixedRevision(next.route.revision); setSelectedCandidateId(null); setView("read");
      } else if (next.route.view === "review") {
        setSelectedId(null); setFixedRevision(undefined); setSelectedCandidateId(next.route.id ?? null); setView("review");
      } else if (next.route.view === "invalid") {
        setSelectedId(null); setFixedRevision(undefined); setSelectedCandidateId(null); setView("invalid"); setRouteError(next.route.message);
      } else {
        setSelectedId(null); setFixedRevision(undefined); setSelectedCandidateId(null); setView("list");
      }
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [context.projectId]);
  useEffect(() => {
    let active = true;
    setError("");
    void readKnowledgeOverview(client, overviewKey, next => {
      setOverviewRead(next);
      if (next.status === "complete") {
        setLastCapabilities(next.capabilities); setPages(next.pages.items); setPageCursor(next.pages.nextCursor);
        setCandidates(next.candidates.items); setCandidateCursor(next.candidates.nextCursor);
        setSources(next.sources.items); setObservedAt(next.observedAt);
      }
    }, () => active);
    return () => { active = false; };
  }, [client, overviewKey]);
  useEffect(() => {
    if (!selectedId) { setPage(null); setCurrentHead(null); setHistory([]); setGraph(null); return; }
    let active = true; setPage(null); setCurrentHead(null); setHistory([]); setGraph(null); setError("");
    Promise.allSettled([client.page(selectedId, fixedRevision), client.history(selectedId), client.graph(selectedId),
      fixedRevision ? client.page(selectedId) : Promise.resolve(null)])
      .then(([read, past, nearby, head]) => { if (!active) return;
        if (read.status === "fulfilled") setPage(read.value);
        else setError(`正文读取失败：${errorText(read.reason)}`);
        if (head.status === "fulfilled" && head.value?.knowledgeId === selectedId) setCurrentHead(head.value);
        if (past.status === "fulfilled") setHistory(past.value.items);
        if (nearby.status === "fulfilled") setGraph(nearby.value);
        if (read.status === "fulfilled" && (past.status === "rejected" || nearby.status === "rejected"))
          setError("正文已读取；历史或关系暂不可用，请稍后回读。");
      });
    return () => { active = false; };
  }, [context.token, context.projectId, selectedId, fixedRevision, refresh, localRefresh]);
  useEffect(() => {
    if (!selectedCandidateId) { setCandidate(null); return; }
    let active = true;
    client.candidate(selectedCandidateId).then(next => { if (active) setCandidate(next); })
      .catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, selectedCandidateId, refresh, localRefresh]);
  const refreshAll = () => { setLocalRefresh(value => value + 1); context.onChanged(); };
  const visibleReceipts = externalReceipts.filter(item => item.projectId === context.projectId && item.actorId === context.principal.actorId);
  const setReceipt = (receipt: ExternalReceipt) => {
    const next = [...externalReceipts.filter(item => item.operationId !== receipt.operationId), receipt];
    if (!saveReceipts(next)) throw Error("无法保存外部操作恢复回执，本次尚未提交");
    setExternalReceipts(next);
  };
  const clearReceipt = (operationId: string) => {
    const next = externalReceipts.filter(item => item.operationId !== operationId);
    if (saveReceipts(next)) setExternalReceipts(next);
  };
  async function reconcile(operationId: string) {
    setBusy(true); setMessage("");
    try {
      const { result } = await client.reconcile(operationId);
      if (!result || result.status === "unknown") setMessage(result?.status === "unknown" ? result.reason : "外部清单未找到此操作；保持回执，等待核对。");
      else { clearReceipt(operationId); setMessage(result.status === "published" ? "已核到外部固定记录。" : "已核到发布冲突，当前版未被覆盖。"); refreshAll(); }
    } catch (cause) { setMessage(`对账未完成：${errorText(cause)}`); }
    finally { setBusy(false); }
  }
  async function externalWrite(kind: "publish" | "retract", targetId: string) {
    if (!canReview || busy || visibleReceipts.length) return;
    const operationId = crypto.randomUUID();
    try { setReceipt({ projectId: context.projectId, actorId: context.principal.actorId,
      operationId, kind, targetId, createdAt: new Date().toISOString() }); }
    catch (cause) { setMessage(errorText(cause)); return; }
    setBusy(true); setMessage("");
    try {
      if (kind === "publish") {
        const result: PublishResult = await client.publish(targetId, operationId);
        if (result.status === "unknown") { setMessage(`发布结果未知：${result.reason}。请按原操作 ID 对账。`); return; }
        clearReceipt(operationId);
        setMessage(result.status === "published" ? "知识修订已发布，正在回读固定版。" : "基线冲突；候选与审阅保留，请先回读当前版。");
      } else {
        const result = await client.retract(targetId, operationId);
        clearReceipt(operationId);
        setMessage(`来源撤回已登记，${result.affected.length} 个知识页标为待复核。`);
      }
      refreshAll();
    } catch (cause) {
      if (!isUnconfirmed(cause)) clearReceipt(operationId);
      setMessage(`${errorText(cause)}${isUnconfirmed(cause) ? "。结果未知，保留回执并按原操作 ID 对账。" : "。请求未获确认。"}`);
    } finally { setBusy(false); }
  }
  async function propose(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || busy || context.blocked || !selectedSource) return;
    const source = sources.find(item => item.documentId === selectedSource && item.state === "reachable");
    if (!source) { setMessage("请选择可达且已采纳的固定文档来源。"); return; }
    if (!selectedSourceRevision || source.revisionId !== selectedSourceRevision) {
      setComposeConflict("所选来源的已采纳修订已变化。草稿保留；请重新选择并核对固定来源。"); return;
    }
    const target = pages.find(item => item.knowledgeId === relationTarget);
    if (relationTarget && !target) { setMessage("关系目标必须是已发布的固定知识页。"); return; }
    if (target && target.revision !== relationRevision) {
      setComposeConflict("关系目标的发布修订已变化。草稿保留；请重新选择目标并核对关系。"); return;
    }
    setBusy(true); setMessage("");
    const candidateId = crypto.randomUUID();
    try {
      if (composeKnowledgeId) {
        const current = await client.page(composeKnowledgeId);
        if (!editingRevision || current.revision !== editingRevision) {
          setComposeConflict(`编辑基线为 ${editingRevision?.slice(0, 8) ?? "未知"}，当前发布版为 ${current.revision.slice(0, 8)}。草稿已保留；请阅读当前版后明确重新整理。`);
          return;
        }
      }
      const result = await client.propose({ operationId: crypto.randomUUID(), knowledgeId: composeKnowledgeId ?? crypto.randomUUID(),
        candidateId, candidateRevision: crypto.randomUUID(), expectedRevision: editingRevision,
        title: title.trim(), body, pageType, epistemicStatus: epistemic,
        sources: [{ documentId: source.documentId, revisionId: selectedSourceRevision, fragment: null }],
        relations: target ? [{ toKnowledgeId: target.knowledgeId, toRevision: relationRevision,
          type: relationType, sourceKeys: [source.sourceKey] }] : [] });
      setComposeTouched(false); setComposeConflict("");
      openCandidate(result.candidateId);
      setMessage("候选已保存，仍需明确审阅后才能发布。"); refreshAll();
    } catch (cause) { setMessage(`${errorText(cause)}。若连接中断，请按候选 ID ${candidateId} 回读候选列表，不要盲目重提。`); }
    finally { setBusy(false); }
  }
  async function review(decision: "accept" | "reject") {
    if (!candidate || !reviewReason.trim() || !canReview || busy) return;
    setBusy(true); setMessage("");
    try {
      await client.review(candidate.candidateId, { candidateRevision: candidate.candidateRevision,
        contentHash: candidate.contentHash, expectedRevision: candidate.expectedRevision,
        decision, reason: reviewReason.trim() });
      setMessage(decision === "accept" ? "接受审阅已记录；发布是下一步独立操作。" : "未采纳决定已记录。"); refreshAll();
    } catch (cause) { setMessage(errorText(cause)); }
    finally { setBusy(false); }
  }
  const openPage = (id: string, revision?: string) => {
    setPage(null); setCurrentHead(null); setHistory([]); setGraph(null);
    setSelectedId(id); setFixedRevision(revision); setView("read");
    window.location.hash = knowledgeHash(context.projectId, { knowledgeId: id, knowledgeRevision: revision });
  };
  const openCandidate = (id: string) => {
    setSelectedCandidateId(id); setView("review");
    window.location.hash = knowledgeHash(context.projectId, { candidateId: id });
  };
  const showList = () => { setView("list"); window.location.hash = knowledgeHash(context.projectId); };
  const showReview = () => { setView("review"); window.location.hash = `${knowledgeHash(context.projectId)}?review=1`; };
  const startNewCandidate = () => {
    if (!composeTouched) {
      setComposeKnowledgeId(null); setEditingRevision(null); setTitle(""); setBody("");
      setSelectedSource(""); setSelectedSourceRevision(""); setRelationTarget(""); setRelationRevision(""); setComposeConflict("");
    }
    setView("compose");
  };
  const resetDraft = () => {
    if (composeTouched && !window.confirm("清空尚未保存的知识候选草稿？")) return;
    setComposeKnowledgeId(null); setEditingRevision(null); setTitle(""); setBody("");
    setSelectedSource(""); setSelectedSourceRevision(""); setRelationTarget(""); setRelationRevision(""); setComposeTouched(false); setComposeConflict("");
  };
  const startRevision = () => {
    if (!page || !readingCurrent) return;
    if (composeTouched) { setMessage("已有未保存的候选草稿；请先继续原草稿或明确清空后再基于此页编辑。"); setView("compose"); return; }
    setComposeKnowledgeId(page.knowledgeId); setEditingRevision(page.revision); setComposeConflict("");
    setTitle(page.title); setBody(page.body); setPageType(page.pageType); setEpistemic(page.epistemicStatus);
    setSelectedSource(sourceId(page.sources[0]?.sourceKey ?? "") ?? "");
    setSelectedSourceRevision(page.sources[0]?.originRevision ?? "");
    setRelationTarget(""); setRelationRevision(""); setView("compose");
  };
  const currentRevision = !fixedRevision && page?.knowledgeId === selectedId ? page.revision
    : currentHead?.knowledgeId === selectedId ? currentHead.revision : undefined;
  const visiblePage = page?.projectId === context.projectId && matchesKnowledgeRevision(page, selectedId, fixedRevision) ? page : null;
  const readingCurrent = !!visiblePage && (!fixedRevision || visiblePage.revision === currentRevision);
  const relationScope = `${context.projectId}\0${context.token}`;
  const relationName = (id: string, revision: string) => {
    const graphTitle = findFixedKnowledgeTitle(id, revision, graph?.nodes ?? []);
    const cached = relationTitleCache.scope === relationScope ? relationTitleCache.entries[relationTitleKey(id, revision)] : undefined;
    return graphTitle ?? (typeof cached === "string" ? cached : unresolvedFixedKnowledgeTitle);
  };
  const outgoing = visiblePage?.relations.map(item => ({ edge: item, otherId: item.toKnowledgeId,
    otherRevision: item.toRevision, direction: "指向" })) ?? [];
  const incoming = readingCurrent ? graph?.edges.filter(item => item.toKnowledgeId === visiblePage?.knowledgeId &&
    item.toRevision === visiblePage.revision && item.fromKnowledgeId !== visiblePage.knowledgeId).map(item => ({
      edge: item, otherId: item.fromKnowledgeId, otherRevision: item.fromRevision, direction: "来自" })) ?? [] : [];
  const relations = [...outgoing, ...incoming.filter(item => !outgoing.some(other => other.edge.edgeId === item.edge.edgeId))];
  const relationTargetKeyList = [...new Set(relations.map(item => relationTitleKey(item.otherId, item.otherRevision)))].sort().join("\n");
  useEffect(() => {
    let active = true;
    setRelationTitleCache(previous => previous.scope === relationScope ? previous : { scope: relationScope, entries: {} });
    const targets = [...new Map(relations.map(item => [relationTitleKey(item.otherId, item.otherRevision),
      { id: item.otherId, revision: item.otherRevision }])).values()];
    for (const target of targets) {
      const exactGraphTitle = findFixedKnowledgeTitle(target.id, target.revision, graph?.nodes ?? []);
      const key = relationTitleKey(target.id, target.revision);
      const cached = relationTitleCache.scope === relationScope ? relationTitleCache.entries[key] : undefined;
      if (exactGraphTitle || cached !== undefined) continue;
      void client.page(target.id, target.revision).then(fixed => {
        if (!active) return;
        const title = fixed.knowledgeId === target.id && fixed.revision === target.revision && fixed.title.trim()
          ? fixed.title.trim() : null;
        setRelationTitleCache(previous => previous.scope === relationScope
          ? { ...previous, entries: { ...previous.entries, [key]: title } }
          : { scope: relationScope, entries: { [key]: title } });
      }).catch(() => {
        if (!active) return;
        setRelationTitleCache(previous => previous.scope === relationScope
          ? { ...previous, entries: { ...previous.entries, [key]: null } }
          : { scope: relationScope, entries: { [key]: null } });
      });
    }
    return () => { active = false; };
  }, [client, relationScope, relationTargetKeyList, graph, relationTitleCache]);
  const returnHref = knowledgeReturnHref(context.projectId);
  const availability = capabilities ? knowledgeAvailability(capabilities) : {
    fullRead: false, title: listingReading ? "正在核对知识读取状态" : "本次知识读取状态未核对",
    detail: observedAt ? "保留上次完整读回的记录；本次能力与列表未核实，不能据旧状态断言正文当前可读。" : "先核对服务能力和完整列表；尚未读回不代表没有知识。",
  };
  return <div className="knowledge-space">
    <div className="knowledge-toolbar">
      <div><p className="knowledge-purpose">理解当前认识，核对来源与反例，再决定是否修订。</p></div>
      <div className="actions"><button onClick={refreshAll}>回读当前状态</button>
        <a className="button-link" href={`#/p/${context.projectId}/evaluations${selectedId ? `?knowledgePageId=${encodeURIComponent(selectedId)}` : ""}`}>关联评价 →</a>
        {canWrite && <button onClick={startNewCandidate}>{composeTouched ? "继续候选草稿" : "提出候选"}</button>}
        <button onClick={showReview}>候选与审阅{candidates.length ? ` · ${candidates.length}` : ""}</button></div>
    </div>
    <section className={`knowledge-read-state${availability.fullRead ? "" : " limited"}`} aria-label="知识服务与读取范围"><strong>{availability.title}</strong><p>{availability.detail}</p><small>{listingReading ? "正在重新核对…" : observedAt ? `${capabilities ? "读于" : "上次完整读取"} ${new Date(observedAt).toLocaleString("zh-CN")}${overviewError ? " · 本次未核实" : ""}` : "尚未完整读回"}</small><details><summary>{capabilities ? "服务与索引证据" : "上次能力证据（当前未核实）"}</summary><p>后端报告版本：{(capabilities ?? lastCapabilities)?.backendVersion ?? "未报告"} · 固定修订读取：{(capabilities ?? lastCapabilities)?.fixedRevisionRead ?? "未核"} · 语义索引：未验证。列表与图只覆盖已登记的关系，不能推断来源完整或认识正确。</p></details></section>
    {overviewError && <Notice error>本次知识能力与列表未完整读回：{overviewError}。保留上次记录，当前能力待重新核对。</Notice>}
    {error && view !== "invalid" && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
    {view === "invalid" && <section className="knowledge-invalid-route"><Notice error>{routeError || "此知识链接路径或参数不受支持。请从知识列表重新打开固定版本。"}</Notice>
      <button onClick={showList}>返回知识列表</button></section>}
    {visibleReceipts.map(item => <Notice key={item.operationId} error>外部{item.kind === "publish" ? "发布" : "撤回"}结果待核 · 操作 <code>{item.operationId}</code>
      <button disabled={busy} onClick={() => reconcile(item.operationId)}>按此 ID 对账</button></Notice>)}

    {view === "list" && <section className="knowledge-list" aria-label="已发布知识列表">
      <div className="knowledge-list-head"><h2>{availability.fullRead ? "知识页面" : "可核对的固定引用"}</h2><span className="muted">{availability.fullRead ? "打开正文、条件与支持/挑战来源" : "登记关系可查；正文仍须实际读取"}</span></div>
      {pages.length ? pages.map(item => <button className="knowledge-list-row" key={item.knowledgeId} onClick={() => openPage(item.knowledgeId)}>
        <span><strong>{item.title}</strong><small>{statusText(item.pageType)} · 修订 {item.revision.slice(0, 8)}</small></span>
        <span>{statusText(item.validity)} <span aria-hidden="true">→</span></span></button>) : <p className="empty">{listingReading ? "正在读取知识与固定引用…" : overviewError || error ? "列表尚未完整读回，请重试读取或核对来源。" : availability.fullRead ? "当前读取范围尚无知识页面。" : "当前读取范围尚无已登记的固定引用。"}</p>}
      {pageCursor && <button onClick={async () => { try { const next = await client.pages(pageCursor); setPages(previous => [...previous, ...next.items]); setPageCursor(next.nextCursor); } catch (cause) { setError(errorText(cause)); } }}>加载更多知识</button>}
    </section>}

    {view === "read" && <div className="knowledge-reader">
      <div className="knowledge-reader-main">{returnHref && <a className="knowledge-back" href={returnHref}>← 返回来源</a>}
        <button className="knowledge-back" onClick={showList}>返回知识列表</button>
        {visiblePage ? <article>
          <p className="knowledge-kicker">{statusText(visiblePage.pageType)} · {statusText(visiblePage.epistemicStatus)} · {statusText(visiblePage.observedValidity)}</p>
          <h2>{visiblePage.title}</h2>
          <div className="knowledge-version"><span><strong>正在阅读</strong> {visiblePage.revision.slice(0, 8)}{readingCurrent ? " · 当前版" : currentRevision ? " · 固定历史版" : " · 固定版，当前状态待核"}</span>
            <span><strong>当前发布</strong> {currentRevision?.slice(0, 8) ?? "尚未核到"}</span></div>
          {visiblePage.validity !== visiblePage.observedValidity && <Notice error>此固定版创建时为{statusText(visiblePage.validity)}；目前标为{statusText(visiblePage.observedValidity)}。使用前请复核来源。</Notice>}
          {fixedRevision && !readingCurrent && <button onClick={() => openPage(visiblePage.knowledgeId)}>阅读当前发布版</button>}
          <div className="knowledge-fulltext"><MarkdownBody source={visiblePage.body} identity={`knowledge-${visiblePage.knowledgeId}-${visiblePage.revision}`}
            omitLeadingTitle={visiblePage.title} projectId={context.projectId} /></div>
          <details className="knowledge-source-text"><summary>核对 Markdown 原文</summary><pre>{visiblePage.body}</pre></details>
          <p className="muted">正文 SHA-256 <code className="break-anywhere">{visiblePage.contentHash}</code></p>
          {canWrite && <details className="knowledge-maintenance"><summary>基于此页提出修订候选</summary>
            {readingCurrent ? <><p className="muted">编辑基线固定为当前所读版；打开编辑区后仍须保存、审阅、发布。</p><button onClick={startRevision}>打开候选编辑区</button></>
              : <p className="muted">正在阅读历史版。请先阅读当前发布版，再明确基于当前版提出修订；历史正文不会自动当作当前基线。</p>}</details>}
        </article> : error ? <p>无法读取此固定修订。</p> : <p>正在读取知识全文…</p>}
      </div>
      {visiblePage && <aside className="knowledge-reader-side" aria-label="来源、关系与版本">
        <section><h3>固定来源</h3>{visiblePage.sources.length ? <ul className="knowledge-source-list">{visiblePage.sources.map(source => { const id = sourceId(source.sourceKey);
          return <li key={`${source.sourceKey}:${source.originRevision}`}><strong>{id ? "过程文档" : source.sourceKey}</strong>
            <span>{statusText(source.state)} · 修订 {source.originRevision.slice(0, 8)}</span>
            <code title={source.contentHash}>SHA-256 {source.contentHash.slice(0, 16)}…</code>
            {source.fragment && <span>片段：{source.fragment}</span>}
            {id && <a href={documentLink(context.projectId, id, source.originRevision,
              knowledgeHash(context.projectId, { knowledgeId: visiblePage.knowledgeId, knowledgeRevision: visiblePage.revision }))}>阅读固定原件 →</a>}</li>; })}</ul> : <p className="muted">此版未登记来源。</p>}</section>
        <section><h3>挑战与反例</h3>{relations.filter(item => item.edge.type === "contradicts").length ?
          <ul className="knowledge-relation-list">{relations.filter(item => item.edge.type === "contradicts").map(item =>
            <li key={item.edge.edgeId}><button onClick={() => openPage(item.otherId, item.otherRevision)}>{relationName(item.otherId, item.otherRevision)} →</button>
              <small>{item.direction}此页 · {statusText(item.edge.state)} · 固定版 {item.otherRevision} · 知识 ID {item.otherId} · 来源 {item.edge.sourceKeys.join("、") || "未登记"}</small></li>)}</ul>
          : <p className="muted">此版未登记挑战关系；不能据此断言没有反例。请结合正文与来源判断。</p>}</section>
        <section><h3>其他已登记关系</h3>{relations.filter(item => item.edge.type !== "contradicts").length ?
          <ul className="knowledge-relation-list">{relations.filter(item => item.edge.type !== "contradicts").map(item =>
            <li key={item.edge.edgeId}><span>{statusText(item.edge.type)} · {statusText(item.edge.state)}</span>
              <button onClick={() => openPage(item.otherId, item.otherRevision)}>{relationName(item.otherId, item.otherRevision)} →</button>
              <small>{item.direction}此页 · 固定版 {item.otherRevision} · 知识 ID {item.otherId} · 来源 {item.edge.sourceKeys.join("、") || "未登记"}</small></li>)}</ul>
          : <p className="muted">此版未登记其他关系。</p>}</section>
        <section><h3>历史版本</h3><div className="knowledge-history">{history.map(item => <button key={item.revision}
          className={visiblePage.revision === item.revision ? "selected" : ""} onClick={() => openPage(item.knowledgeId, item.revision)}>
          {item.revision.slice(0, 8)} · {statusText(item.validity)}</button>)}</div></section>
        {graph && readingCurrent && <details className="knowledge-graph"><summary>关系图（辅助导航）</summary>
          <Graph graph={graph} onOpen={openPage} /></details>}
      </aside>}
    </div>}

    <section className="knowledge-workspace" hidden={view !== "review"} aria-label="候选与审阅">
      <div className="knowledge-workspace-head"><button className="knowledge-back" onClick={showList}>← 返回知识列表</button><h2>候选与审阅</h2></div>
      <div className="knowledge-review-layout"><nav aria-label="知识候选">{candidates.length ? candidates.map(item => <button key={item.candidateId}
        className={selectedCandidateId === item.candidateId ? "selected" : ""} onClick={() => openCandidate(item.candidateId)}>
        <strong>{item.title}</strong><small>{statusText(item.status)}</small></button>) : <p className="empty">暂无候选。</p>}
        {candidateCursor && <button onClick={async () => { try { const next = await client.candidates(candidateCursor); setCandidates(previous => [...previous, ...next.items]); setCandidateCursor(next.nextCursor); } catch (cause) { setError(errorText(cause)); } }}>加载更多候选</button>}
      </nav><div>{candidate ? <article><h3>{candidate.title} · {statusText(candidate.status)}</h3>
        <p className="muted knowledge-candidate-meta">候选 {candidate.candidateId} · 固定基线 {candidate.expectedRevision ?? "新页"} · SHA-256 <code>{candidate.contentHash}</code></p>
        <div className="knowledge-candidate-preview"><MarkdownBody source={candidate.body}
          identity={`knowledge-candidate-${candidate.candidateId}-${candidate.candidateRevision}`} omitLeadingTitle={candidate.title} projectId={context.projectId} /></div>
        <details className="knowledge-candidate-source"><summary>核对 Markdown 原文</summary><pre>{candidate.body}</pre></details>
        <h4>固定来源</h4><ul>{candidate.sources.map(item => { const id = sourceId(item.sourceKey);
          return <li key={`${item.sourceKey}:${item.originRevision}`}>{id ? <a href={documentLink(context.projectId, id, item.originRevision,
            knowledgeHash(context.projectId, { candidateId: candidate.candidateId }))}>
            过程文档 · 修订 {item.originRevision.slice(0, 8)} →</a> : `${item.sourceKey} · ${item.originRevision.slice(0, 8)}`}
            {` · ${statusText(item.state)}`}</li>; })}</ul>
        <h4>拟议关系</h4>{candidate.relations.length ? <ul>{candidate.relations.map(item => <li key={item.edgeId}>
          {statusText(item.type)} · 目标固定版 {item.toRevision.slice(0, 8)} · 来源 {item.sourceKeys.join("、") || "未登记"}</li>)}</ul> : <p className="muted">未拟议页间关系。</p>}
        {candidate.decision && <p>审阅{candidate.decision.decision === "accept" ? "已接受" : "未采纳"} · {candidate.decision.reason} · {candidate.decision.reviewerId}。审阅不等于正文已发布。</p>}
        {candidate.status === "pending" && canReview && <div className="workflow-form"><label>审阅意见<textarea value={reviewReason} onChange={event => setReviewReason(event.target.value)} /></label>
          <div className="actions"><button disabled={busy || !reviewReason.trim()} onClick={() => review("accept")}>接受候选</button>
            <button disabled={busy || !reviewReason.trim()} onClick={() => review("reject")}>不采纳</button></div></div>}
        {candidate.status === "accepted" && canReview && <button className="primary" disabled={busy || visibleReceipts.length > 0}
          onClick={() => externalWrite("publish", candidate.candidateId)}>发布固定修订</button>}
      </article> : <p className="empty">选一条候选查看全文与审阅结果。</p>}</div></div>
    </section>

    <section className="knowledge-workspace knowledge-compose" hidden={view !== "compose"} data-dirty={composeTouched ? "true" : undefined} aria-label="提出知识候选">
      <button className="knowledge-back" onClick={() => setView(selectedId ? "read" : "list")}>← 返回{selectedId ? "阅读" : "知识列表"}</button>
      <div className="knowledge-workspace-head"><h2>{composeKnowledgeId ? "提出修订候选" : "提出知识候选"}</h2>
        <button onClick={resetDraft}>清空草稿</button></div>
      <p>来源只能选择本项目已采纳的固定文档修订；候选、审阅、发布各自独立。</p>
      {composeKnowledgeId && <p className="muted">固定编辑基线：<code>{editingRevision}</code>。当前版变化时不会自动替换草稿。</p>}
      {selectedSourceRevision && <p className="muted">所选来源修订：<code>{selectedSourceRevision}</code>。来源变化时须重新选择。</p>}
      {composeConflict && <Notice error>{composeConflict} <button onClick={() => composeKnowledgeId && openPage(composeKnowledgeId)}>阅读当前版</button></Notice>}
      <form className="workflow-form" onSubmit={propose}><label>标题<input required value={title} onChange={event => { setTitle(event.target.value); setComposeTouched(true); }} /></label>
        <label>页面类型<select value={pageType} onChange={event => { setPageType(event.target.value as typeof pageType); setComposeTouched(true); }}>
          <option value="topic">专题</option><option value="concept">概念</option><option value="analysis">分析</option><option value="decision">决定</option></select></label>
        <label>认识状态<select value={epistemic} onChange={event => { setEpistemic(event.target.value as typeof epistemic); setComposeTouched(true); }}>
          {(["observation", "inference", "hypothesis", "adopted", "disputed", "superseded"] as const).map(value => <option key={value} value={value}>{statusText(value)}</option>)}</select></label>
        <label>完整 Markdown 正文<textarea required value={body} onChange={event => { setBody(event.target.value); setComposeTouched(true); }} /></label>
        <label>已采纳的固定来源<select required value={selectedSource} onChange={event => { const id = event.target.value; setSelectedSource(id);
          setSelectedSourceRevision(sources.find(item => item.documentId === id)?.revisionId ?? ""); setComposeConflict(""); setComposeTouched(true); }}><option value="">请选择</option>
          {sources.filter(item => item.state === "reachable").map(item => <option key={item.documentId} value={item.documentId}>{item.title} · {item.revisionId.slice(0, 8)}</option>)}</select></label>
        <label>显式关系目标（可选）<select value={relationTarget} onChange={event => { const id = event.target.value; setRelationTarget(id);
          setRelationRevision(pages.find(item => item.knowledgeId === id)?.revision ?? ""); setComposeConflict(""); setComposeTouched(true); }}><option value="">无</option>
          {pages.map(item => <option key={item.knowledgeId} value={item.knowledgeId}>{item.title} · {item.revision.slice(0, 8)}</option>)}</select></label>
        {relationTarget && <label>关系类型<select value={relationType} onChange={event => { setRelationType(event.target.value as typeof relationType); setComposeTouched(true); }}>
          {(["supports", "contradicts", "related", "member_of", "supersedes"] as const).map(value => <option key={value} value={value}>{statusText(value)}</option>)}</select></label>}
        <button className="primary" disabled={!canWrite || busy || context.blocked || !!composeConflict}>保存候选</button></form>
      {canReview && <details className="knowledge-retract"><summary>撤回固定来源</summary><p>撤回会把引用及其内部依赖标为待复核，旧版仍可回读。</p>
        {sources.map(item => <p key={item.documentId}>{item.title} · {statusText(item.state)} <button disabled={busy || visibleReceipts.length > 0 || item.state !== "reachable"}
          onClick={() => externalWrite("retract", item.documentId)}>撤回此来源</button></p>)}</details>}
    </section>
  </div>;
}
