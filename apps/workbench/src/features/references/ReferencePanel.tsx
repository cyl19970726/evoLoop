// Git 与外部来源登记 (tasks.md 运行与关联; 仓库规范): registering a fixed Git file, recording how a formal document
// relates to a process document revision, and, on a task, adopting, keeping or replacing a fixed external source for
// the current task revision. Git originals stay in their repository and Wiki pages in the knowledge base; evoLoop keeps
// the fixed version, the source and the person's decision. Each write carries its own operation id, is recorded for
// recovery before it is sent (context.onAttempt) and rereads the project through context.onChanged when it applies.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { CommandResult } from "@evoloop/contracts";
import type { KnowledgeRevision, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import { Button, ErrorState, Field, Input, LoadingState, Notice, RefreshingIndicator, Select, Textarea } from "@evoloop/ui";
import { errorText, isUnconfirmed, request } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { knowledgeClient } from "../../shared/knowledgeClient";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { mutedText } from "../../shared/ui/PageParts";
import { date } from "../../shared/ui/shared";
import { FixedGitOriginalReader } from "./FixedGitOriginalReader";
import {
  commitPattern, epistemicLabel, formalDecisionLabel, hashPattern, referenceDecisionLabel, referenceLine, slotHeads, validityLabel,
} from "./referencePresentation";

const key = encodeURIComponent;
type FixedKnowledge = Pick<KnowledgeRevision, "knowledgeId" | "revision" | "title" | "contentHash" | "validity" | "observedValidity" | "epistemicStatus" | "sources">;
type Message = { text: string; problem: boolean } | null;
const wide = "w-full";

/** Every published page, for choosing one; more than 1000, or a repeated cursor, is reported instead of shown partly. */
async function allPublishedKnowledge(projectId: string): Promise<KnowledgeSummary[]> {
  const client = knowledgeClient("", projectId);
  const items: KnowledgeSummary[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.pages(cursor);
    items.push(...page.items);
    if (items.length > 1000 || (items.length === 1000 && page.nextCursor)) throw new Error("已发布知识超过 1000 项，当前选择列表无法完整展示。");
    if (!page.nextCursor) return items;
    if (seen.has(page.nextCursor)) throw new Error("知识分页游标重复，无法确认列表完整。");
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
}

/** A titled write, folded until it is needed; the person sees only the writes their permissions allow. */
function WriteBlock({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return <details className="group min-w-0 rounded-xl bg-raised px-4 py-3 shadow-sm">
    <summary className="cursor-pointer text-small font-medium text-foreground">{title}</summary>
    <div className="mt-3 flex flex-col gap-3">{description && <p className={mutedText}>{description}</p>}{children}</div>
  </details>;
}

export function ReferencePanel({ context, taskId, taskRevisionId, taskVersion }: {
  context: MutationContext; taskId?: string; taskRevisionId?: string; taskVersion?: number;
}) {
  const { projectId } = context;
  const root = `/api/projects/${key(projectId)}/references`;
  const permissions = context.principal.permissions;
  const canWrite = permissions.includes("write"), canReview = permissions.includes("review");
  const [repositoryId, setRepositoryId] = useState("");
  const [path, setPath] = useState("");
  const [commit, setCommit] = useState("");
  const [contentHash, setContentHash] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [openGitDecisionId, setOpenGitDecisionId] = useState<string | null>(null);
  const [referenceId, setReferenceId] = useState("");
  const [referenceRevision, setReferenceRevision] = useState("");
  const [referenceHash, setReferenceHash] = useState("");
  const [kind, setKind] = useState<"git" | "wiki" | "run">("git");
  const [wikiEntry, setWikiEntry] = useState<"published" | "manual" | "history">("published");
  const [knowledgeId, setKnowledgeId] = useState("");
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
  const history = useProjectQuery(projectId, ["references", "task", taskId, taskRevisionId], async signal => {
    const items = await request<TaskExternalReferenceRecord[]>("", `${root}/tasks/${key(taskId!)}`, 30000, { signal });
    if (!Array.isArray(items) || items.some(item => item.projectId !== projectId || item.taskId !== taskId)) throw new Error("来源登记记录与当前任务不符");
    return items;
  }, { enabled: !!taskId });
  useEffect(() => { setOpenGitDecisionId(null); }, [taskId, taskRevisionId]);
  const choosingPublished = !!taskId && kind === "wiki" && wikiEntry === "published";
  const published = useProjectQuery(projectId, ["references", "published-knowledge"], () => allPublishedKnowledge(projectId), { enabled: choosingPublished });
  const knowledge = useProjectQuery(projectId, ["references", "knowledge", knowledgeId], async () => {
    const page = await knowledgeClient("", projectId).page(knowledgeId);
    if (page.knowledgeId !== knowledgeId) throw new Error("知识响应与所选知识不符");
    const fixed: FixedKnowledge = { knowledgeId: page.knowledgeId, revision: page.revision, title: page.title, contentHash: page.contentHash,
      validity: page.validity, observedValidity: page.observedValidity, epistemicStatus: page.epistemicStatus, sources: page.sources };
    return fixed;
  }, { enabled: choosingPublished && !!knowledgeId });
  const fixedKnowledge = choosingPublished && knowledgeId && knowledge.data?.knowledgeId === knowledgeId ? knowledge.data : null;
  const knowledgeLoading = choosingPublished && (published.isFetching || (!!knowledgeId && knowledge.isFetching));
  const knowledgeError = choosingPublished ? published.error ? errorText(published.error) : knowledgeId && knowledge.error ? errorText(knowledge.error) : "" : "";
  // The chosen page's fixed version becomes the reference the decision names.
  useEffect(() => {
    if (!fixedKnowledge) return;
    setReferenceId(fixedKnowledge.knowledgeId); setReferenceRevision(fixedKnowledge.revision); setReferenceHash(fixedKnowledge.contentHash);
  }, [fixedKnowledge?.knowledgeId, fixedKnowledge?.revision, fixedKnowledge?.contentHash]); // eslint-disable-line react-hooks/exhaustive-deps
  const heads = slotHeads(history.data ?? []);
  const clearReference = () => { setReferenceId(""); setReferenceRevision(""); setReferenceHash(""); };
  function startNewSlot() {
    setSlotId(crypto.randomUUID()); setHeadVersion(0); setDecision("adopt");
    clearReference(); setKnowledgeId("");
    if (kind === "wiki" && wikiEntry === "history") setWikiEntry("published");
  }
  function reviewHead(item: TaskExternalReferenceRecord) {
    const head = heads.get(item.slotId);
    if (!head) return;
    setSlotId(head.slotId); setHeadVersion(head.version); setDecision("retain"); setKind(head.kind);
    setReferenceId(head.referenceId); setReferenceRevision(head.revision); setReferenceHash(head.contentHash);
    setKnowledgeId("");
    if (head.kind === "wiki") setWikiEntry("history");
    setMessage({ text: "已载入这一依据位置的最新固定依据和版本。保留原版选“保留同一依据”，改用新来源选“替换依据”。", problem: false });
    window.requestAnimationFrame(() => document.getElementById(`reference-adopt-${taskId}`)?.scrollIntoView({ block: "start" }));
  }
  const changeReference = (set: (value: string) => void) => (value: string) => { set(value); if (headVersion > 0) setDecision("replace"); };
  async function post(path: string, type: "reference.git" | "reference.formal" | "reference.task", payload: Record<string, unknown>) {
    const operationId = crypto.randomUUID();
    if (!await context.onAttempt({ type, projectId, operationId, ...(taskId ? { taskId } : {}) })) {
      setMessage({ text: "无法保存操作回执，尚未提交。", problem: true }); return;
    }
    setBusy(true); setMessage(null);
    try {
      const result = await request<CommandResult>(context.token, `${root}${path}`, 120000,
        { method: "POST", body: JSON.stringify({ ...payload, operationId }) });
      context.onKnown(operationId);
      setMessage(result.status === "applied" ? { text: "已保存，并已重新读取当前记录。", problem: false } : { text: result.message, problem: true });
      if (result.status === "applied") {
        if (type === "reference.git") {
          setFormalGitId(result.entityId); setKind("git"); setReferenceId(result.entityId);
          setReferenceRevision(commit); setReferenceHash(contentHash);
          if (headVersion > 0) setDecision("replace");
        }
        if (type === "reference.task") startNewSlot();
        context.onChanged();
      }
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(operationId);
      else setUnknown(true);
      setMessage({ text: `${errorText(cause)}${isUnconfirmed(cause) ? "。结果未确认：请在待核对操作里按原操作核对，不要直接重试。" : ""}`, problem: true });
    } finally { setBusy(false); }
  }
  const stopped = busy || unknown || context.blocked;
  function register(event: FormEvent) {
    event.preventDefault();
    if (stopped || !canWrite) return;
    if (!repositoryId.trim() || !path.trim() || !commitPattern.test(commit) || !hashPattern.test(contentHash)) {
      setMessage({ text: "请填写已登记仓库、相对路径、完整 commit 和原文 SHA-256。", problem: true }); return;
    }
    void post("/git", "reference.git", { referenceId: crypto.randomUUID(), repositoryId: repositoryId.trim(), path: path.trim(), commit, contentHash });
  }
  const knowledgeUnusable = kind === "wiki" && wikiEntry === "published" && (!fixedKnowledge || knowledgeLoading || !!knowledgeError ||
    fixedKnowledge.knowledgeId !== referenceId || fixedKnowledge.revision !== referenceRevision ||
    fixedKnowledge.contentHash !== referenceHash || fixedKnowledge.observedValidity !== "valid");
  function adopt(event: FormEvent) {
    event.preventDefault();
    if (!taskId || !taskRevisionId || !taskVersion || stopped || !canReview) return;
    if (!referenceId.trim() || !referenceRevision.trim() || !hashPattern.test(referenceHash) || !reason.trim() || !actionImpact.trim()) {
      setMessage({ text: "请提供固定来源、采用理由和它将改变的实际行动。", problem: true }); return;
    }
    if (knowledgeUnusable) { setMessage({ text: "请选择当前有效的已发布知识，并等固定版本读取完成。", problem: true }); return; }
    void post(`/tasks/${key(taskId)}/decisions`, "reference.task", {
      decisionId: crypto.randomUUID(), taskRevisionId, expectedTaskVersion: taskVersion, slotId,
      expectedHeadVersion: headVersion, decision, kind, referenceId: referenceId.trim(),
      revision: referenceRevision.trim(), contentHash: referenceHash, reason: reason.trim(), actionImpact: actionImpact.trim(),
    });
  }
  function recordFormal(event: FormEvent) {
    event.preventDefault();
    if (stopped || !canReview) return;
    if (!formalGitId.trim() || !processDocumentId.trim() || !processRevisionId.trim() || !formalReason.trim()) {
      setMessage({ text: "请填写固定 Git 引用、过程文档与修订，以及理由。", problem: true }); return;
    }
    void post("/formal-decisions", "reference.formal", { decisionId: crypto.randomUUID(),
      gitReferenceId: formalGitId.trim(), documentId: processDocumentId.trim(),
      documentRevisionId: processRevisionId.trim(), decision: formalDecision, reason: formalReason.trim() });
  }
  const submit = (label: string, disabled = false) => <Button type="submit" size="compact" variant="primary" className="w-fit" disabled={stopped || disabled}>{busy ? "保存中…" : label}</Button>;
  return <div className="flex min-w-0 flex-col gap-4" data-reference-panel="">
    <p className="text-label text-text-secondary">Git 原文留在已登记的仓库，知识页原文留在外部知识库；这里保存固定版本、来源和人的决定。</p>
    {message && <Notice tone={message.problem ? "error" : "info"}>{message.text}</Notice>}
    {unknown && <Notice tone="waiting" title="有一次登记结果未确认">核对清楚前，这里的登记暂停提交。</Notice>}
    {taskId && <section aria-label="已登记的依据" className="flex min-w-0 flex-col gap-2">
      <h3 className="text-small font-semibold text-foreground">已登记的依据{history.data ? ` · ${history.data.length} 项` : ""}</h3>
      {history.isPending && <LoadingState lines={2} label="正在读取已登记的依据" />}
      {history.error && !history.data && <ErrorState title="已登记的依据暂不可读取" happened={errorText(history.error)}
        next="可以重新读取；读取失败不代表这项任务没有登记依据。" action={<Button size="compact" onClick={() => void history.refetch()}>重新读取</Button>} />}
      {history.error && history.data && <Notice tone="waiting" title="上次读回，当前待核对">重新读取失败：{errorText(history.error)}。下面是上次读回的登记。</Notice>}
      {history.checking && !history.error && <RefreshingIndicator label="正在核对已登记的依据" />}
      {history.data?.length === 0 && <p className="text-label text-text-secondary">这一版任务还没有登记外部依据。</p>}
      {!!history.data?.length && <ul className="flex flex-col">{history.data.map(item => {
        const head = heads.get(item.slotId)?.id === item.id;
        return <li key={item.id} className="flex min-w-0 flex-col gap-1.5 border-t border-border py-3 first:border-t-0" data-reference-decision={item.id}>
          <p className="text-label font-medium text-foreground">{referenceLine(item)}{head ? "" : " · 已有更新的决定"}</p>
          <p className="text-label text-text-secondary [overflow-wrap:anywhere]">会改变的实际行动：{item.actionImpact}</p>
          <p className={mutedText}>{item.actorId} · {date(item.createdAt)} · 理由：{item.reason}</p>
          <div className="flex flex-wrap gap-2">
            {item.kind === "git" && <Button size="compact" variant="ghost" aria-expanded={openGitDecisionId === item.id}
              onClick={() => setOpenGitDecisionId(current => current === item.id ? null : item.id)}>{openGitDecisionId === item.id ? "收起固定 Git 原文" : "阅读固定 Git 原文"}</Button>}
            {head && canReview && <Button size="compact" variant="ghost" disabled={stopped} onClick={() => reviewHead(item)}>复核此依据</Button>}
          </div>
          {openGitDecisionId === item.id && <FixedGitOriginalReader key={`${item.id}:${context.principal.actorId}`} record={item} />}
          <FullIdentifiers rows={[{ label: "固定引用", value: item.referenceId }, { label: "固定版本", value: item.revision },
            { label: "SHA-256", value: item.contentHash }, { label: "依据位置", value: item.slotId }, { label: "任务修订", value: item.taskRevisionId }]} />
        </li>;
      })}</ul>}
    </section>}
    {canWrite ? <WriteBlock title="登记 Git 固定来源" description="服务端按完整 commit 读取原文并核对 SHA-256，一致才登记。">
      <form className="flex flex-col gap-3" onSubmit={register}>
        <Field label="仓库">{props => <Input {...props} value={repositoryId} onChange={event => setRepositoryId(event.target.value)} />}</Field>
        <Field label="相对路径">{props => <Input {...props} value={path} onChange={event => setPath(event.target.value)} />}</Field>
        <Field label="完整 commit" hint="40 或 64 位十六进制">{props => <Input {...props} value={commit} onChange={event => setCommit(event.target.value)} />}</Field>
        <Field label="原文 SHA-256" hint="64 位小写十六进制">{props => <Input {...props} value={contentHash} onChange={event => setContentHash(event.target.value)} />}</Field>
        {submit("核验并登记")}
      </form>
    </WriteBlock> : <p className={mutedText}>当前身份没有写入权限，不能登记 Git 固定来源。</p>}
    {canReview ? <WriteBlock title="记录正式文档与过程文档的关系"
      description="这是审核人的决定和理由。系统核验固定原文可以读取，但不会自动证明正式文档已包含过程成果；请在理由里指出具体段落或差异。">
      <form className="flex flex-col gap-3" onSubmit={recordFormal}>
        <Field label="固定 Git 引用" hint="登记 Git 固定来源后自动填入">{props => <Input {...props} value={formalGitId} onChange={event => setFormalGitId(event.target.value)} />}</Field>
        <Field label="过程文档">{props => <Input {...props} value={processDocumentId} onChange={event => setProcessDocumentId(event.target.value)} />}</Field>
        <Field label="过程文档修订">{props => <Input {...props} value={processRevisionId} onChange={event => setProcessRevisionId(event.target.value)} />}</Field>
        <Field label="决定">{props => <Select {...props} className={wide} value={formalDecision} onChange={event => setFormalDecision(event.target.value as typeof formalDecision)}>
          {Object.entries(formalDecisionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}</Field>
        <Field label="理由">{props => <Textarea {...props} value={formalReason} onChange={event => setFormalReason(event.target.value)} />}</Field>
        {submit("记录关系")}
      </form>
    </WriteBlock> : <p className={mutedText}>当前身份没有复核权限，不能记录正式文档关系或采用外部依据。</p>}
    {taskId && canReview && <div id={`reference-adopt-${taskId}`} className="scroll-mt-20"><WriteBlock title="为当前任务修订采用外部依据"
      description="采用后会生成新的任务修订，并冻结当前的过程文档与外部依据。">
      <form className="flex flex-col gap-3" onSubmit={adopt}>
        <p className="text-label text-text-secondary">{headVersion === 0 ? "正在采用一项新依据。" : `正在复核已有依据（这一依据位置的第 ${headVersion} 版）；更换来源会改为“替换”。`}</p>
        {headVersion > 0 && <Button type="button" size="compact" variant="ghost" className="w-fit" onClick={startNewSlot}>改为采用另一项新依据</Button>}
        <Field label="来源">{props => <Select {...props} className={wide} value={kind} onChange={event => {
          setKind(event.target.value as typeof kind); setKnowledgeId(""); clearReference(); if (headVersion > 0) setDecision("replace");
        }}><option value="git">Git 文件</option><option value="wiki">知识页</option><option value="run">受管运行</option></Select>}</Field>
        {kind === "wiki" && <>
          <Field label="知识来源方式">{props => <Select {...props} className={wide} value={wikiEntry} onChange={event => {
            setWikiEntry(event.target.value as typeof wikiEntry); setKnowledgeId(""); clearReference();
            if (headVersion > 0 && event.target.value !== "history") setDecision("replace");
          }}><option value="published">从已发布知识选择</option>{headVersion > 0 && <option value="history">这一依据位置当前的固定知识</option>}<option value="manual">高级：手工填写固定版本</option></Select>}</Field>
          {wikiEntry === "history" && <p className="text-label text-text-secondary">沿用这一依据位置当前的固定知识；版本与摘要见下方完整标识。</p>}
          {wikiEntry === "published" && <>
            <Field label="已发布知识">{props => <Select {...props} className={wide} value={knowledgeId} disabled={published.isFetching || !!published.error}
              onChange={event => { setKnowledgeId(event.target.value); clearReference(); if (headVersion > 0) setDecision("replace"); }}>
              <option value="">选择一篇已发布知识</option>
              {(published.data ?? []).map(item => <option key={item.knowledgeId} value={item.knowledgeId}>{item.title} · {validityLabel[item.validity] ?? "有效性未知"}</option>)}
            </Select>}</Field>
            {knowledgeLoading && <p className={mutedText} role="status">正在核对已发布知识与固定版本…</p>}
            {knowledgeError && <Notice tone="error">{knowledgeError}</Notice>}
            {published.data?.length === 0 && !published.error && <p className="text-label text-text-secondary">这个项目还没有可以选择的已发布知识。</p>}
            {fixedKnowledge && <div className="flex flex-col gap-1 rounded-lg bg-muted p-3 text-label">
              <p className="font-medium text-foreground">{fixedKnowledge.title}</p>
              <p className="text-text-secondary">创建时{validityLabel[fixedKnowledge.validity]} · 当前{validityLabel[fixedKnowledge.observedValidity]} · {epistemicLabel[fixedKnowledge.epistemicStatus] ?? "认识状态未知"}</p>
              <p className="text-text-secondary">固定来源：{fixedKnowledge.sources.length ? `${fixedKnowledge.sources.length} 项` : "这一版知识没有列出来源"}</p>
              {fixedKnowledge.observedValidity !== "valid" && <Notice tone="error">这篇知识需要复核或已撤回，不能直接采用。</Notice>}
              <FullIdentifiers rows={[{ label: "固定修订", value: fixedKnowledge.revision }, { label: "SHA-256", value: fixedKnowledge.contentHash },
                ...fixedKnowledge.sources.map(source => ({ label: "来源", value: `${source.sourceKey} @ ${source.originRevision}（${source.state}）`, text: true }))]} />
            </div>}
          </>}
        </>}
        {(kind === "git" || kind === "run" || kind === "wiki" && wikiEntry === "manual") && <details open={kind !== "wiki"} className="flex flex-col gap-3">
          <summary className="w-fit cursor-pointer text-label text-primary hover:underline">{kind === "git" ? "填写固定 Git 来源" : kind === "run" ? "填写已完成的受管运行" : "高级：填写知识页固定版本"}</summary>
          <div className="mt-3 flex flex-col gap-3">
            <Field label={kind === "run" ? "运行" : "固定引用"} hint={kind === "git" ? "登记 Git 固定来源后自动填入" : undefined}>{props => <Input {...props} value={referenceId} onChange={event => changeReference(setReferenceId)(event.target.value)} />}</Field>
            <Field label={kind === "run" ? "运行所用的固定任务修订" : "固定 commit 或知识修订"}>{props => <Input {...props} value={referenceRevision} onChange={event => changeReference(setReferenceRevision)(event.target.value)} />}</Field>
            <Field label={kind === "run" ? "运行输入的固定摘要" : "原文 SHA-256"} hint={kind === "run" ? "运行记录里的输入摘要（inputHash），不是过程记录的摘要" : undefined}>{props =>
              <Input {...props} value={referenceHash} onChange={event => changeReference(setReferenceHash)(event.target.value)} />}</Field>
          </div>
        </details>}
        <Field label="决定">{props => <Select {...props} className={wide} value={decision} onChange={event => setDecision(event.target.value as typeof decision)}>
          {headVersion === 0 ? <option value="adopt">{referenceDecisionLabel.adopt}新依据</option>
            : <><option value="retain">保留同一依据</option><option value="replace">替换依据</option></>}</Select>}</Field>
        <details>
          <summary className="w-fit cursor-pointer text-label text-primary hover:underline">高级：依据位置与并发版本</summary>
          <div className="mt-3 flex flex-col gap-3">
            <Field label="依据位置">{props => <Input {...props} value={slotId} onChange={event => setSlotId(event.target.value)} />}</Field>
            <Field label="已知的位置版本">{props => <Input {...props} type="number" min="0" value={headVersion} onChange={event => {
              const next = Number(event.target.value); setHeadVersion(next); setDecision(next === 0 ? "adopt" : "retain");
            }} />}</Field>
          </div>
        </details>
        <Field label="采用理由">{props => <Textarea {...props} value={reason} onChange={event => setReason(event.target.value)} />}</Field>
        <Field label="会改变的实际行动">{props => <Textarea {...props} value={actionImpact} onChange={event => setActionImpact(event.target.value)} />}</Field>
        <FullIdentifiers summary="将要登记的固定依据" rows={[{ label: "固定引用", value: referenceId }, { label: "固定版本", value: referenceRevision },
          { label: "SHA-256", value: referenceHash }]} />
        {submit("保存决定", knowledgeUnusable)}
      </form>
    </WriteBlock></div>}
  </div>;
}
