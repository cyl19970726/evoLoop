import { useEffect, useState, type FormEvent } from "react";
import type { KnowledgeCandidateRecord, KnowledgeCandidateSummary, KnowledgeCapabilities, KnowledgeGraph,
  KnowledgeRevision, KnowledgeSummary, PublishResult } from "@evoloop/contracts/knowledge";
import { errorText, isUnconfirmed } from "../api";
import { Notice, type MutationContext } from "../workflow/ActionForm";
import { knowledgeClient, type SourceDocument } from "./client";

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
const documentLink = (projectId: string, documentId: string, revision: string) =>
  `#/p/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}?revision=${encodeURIComponent(revision)}`;
const statusText = (status: string) => ({ valid: "有效", needs_review: "待复核", withdrawn: "已撤回", pending: "待审",
  accepted: "已接受", rejected: "未采纳", published: "已发布", truncated: "已截断", partial: "部分缺项",
  unavailable: "不可用", complete: "完整" } as Record<string, string>)[status] ?? status;

const graphNodeKey = (id: string, revision: string) => `${id}\0${revision}`;

function Graph({ graph, onOpen }: { graph: KnowledgeGraph; onOpen(id: string, revision: string): void }) {
  const positions = new Map(graph.nodes.map((node, index) => [graphNodeKey(node.knowledgeId, node.revision),
    index === 0 ? { x: 300, y: 150 } : { x: 300 + 205 * Math.cos(2 * Math.PI * (index - 1) / Math.max(1, graph.nodes.length - 1)),
      y: 150 + 110 * Math.sin(2 * Math.PI * (index - 1) / Math.max(1, graph.nodes.length - 1)) }]));
  return <div><p>关系图：{statusText(graph.status)} · 水位 {graph.watermark}。只显示已登记的固定关系。</p>
    <svg role="img" aria-label="固定知识关系图" viewBox="0 0 600 300" style={{ width: "100%", maxWidth: 700, background: "#f7faf9", borderRadius: 10 }}>
      {graph.edges.map(edge => { const a = positions.get(graphNodeKey(edge.fromKnowledgeId, edge.fromRevision)), b = positions.get(graphNodeKey(edge.toKnowledgeId, edge.toRevision));
        return a && b ? <g key={edge.edgeId}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke={edge.state === "active" ? "#4c8c83" : "#b97664"} strokeWidth="2" />
          <title>{edge.type} · {edge.state} · {edge.fromRevision} → {edge.toRevision}</title></g> : null; })}
      {graph.nodes.map(node => { const point = positions.get(graphNodeKey(node.knowledgeId, node.revision))!;
        return <g key={graphNodeKey(node.knowledgeId, node.revision)} onClick={() => onOpen(node.knowledgeId, node.revision)} style={{ cursor: "pointer" }}>
          <circle cx={point.x} cy={point.y} r="30" fill={node.validity === "valid" ? "#d7ece6" : "#f6ded6"} stroke="#547c75" />
          <text x={point.x} y={point.y + 4} textAnchor="middle" fontSize="11">{node.title.slice(0, 8)}</text>
          <title>{node.title} · {node.revision} · {statusText(node.validity)}</title>
        </g>; })}
    </svg>
    {graph.status !== "complete" && <Notice error>关系数据{statusText(graph.status)}，不能据此断言没有其他关联。</Notice>}
  </div>;
}

export function KnowledgePanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const client = knowledgeClient(context.token, context.projectId);
  const [pages, setPages] = useState<KnowledgeSummary[]>([]);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<KnowledgeCandidateSummary[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceDocument[]>([]);
  const [capabilities, setCapabilities] = useState<KnowledgeCapabilities | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fixedRevision, setFixedRevision] = useState<string | undefined>();
  const [page, setPage] = useState<KnowledgeRevision | null>(null);
  const [history, setHistory] = useState<KnowledgeSummary[]>([]);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<KnowledgeCandidateRecord | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pageType, setPageType] = useState<"topic" | "concept" | "analysis" | "decision">("concept");
  const [epistemic, setEpistemic] = useState<"observation" | "inference" | "hypothesis" | "adopted" | "disputed" | "superseded">("inference");
  const [selectedSource, setSelectedSource] = useState("");
  const [relationTarget, setRelationTarget] = useState("");
  const [relationType, setRelationType] = useState<"supports" | "contradicts" | "related" | "member_of" | "supersedes">("related");
  const [reviewReason, setReviewReason] = useState("");
  const [externalReceipts, setExternalReceipts] = useState(readReceipts);
  const [busy, setBusy] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);
  const canWrite = context.principal.permissions.includes("write");
  const canReview = context.principal.permissions.includes("review");
  useEffect(() => {
    let active = true;
    setError("");
    Promise.all([client.capabilities(), client.pages(), client.candidates(), client.sources()])
      .then(([caps, nextPages, nextCandidates, nextSources]) => { if (!active) return;
        setCapabilities(caps); setPages(nextPages.items); setPageCursor(nextPages.nextCursor);
        setCandidates(nextCandidates.items); setCandidateCursor(nextCandidates.nextCursor); setSources(nextSources.items); })
      .catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh, localRefresh]);
  useEffect(() => {
    if (!selectedId) { setPage(null); setHistory([]); setGraph(null); return; }
    let active = true; setPage(null); setError("");
    Promise.all([client.page(selectedId, fixedRevision), client.history(selectedId), client.graph(selectedId)])
      .then(([next, past, nearby]) => { if (active) { setPage(next); setHistory(past.items); setGraph(nearby); } })
      .catch(cause => { if (active) setError(errorText(cause)); });
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
    const target = pages.find(item => item.knowledgeId === relationTarget);
    if (relationTarget && !target) { setMessage("关系目标必须是已发布的固定知识页。"); return; }
    setBusy(true); setMessage("");
    const candidateId = crypto.randomUUID();
    try {
      const current = selectedId ? await client.page(selectedId) : null;
      const result = await client.propose({ operationId: crypto.randomUUID(), knowledgeId: selectedId ?? crypto.randomUUID(),
        candidateId, candidateRevision: crypto.randomUUID(), expectedRevision: current?.revision ?? null,
        title: title.trim(), body, pageType, epistemicStatus: epistemic,
        sources: [{ documentId: source.documentId, revisionId: source.revisionId, fragment: null }],
        relations: target ? [{ toKnowledgeId: target.knowledgeId, toRevision: target.revision,
          type: relationType, sourceKeys: [source.sourceKey] }] : [] });
      setSelectedCandidateId(result.candidateId); setMessage("候选已保存，仍需明确审阅后才能发布。"); refreshAll();
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
  return <div className="journey-board"><section className="panel"><div className="panel-head"><h2>知识空间</h2><button onClick={refreshAll}>回读当前状态</button></div>
    <p>正文、历史与内部关系保存在外部知识空间。页面只显示真实固定版和已登记关系。</p>
    {capabilities && <p className="muted">后端 {capabilities.backendVersion ?? "不可达"} · 语义索引未验证；普通内容写入不等于自动编纂。</p>}
    {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
    {visibleReceipts.map(item => <Notice key={item.operationId} error>外部{item.kind === "publish" ? "发布" : "撤回"}结果待核 · 操作 <code>{item.operationId}</code>
      <button disabled={busy} onClick={() => reconcile(item.operationId)}>按此 ID 对账</button></Notice>)}
    <div className="review-layout"><nav aria-label="知识页和候选"><h3>已发布知识</h3>
      <p><button onClick={() => { setSelectedId(null); setFixedRevision(undefined); setPage(null); }}>新建知识候选</button></p>
      {pages.length ? pages.map(item => <p key={item.knowledgeId}><button onClick={() => { setSelectedId(item.knowledgeId); setFixedRevision(undefined); }}>
        {item.title} · {statusText(item.validity)}</button></p>) : <p className="empty">暂无已发布知识。</p>}
      {pageCursor && <button onClick={async () => { try { const next = await client.pages(pageCursor); setPages(previous => [...previous, ...next.items]); setPageCursor(next.nextCursor); } catch (cause) { setError(errorText(cause)); } }}>加载更多知识</button>}
      <h3>候选与审阅</h3>{candidates.map(item => <p key={item.candidateId}><button onClick={() => setSelectedCandidateId(item.candidateId)}>
        {item.title} · {statusText(item.status)}</button></p>)}
      {candidateCursor && <button onClick={async () => { try { const next = await client.candidates(candidateCursor); setCandidates(previous => [...previous, ...next.items]); setCandidateCursor(next.nextCursor); } catch (cause) { setError(errorText(cause)); } }}>加载更多候选</button>}
    </nav><div>{page && <article><h3>{page.title} · {statusText(page.observedValidity)}</h3>
      <p className="muted">固定版 {page.revision} · {page.epistemicStatus} · SHA-256 {page.contentHash}</p>
      {page.validity !== page.observedValidity && <Notice error>此固定版创建时有效性为 {statusText(page.validity)}；目前标为 {statusText(page.observedValidity)}。</Notice>}
      <pre className="history-body">{page.body}</pre><h4>固定来源</h4><ul>{page.sources.map(source => { const id = sourceId(source.sourceKey);
        return <li key={`${source.sourceKey}:${source.originRevision}`}>{id ? <a href={documentLink(context.projectId, id, source.originRevision)}>
          文档 {id.slice(0, 8)} · 修订 {source.originRevision.slice(0, 8)}</a> : source.sourceKey}
          {` · ${source.state} · ${source.contentHash.slice(0, 12)}`}</li>; })}</ul>
      <h4>历史修订</h4>{history.map(item => <button key={item.revision} onClick={() => setFixedRevision(item.revision)}>
        {item.revision.slice(0, 8)} · {statusText(item.validity)}</button>)}
      {graph && <Graph graph={graph} onOpen={(id, revision) => { setSelectedId(id); setFixedRevision(revision); }} />}
    </article>}
    {candidate && <article><h3>候选：{candidate.title} · {statusText(candidate.status)}</h3>
      <p className="muted">候选 {candidate.candidateId} · 固定基线 {candidate.expectedRevision ?? "新页"} · {candidate.contentHash}</p>
      <pre className="history-body">{candidate.body}</pre>
      <p>来源：{candidate.sources.map(source => source.sourceKey).join("、")}</p>
      {candidate.decision && <p>审阅：{candidate.decision.decision === "accept" ? "接受" : "未采纳"} · {candidate.decision.reason} · {candidate.decision.reviewerId}</p>}
      {candidate.status === "pending" && canReview && <div className="workflow-form"><label>审阅意见<textarea value={reviewReason} onChange={event => setReviewReason(event.target.value)} /></label>
        <div className="actions"><button disabled={busy || !reviewReason.trim()} onClick={() => review("accept")}>接受候选</button>
          <button disabled={busy || !reviewReason.trim()} onClick={() => review("reject")}>不采纳</button></div></div>}
      {candidate.status === "accepted" && canReview && <button className="primary" disabled={busy || visibleReceipts.length > 0}
        onClick={() => externalWrite("publish", candidate.candidateId)}>发布固定修订</button>}
    </article>}</div></div>
  </section><section className="panel"><h2>提出候选</h2><p>来源只能选择本项目已采纳的固定文档修订；候选、审阅、发布各自独立。</p>
    <form className="workflow-form" onSubmit={propose}><label>标题<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>页面类型<select value={pageType} onChange={event => setPageType(event.target.value as typeof pageType)}>
        <option value="topic">专题</option><option value="concept">概念</option><option value="analysis">分析</option><option value="decision">决定</option></select></label>
      <label>认识状态<select value={epistemic} onChange={event => setEpistemic(event.target.value as typeof epistemic)}>
        {(["observation", "inference", "hypothesis", "adopted", "disputed", "superseded"] as const).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>完整 Markdown 正文<textarea required value={body} onChange={event => setBody(event.target.value)} /></label>
      <label>已采纳的固定来源<select required value={selectedSource} onChange={event => setSelectedSource(event.target.value)}><option value="">请选择</option>
        {sources.filter(item => item.state === "reachable").map(item => <option key={item.documentId} value={item.documentId}>{item.title} · {item.revisionId.slice(0, 8)}</option>)}</select></label>
      <label>显式关系目标（可选）<select value={relationTarget} onChange={event => setRelationTarget(event.target.value)}><option value="">无</option>
        {pages.map(item => <option key={item.knowledgeId} value={item.knowledgeId}>{item.title} · {item.revision.slice(0, 8)}</option>)}</select></label>
      {relationTarget && <label>关系类型<select value={relationType} onChange={event => setRelationType(event.target.value as typeof relationType)}>
        {(["supports", "contradicts", "related", "member_of", "supersedes"] as const).map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      <button className="primary" disabled={!canWrite || busy || context.blocked}>保存候选</button></form>
    {canReview && <details><summary>撤回固定来源</summary><p>撤回会把引用及其内部依赖标为待复核，旧版仍可回读。</p>
      {sources.map(item => <p key={item.documentId}>{item.title} · {statusText(item.state)} <button disabled={busy || visibleReceipts.length > 0 || item.state !== "reachable"}
        onClick={() => externalWrite("retract", item.documentId)}>撤回此来源</button></p>)}</details>}
  </section></div>;
}
