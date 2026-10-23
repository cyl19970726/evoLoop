import { useEffect, useState, type FormEvent } from "react";
import type { CommandResult } from "@evoloop/contracts";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import type { KnowledgeRevision, KnowledgeSummary, KnowledgeSourceRef } from "@evoloop/contracts/knowledge";
import { errorText, isUnconfirmed, request } from "../api";
import { knowledgeClient } from "../knowledge/client";
import { Notice, type MutationContext } from "../workflow/ActionForm";
import { FixedGitOriginalReader } from "./FixedGitOriginalReader";

const key = encodeURIComponent;
const hashPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
type FixedKnowledge = Pick<KnowledgeRevision, "knowledgeId" | "revision" | "title" | "contentHash" | "validity" | "observedValidity" | "epistemicStatus" | "sources">;
export function ReferencePanel({ context, taskId, taskRevisionId, taskVersion }: {
  context: MutationContext; taskId?: string; taskRevisionId?: string; taskVersion?: number;
}) {
  const root = `/api/projects/${key(context.projectId)}/references`;
  const [repositoryId, setRepositoryId] = useState("");
  const [path, setPath] = useState("");
  const [commit, setCommit] = useState("");
  const [contentHash, setContentHash] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [history, setHistory] = useState<TaskExternalReferenceRecord[]>([]);
  const [openGitDecisionId, setOpenGitDecisionId] = useState<string | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [referenceId, setReferenceId] = useState("");
  const [referenceRevision, setReferenceRevision] = useState("");
  const [referenceHash, setReferenceHash] = useState("");
  const [kind, setKind] = useState<"git" | "wiki">("git");
  const [wikiEntry, setWikiEntry] = useState<"published" | "manual" | "history">("published");
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeSummary[]>([]);
  const [knowledgeId, setKnowledgeId] = useState("");
  const [fixedKnowledge, setFixedKnowledge] = useState<FixedKnowledge | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState("");
  const [slotId, setSlotId] = useState<string>(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [actionImpact, setActionImpact] = useState("");
  const [decision, setDecision] = useState<"adopt" | "retain" | "replace">("adopt");
  const [headVersion, setHeadVersion] = useState(0);
  const [formalGitId, setFormalGitId] = useState("");
  const [processDocumentId, setProcessDocumentId] = useState("");
  const [processRevisionId, setProcessRevisionId] = useState("");
  const [formalDecision, setFormalDecision] = useState<"adopted" | "rejected" | "incorporated">("adopted");
  const [formalReason, setFormalReason] = useState("");
  const heads = new Map<string,TaskExternalReferenceRecord>();
  for (const item of history) if ((heads.get(item.slotId)?.version ?? 0) < item.version) heads.set(item.slotId,item);
  function startNewSlot() {
    setSlotId(crypto.randomUUID()); setHeadVersion(0); setDecision("adopt");
    setReferenceId(""); setReferenceRevision(""); setReferenceHash(""); setKnowledgeId(""); setFixedKnowledge(null);
    if (kind === "wiki" && wikiEntry === "history") setWikiEntry("published");
  }
  function reviewHead(item: TaskExternalReferenceRecord) {
    const head = heads.get(item.slotId);
    if (!head) return;
    setSlotId(head.slotId); setHeadVersion(head.version); setDecision("retain"); setKind(head.kind);
    setReferenceId(head.referenceId); setReferenceRevision(head.revision); setReferenceHash(head.contentHash);
    setKnowledgeId(""); setFixedKnowledge(null);
    if (head.kind === "wiki") setWikiEntry("history");
    setMessage("已载入该槽位的最新固定依据和版本；保留原版请选择「保留」，改用新来源请选择「替换」。");
  }
  useEffect(() => {
    setHistory([]); setOpenGitDecisionId(null);
    if (!taskId) return;
    let active = true;
    void request<TaskExternalReferenceRecord[]>(context.token, `${root}/tasks/${key(taskId)}`, 30000)
      .then(items => { if (active) setHistory(items); })
      .catch(cause => { if (active) setMessage(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, root, taskId, taskRevisionId, historyTick]);
  useEffect(() => {
    if (kind !== "wiki" || wikiEntry !== "published") return;
    let active = true; setKnowledgeLoading(true); setKnowledgeError(""); setKnowledgeItems([]);
    const client = knowledgeClient(context.token, context.projectId);
    void (async () => {
      const items: KnowledgeSummary[] = [], seen = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const page = await client.pages(cursor);
        items.push(...page.items);
        if (items.length > 1000 || (items.length === 1000 && page.nextCursor)) throw new Error("已发布知识超过 1000 项，当前选择列表无法完整展示。");
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error("知识分页游标重复，无法确认列表完整。");
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      if (active) setKnowledgeItems(items);
    })().catch(cause => { if (active) setKnowledgeError(errorText(cause)); })
      .finally(() => { if (active) setKnowledgeLoading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, kind, wikiEntry, historyTick]);
  useEffect(() => {
    if (kind !== "wiki" || wikiEntry !== "published" || !knowledgeId) { setFixedKnowledge(null); return; }
    let active = true; setKnowledgeLoading(true); setKnowledgeError(""); setFixedKnowledge(null);
    void knowledgeClient(context.token, context.projectId).page(knowledgeId)
      .then(page => { if (!active) return;
        const fixed: FixedKnowledge = { knowledgeId: page.knowledgeId, revision: page.revision, title: page.title,
          contentHash: page.contentHash, validity: page.validity, observedValidity: page.observedValidity,
          epistemicStatus: page.epistemicStatus, sources: page.sources };
        setFixedKnowledge(fixed); setReferenceId(fixed.knowledgeId); setReferenceRevision(fixed.revision); setReferenceHash(fixed.contentHash);
      }).catch(cause => { if (active) setKnowledgeError(errorText(cause)); })
      .finally(() => { if (active) setKnowledgeLoading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, kind, wikiEntry, knowledgeId, historyTick]);
  async function post(path: string, type: "reference.git" | "reference.formal" | "reference.task", payload: Record<string, unknown>) {
    const operationId = crypto.randomUUID();
    if (!context.onAttempt({ type, projectId: context.projectId, operationId, ...(taskId ? { taskId } : {}) })) {
      setMessage("无法保存操作回执，尚未提交。"); return;
    }
    setBusy(true); setMessage("");
    try {
      const result = await request<CommandResult>(context.token, `${root}${path}`, 120000,
        { method: "POST", body: JSON.stringify({ ...payload, operationId }) });
      context.onKnown(operationId);
      setMessage(result.status === "applied" ? `已保存：${result.entityId}（操作 ${operationId}）。` : result.message);
      if (result.status === "applied") {
        if (type === "reference.git") {
          setFormalGitId(result.entityId); setKind("git"); setReferenceId(result.entityId);
          setReferenceRevision(commit); setReferenceHash(contentHash);
          if (headVersion > 0) setDecision("replace");
        }
        if (type === "reference.task") { setHistoryTick(value => value + 1); startNewSlot(); }
        context.onChanged();
      }
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(operationId);
      else setUnknown(true);
      setMessage(`${errorText(cause)}${isUnconfirmed(cause) ? "；请用原操作 ID 核对，不要直接重试。" : ""}`);
    } finally { setBusy(false); }
  }
  function register(event: FormEvent) {
    event.preventDefault();
    if (busy || unknown || context.blocked || !context.principal.permissions.includes("write")) return;
    if (!repositoryId.trim() || !path.trim() || !commitPattern.test(commit) || !hashPattern.test(contentHash)) {
      setMessage("请填写已登记仓库、相对路径、完整 commit 和原文 SHA256。"); return;
    }
    const id = crypto.randomUUID();
    void post("/git", "reference.git", { referenceId: id, repositoryId: repositoryId.trim(), path: path.trim(),
      commit, contentHash });
  }
  function adopt(event: FormEvent) {
    event.preventDefault();
    if (!taskId || !taskRevisionId || !taskVersion || busy || unknown || context.blocked ||
        !context.principal.permissions.includes("review")) return;
    if (!referenceId.trim() || !referenceRevision.trim() || !hashPattern.test(referenceHash) || !reason.trim() || !actionImpact.trim()) {
      setMessage("请提供固定来源、采用理由和它将改变的实际行动。"); return;
    }
    if (kind === "wiki" && wikiEntry === "published" && (!fixedKnowledge || knowledgeLoading || knowledgeError ||
      fixedKnowledge.knowledgeId !== referenceId || fixedKnowledge.revision !== referenceRevision ||
      fixedKnowledge.contentHash !== referenceHash || fixedKnowledge.observedValidity !== "valid")) {
      setMessage("请选择当前有效的已发布知识，并等待固定版本读取完成。"); return;
    }
    void post(`/tasks/${key(taskId)}/decisions`, "reference.task", {
      decisionId: crypto.randomUUID(), taskRevisionId, expectedTaskVersion: taskVersion, slotId,
      expectedHeadVersion: headVersion, decision, kind, referenceId: referenceId.trim(),
      revision: referenceRevision.trim(), contentHash: referenceHash, reason: reason.trim(), actionImpact: actionImpact.trim(),
    });
  }
  function recordFormal(event: FormEvent) {
    event.preventDefault();
    if (busy || unknown || context.blocked || !context.principal.permissions.includes("review")) return;
    if (!formalGitId.trim() || !processDocumentId.trim() || !processRevisionId.trim() || !formalReason.trim()) {
      setMessage("请填写固定 Git 引用、过程文档修订与理由。"); return;
    }
    void post("/formal-decisions", "reference.formal", { decisionId: crypto.randomUUID(),
      gitReferenceId: formalGitId.trim(), documentId: processDocumentId.trim(),
      documentRevisionId: processRevisionId.trim(), decision: formalDecision, reason: formalReason.trim() });
  }
  return <section className="panel">
    <h2>固定来源与正式采用</h2>
    <p>Git 原文留在已登记仓库；Wiki 原文留在外部知识库。这里保存固定版本、来源与人工决定。</p>
    <form className="workflow-form reference-form" onSubmit={register}>
      <h3>登记 Git 固定来源</h3>
      <label>仓库 ID<input value={repositoryId} onChange={e => setRepositoryId(e.target.value)} /></label>
      <label>相对路径<input value={path} onChange={e => setPath(e.target.value)} /></label>
      <label>完整 commit<input value={commit} onChange={e => setCommit(e.target.value)} /></label>
      <label>原文 SHA256<input value={contentHash} onChange={e => setContentHash(e.target.value)} /></label>
      <button disabled={busy || unknown || context.blocked}>核验并登记</button>
    </form>
    <form className="workflow-form reference-form" onSubmit={recordFormal}>
      <h3>记录正式文档与过程文档的关系</h3>
      <p>这是审核者的决定及理由，系统核验固定原文可读取，但不会自动证明正式文档已包含过程成果；请在理由中指出具体段落或差异。</p>
      <label>固定 Git 引用 ID<input value={formalGitId} onChange={e => setFormalGitId(e.target.value)} /></label>
      <label>过程文档 ID<input value={processDocumentId} onChange={e => setProcessDocumentId(e.target.value)} /></label>
      <label>过程修订 ID<input value={processRevisionId} onChange={e => setProcessRevisionId(e.target.value)} /></label>
      <label>决定<select value={formalDecision} onChange={e => setFormalDecision(e.target.value as typeof formalDecision)}><option value="adopted">人工认定为正式依据</option><option value="rejected">人工拒绝纳入</option><option value="incorporated">人工确认已纳入该过程修订</option></select></label>
      <label>理由<textarea value={formalReason} onChange={e => setFormalReason(e.target.value)} /></label>
      <button disabled={busy || unknown || context.blocked}>记录关系</button>
    </form>
    {taskId && <form className="workflow-form reference-form" onSubmit={adopt}>
      <h3>为当前任务修订采用外部依据</h3>
      <p>采用后会生成新的任务修订，并冻结当前的过程文档与外部依据。</p>
      <p>{headVersion === 0 ? "正在采用一项新依据（新槽位）。" : `正在复核已有依据槽位 v${headVersion}；更换来源将改为「替换」。`}</p>
      {headVersion > 0 && <button type="button" onClick={startNewSlot}>改为采用另一项新依据</button>}
      <label>来源<select value={kind} onChange={e => { setKind(e.target.value as "git" | "wiki"); setKnowledgeId(""); setFixedKnowledge(null); setReferenceId(""); setReferenceRevision(""); setReferenceHash(""); if (headVersion > 0) setDecision("replace"); }}><option value="git">Git</option><option value="wiki">Wiki</option></select></label>
      {kind === "wiki" && <>
        <label>知识来源方式<select value={wikiEntry} onChange={e => { setWikiEntry(e.target.value as typeof wikiEntry); setKnowledgeId(""); setFixedKnowledge(null); setReferenceId(""); setReferenceRevision(""); setReferenceHash(""); if (headVersion > 0 && e.target.value !== "history") setDecision("replace"); }}><option value="published">从已发布知识选择</option>{headVersion > 0 && <option value="history">当前槽位的固定依据</option>}<option value="manual">高级：手工输入固定版本</option></select></label>
        {wikiEntry === "history" && <p className="break-anywhere">当前槽位固定知识：{referenceId} @ {referenceRevision} · SHA-256 {referenceHash}</p>}
        {wikiEntry === "published" && <>
          <label>已发布知识<select value={knowledgeId} disabled={knowledgeLoading || !!knowledgeError} onChange={e => { setKnowledgeId(e.target.value); setFixedKnowledge(null); setReferenceId(""); setReferenceRevision(""); setReferenceHash(""); if (headVersion > 0) setDecision("replace"); }}>
            <option value="">选择一篇已发布知识</option>{knowledgeItems.map(item => <option key={item.knowledgeId} value={item.knowledgeId}>{item.title} · {item.validity} · {item.revision.slice(0, 8)}</option>)}
          </select></label>
          {knowledgeLoading && <p>正在核对已发布知识与固定版本…</p>}
          {knowledgeError && <Notice error>{knowledgeError}</Notice>}
          {!knowledgeLoading && !knowledgeError && knowledgeItems.length === 0 && <p>当前项目没有可选择的已发布知识。</p>}
          {fixedKnowledge && <div className="decision"><strong>{fixedKnowledge.title}</strong>
            <p>固定修订 {fixedKnowledge.revision} · SHA-256 {fixedKnowledge.contentHash}</p>
            <p>创建时有效性 {fixedKnowledge.validity} · 当前有效性 {fixedKnowledge.observedValidity} · 认识状态 {fixedKnowledge.epistemicStatus}</p>
            <p>固定来源：{fixedKnowledge.sources.length ? fixedKnowledge.sources.map((source: KnowledgeSourceRef) => `${source.sourceKey} @ ${source.originRevision}（${source.state}）`).join("；") : "此知识修订未列出来源"}</p>
            {fixedKnowledge.observedValidity !== "valid" && <Notice error>当前知识需要复核或已撤回，不能直接采用。</Notice>}
          </div>}
        </>}
      </>}
      {(kind === "git" || wikiEntry === "manual") && <details className="workflow-detail" open={kind === "git"}><summary>{kind === "git" ? "填写固定 Git 来源" : "高级：填写 Wiki 固定版本"}</summary>
        <label>固定引用 ID<input value={referenceId} onChange={e => { setReferenceId(e.target.value); if (headVersion > 0) setDecision("replace"); }} /></label>
        <label>固定 commit / Wiki 修订<input value={referenceRevision} onChange={e => { setReferenceRevision(e.target.value); if (headVersion > 0) setDecision("replace"); }} /></label>
        <label>原文 SHA256<input value={referenceHash} onChange={e => { setReferenceHash(e.target.value); if (headVersion > 0) setDecision("replace"); }} /></label>
      </details>}
      <label>决定<select value={decision} onChange={e => setDecision(e.target.value as typeof decision)}>{headVersion === 0 ? <option value="adopt">采用新依据</option> : <><option value="retain">保留同一依据</option><option value="replace">替换依据</option></>}</select></label>
      <details className="workflow-detail"><summary>高级：槽位与并发版本</summary><label>依据槽位 ID<input value={slotId} onChange={e => setSlotId(e.target.value)} /></label>
        <label>已知槽位版本<input type="number" min="0" value={headVersion} onChange={e => { const next = Number(e.target.value); setHeadVersion(next); setDecision(next === 0 ? "adopt" : "retain"); }} /></label></details>
      <label>采用理由<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label>会改变的实际行动<textarea value={actionImpact} onChange={e => setActionImpact(e.target.value)} /></label>
      <button disabled={busy || unknown || context.blocked || (kind === "wiki" && wikiEntry === "published" && (!fixedKnowledge || knowledgeLoading || !!knowledgeError || fixedKnowledge.observedValidity !== "valid"))}>保存决定</button>
    </form>}
    {message && <Notice error={/失败|不可|错误|冲突|缺少|无法/.test(message)}>{message}</Notice>}
    {history.length > 0 && <div><h3>已记录的采用历史</h3><ul>{history.map(item =>
      <li key={item.id} className="reference-history-item">{item.decision} · {item.kind} · {item.referenceId} @ {item.revision} · {item.actionImpact}
        {item.kind === "git" && <><button type="button" aria-expanded={openGitDecisionId === item.id}
          onClick={() => setOpenGitDecisionId(current => current === item.id ? null : item.id)}>
          {openGitDecisionId === item.id ? "收起固定 Git 原文" : "阅读固定 Git 原文"}
        </button>{openGitDecisionId === item.id && <FixedGitOriginalReader key={`${item.id}:${context.principal.actorId}`} token={context.token} record={item} />}</>}
        {heads.get(item.slotId)?.id === item.id && <button type="button" disabled={busy || unknown || context.blocked || !context.principal.permissions.includes("review")} onClick={() => reviewHead(item)}>复核此依据（槽位 v{item.version}）</button>}
      </li>)}</ul></div>}
  </section>;
}
