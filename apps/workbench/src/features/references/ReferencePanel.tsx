// Git 与外部来源登记 (tasks.md 运行与关联; 仓库规范): registering a fixed Git file, recording how a formal document
// relates to a process document revision, and, on a task, adopting, keeping or replacing a fixed external source for
// the current task revision. Git originals stay in their repository and Wiki pages in the knowledge base; evoLoop keeps
// the fixed version, the source and the person's decision. Each write is the shared command form (shared/command:
// useCommand with CommandFrame): the receipt is saved before sending, an unknown result is checked by its original
// operation ID, and the task decision sends the task version and revision recorded when the form opened. The writes go
// to the reference routes with the same fields as before (referenceCommands.ts).
import { useEffect, useState, type ReactNode } from "react";
import type { CommandResult } from "@evoloop/contracts";
import type { KnowledgeRevision, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import { Button, ErrorState, Field, Input, LoadingState, Notice, RefreshingIndicator, Select, Textarea } from "@evoloop/ui";
import { errorDetail, errorText, request } from "../../shared/api";
import { CommandFrame, useCommand, type CommandView, type MutationContext, type SubmittableCommand } from "../../shared/command";
import { knowledgeClient } from "../../shared/knowledgeClient";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { mutedText } from "../../shared/ui/PageParts";
import { date } from "../../shared/ui/shared";
import { FixedGitOriginalReader } from "./FixedGitOriginalReader";
import { checkReferenceCommand, formalDecisionCommand, gitReferenceCommand, referenceBody, referencePath, taskReferenceCommand } from "./referenceCommands";
import { epistemicLabel, formalDecisionLabel, referenceDecisionLabel, referenceLine, slotHeads, validityLabel } from "./referencePresentation";

type FixedKnowledge = Pick<KnowledgeRevision, "knowledgeId" | "revision" | "title" | "contentHash" | "validity" | "observedValidity" | "epistemicStatus" | "sources">;
type WriteName = "git" | "formal" | "adopt";
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

/** Sends a reference write to its own route with exactly the fields that route takes. */
const sendReference = (command: SubmittableCommand) =>
  request<CommandResult>("", referencePath(command), 120000, { method: "POST", body: JSON.stringify(referenceBody(command)) });

/**
 * One reference write on the shared command. A form nobody has typed into follows a moved baseline by itself; once the
 * person has typed, the frame asks them to keep their input or refill.
 */
function useReferenceCommand<B extends Record<string, string | number> | undefined>(context: MutationContext, baseline: B, dirty: boolean,
  content?: string) {
  const command = useCommand(context, baseline, { send: sendReference, validate: candidate => checkReferenceCommand(candidate, context.principal.actorId),
    onStale: context.onChanged, content });
  useEffect(() => {
    if (!dirty && command.baselineChanged && !command.awaitingReread) command.rebase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, command.baselineChanged, command.awaitingReread]);
  return command;
}

/**
 * The outcome a write shows: an applied write says only what is known, 已保存, plus what has been read back since
 * (`saved`); a refusal or an unknown result is shown as the command said it.
 */
function savedView(command: CommandView, saved: string): CommandView {
  const outcome = command.outcome;
  if (!outcome?.applied || outcome.message.startsWith("原操作")) return command;
  return { ...command, outcome: { ...outcome, message: saved } };
}

/** A titled write, folded until it is needed; “复核此依据” opens the decision form itself. */
function WriteBlock({ id, title, description, open, onToggle, children }: {
  id?: string; title: string; description?: ReactNode; open: boolean; onToggle(open: boolean): void; children: ReactNode;
}) {
  return <details id={id} open={open} onToggle={event => onToggle(event.currentTarget.open)} className="group min-w-0 scroll-mt-20 rounded-xl bg-raised px-4 py-3 shadow-sm">
    <summary className="cursor-pointer text-small font-medium text-foreground">{title}</summary>
    <div className="mt-3 flex flex-col gap-3">{description && <p className={mutedText}>{description}</p>}{children}</div>
  </details>;
}

export function ReferencePanel({ context, taskId, taskRevisionId, taskVersion }: {
  context: MutationContext; taskId?: string; taskRevisionId?: string; taskVersion?: number;
}) {
  const { projectId } = context;
  const permissions = context.principal.permissions;
  const canWrite = permissions.includes("write"), canReview = permissions.includes("review");
  const [opened, setOpened] = useState<Record<WriteName, boolean>>({ git: false, formal: false, adopt: false });
  const toggle = (name: WriteName) => (open: boolean) => setOpened(current => current[name] === open ? current : { ...current, [name]: open });
  // 登记 Git 固定来源
  const [repositoryId, setRepositoryId] = useState("");
  const [path, setPath] = useState("");
  const [commit, setCommit] = useState("");
  const [contentHash, setContentHash] = useState("");
  // 记录正式文档与过程文档的关系
  const [formalGitId, setFormalGitId] = useState("");
  const [processDocumentId, setProcessDocumentId] = useState("");
  const [processRevisionId, setProcessRevisionId] = useState("");
  const [formalDecision, setFormalDecision] = useState<"adopted" | "rejected" | "incorporated">("adopted");
  const [formalReason, setFormalReason] = useState("");
  // 为当前任务修订采用外部依据
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
  // “复核此依据” loaded a slot into the decision form: said beside that form until the person starts another one.
  const [reviewNote, setReviewNote] = useState(false);
  // When the last decision was applied: until the list is read again after it, the form says the reread is under way.
  const [adoptedAt, setAdoptedAt] = useState<number | null>(null);
  const history = useProjectQuery(projectId, ["references", "task", taskId, taskRevisionId], async signal => {
    const items = await request<TaskExternalReferenceRecord[]>("", `/api/projects/${encodeURIComponent(projectId)}/references/tasks/${encodeURIComponent(taskId!)}`, 30000, { signal });
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
  const knowledgeFailure = choosingPublished ? published.error ?? (knowledgeId ? knowledge.error : null) : null;
  // The chosen page's fixed version becomes the reference the decision names.
  useEffect(() => {
    if (!fixedKnowledge) return;
    setReferenceId(fixedKnowledge.knowledgeId); setReferenceRevision(fixedKnowledge.revision); setReferenceHash(fixedKnowledge.contentHash);
  }, [fixedKnowledge?.knowledgeId, fixedKnowledge?.revision, fixedKnowledge?.contentHash]); // eslint-disable-line react-hooks/exhaustive-deps
  const heads = slotHeads(history.data ?? []);

  const gitDirty = !!(repositoryId || path || commit || contentHash);
  const formalDirty = !!(processDocumentId || processRevisionId || formalReason);
  const adoptDirty = !!(reason || actionImpact || headVersion > 0 || knowledgeId || referenceId && kind !== "wiki");
  const gitCommand = useReferenceCommand(context, undefined, gitDirty);
  const formalCommand = useReferenceCommand(context, undefined, formalDirty);
  // The decision is sent against the task version and revision recorded when the form opened; the slot heads it was
  // reviewed against are what it shows besides them.
  const adoptCommand = useReferenceCommand(context, taskId ? { taskVersion: taskVersion ?? 0, revisionId: taskRevisionId ?? "" } : undefined, adoptDirty,
    JSON.stringify([...heads.values()].map(item => [item.slotId, item.version])));

  const clearReference = () => { setReferenceId(""); setReferenceRevision(""); setReferenceHash(""); };
  function startNewSlot() {
    setSlotId(crypto.randomUUID()); setHeadVersion(0); setDecision("adopt"); setReviewNote(false);
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
    setReviewNote(true); setAdoptedAt(null); adoptCommand.clear();
    setOpened(current => ({ ...current, adopt: true }));
    window.requestAnimationFrame(() => document.getElementById(`reference-adopt-${taskId}`)?.scrollIntoView({ block: "start" }));
  }
  const changeReference = (set: (value: string) => void) => (value: string) => { set(value); if (headVersion > 0) setDecision("replace"); };

  function register() {
    const values = { repositoryId, path, commit, contentHash };
    void gitCommand.submit(() => gitReferenceCommand(values, { referenceId: crypto.randomUUID(), taskId }), result => {
      // The registered source fills the two forms that name it.
      setFormalGitId(result.entityId); setKind("git"); setReferenceId(result.entityId);
      setReferenceRevision(values.commit); setReferenceHash(values.contentHash);
      if (headVersion > 0) setDecision("replace");
      setRepositoryId(""); setPath(""); setCommit(""); setContentHash("");
    });
  }
  function recordFormal() {
    const values = { gitReferenceId: formalGitId, documentId: processDocumentId, documentRevisionId: processRevisionId, decision: formalDecision, reason: formalReason };
    void formalCommand.submit(() => formalDecisionCommand(values, { decisionId: crypto.randomUUID(), taskId }), () => {
      setProcessDocumentId(""); setProcessRevisionId(""); setFormalReason(""); setFormalDecision("adopted");
    });
  }
  const knowledgeUnusable = kind === "wiki" && wikiEntry === "published" && (!fixedKnowledge || knowledgeLoading || !!knowledgeFailure ||
    fixedKnowledge.knowledgeId !== referenceId || fixedKnowledge.revision !== referenceRevision ||
    fixedKnowledge.contentHash !== referenceHash || fixedKnowledge.observedValidity !== "valid");
  function adopt() {
    if (!taskId) return;
    const values = { slotId, headVersion, decision, kind, referenceId, revision: referenceRevision, contentHash: referenceHash, reason, actionImpact };
    const unusable = knowledgeUnusable;
    void adoptCommand.submit(seen => {
      if (unusable) throw new Error("请选择当前有效的已发布知识，并等固定版本读取完成。");
      return taskReferenceCommand(values, seen as { taskVersion: number; revisionId: string }, { decisionId: crypto.randomUUID(), taskId });
    }, () => { startNewSlot(); setReason(""); setActionImpact(""); setAdoptedAt(Date.now()); });
  }
  const adoptSaved = adoptedAt === null || history.dataUpdatedAt <= adoptedAt
    ? history.error && adoptedAt !== null && history.errorUpdatedAt > adoptedAt ? "已保存。重新读取已登记的依据没有完成，见上方。" : "已保存，正在重新读取已登记的依据。"
    : "已保存，上面已是重新读取的登记。";
  // Keeping the input after the slot's head moved: the decision is about the head as it reads now.
  const keepAdopt = () => { const head = heads.get(slotId); if (headVersion > 0 && head) setHeadVersion(head.version); adoptCommand.rebase(); };

  return <div className="flex min-w-0 flex-col gap-4" data-reference-panel="">
    <p className="text-label text-text-secondary">Git 原文留在已登记的仓库，知识页原文留在外部知识库；这里保存固定版本、来源和人的决定。</p>
    {taskId && <section aria-label="已登记的依据" className="flex min-w-0 flex-col gap-2">
      <h3 className="text-small font-semibold text-foreground">已登记的依据{history.data ? ` · ${history.data.length} 项` : ""}</h3>
      {history.isPending && <LoadingState lines={2} label="正在读取已登记的依据" />}
      {history.error && !history.data && <ErrorState title="已登记的依据暂不可读取" happened={errorText(history.error)} diagnostics={errorDetail(history.error) ?? undefined}
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
            {head && canReview && <Button size="compact" variant="ghost" disabled={context.blocked || adoptCommand.busy || adoptCommand.unconfirmed}
              onClick={() => reviewHead(item)}>复核此依据</Button>}
          </div>
          {openGitDecisionId === item.id && <FixedGitOriginalReader key={`${item.id}:${context.principal.actorId}`} record={item} />}
          <FullIdentifiers rows={[{ label: "固定引用", value: item.referenceId }, { label: "固定版本", value: item.revision },
            { label: "SHA-256", value: item.contentHash }, { label: "依据位置", value: item.slotId }, { label: "任务修订", value: item.taskRevisionId }]} />
        </li>;
      })}</ul>}
    </section>}
    {canWrite ? <WriteBlock title="登记 Git 固定来源" description="服务端按完整 commit 读取原文并核对 SHA-256，一致才登记。" open={opened.git} onToggle={toggle("git")}>
      <CommandFrame context={context} command={savedView(gitCommand, taskId && canReview ? "已保存。登记的固定引用已填入下面两张表单。"
        : canReview ? "已保存。登记的固定引用已填入下面的表单。" : "已保存。")}
        label="登记 Git 固定来源" submitLabel="核验并登记" dirty={gitDirty} onSubmit={register} surface="plain"
        onKeep={() => gitCommand.rebase()} onRefill={() => { gitCommand.rebase(); setRepositoryId(""); setPath(""); setCommit(""); setContentHash(""); }}>
        <Field label="仓库">{props => <Input {...props} value={repositoryId} autoComplete="off" onChange={event => setRepositoryId(event.target.value)} />}</Field>
        <Field label="相对路径">{props => <Input {...props} value={path} autoComplete="off" onChange={event => setPath(event.target.value)} />}</Field>
        <Field label="完整 commit" hint="40 或 64 位十六进制">{props => <Input {...props} value={commit} autoComplete="off" onChange={event => setCommit(event.target.value)} />}</Field>
        <Field label="原文 SHA-256" hint="64 位小写十六进制">{props => <Input {...props} value={contentHash} autoComplete="off" onChange={event => setContentHash(event.target.value)} />}</Field>
      </CommandFrame>
    </WriteBlock> : <p className={mutedText}>当前身份没有写入权限，不能登记 Git 固定来源。</p>}
    {canReview ? <WriteBlock title="记录正式文档与过程文档的关系" open={opened.formal} onToggle={toggle("formal")}
      description="这是审核人的决定和理由。系统核验固定原文可以读取，但不会自动证明正式文档已包含过程成果；请在理由里指出具体段落或差异。">
      <CommandFrame context={context} command={savedView(formalCommand, "已保存。")} label="记录正式文档与过程文档的关系" submitLabel="记录关系"
        dirty={formalDirty} onSubmit={recordFormal} surface="plain" permission="review" onKeep={() => formalCommand.rebase()}
        onRefill={() => { formalCommand.rebase(); setProcessDocumentId(""); setProcessRevisionId(""); setFormalReason(""); setFormalDecision("adopted"); }}>
        <Field label="固定 Git 引用" hint="登记 Git 固定来源后自动填入">{props => <Input {...props} value={formalGitId} autoComplete="off" onChange={event => setFormalGitId(event.target.value)} />}</Field>
        <Field label="过程文档">{props => <Input {...props} value={processDocumentId} autoComplete="off" onChange={event => setProcessDocumentId(event.target.value)} />}</Field>
        <Field label="过程文档修订">{props => <Input {...props} value={processRevisionId} autoComplete="off" onChange={event => setProcessRevisionId(event.target.value)} />}</Field>
        <Field label="决定">{props => <Select {...props} className={wide} value={formalDecision} onChange={event => setFormalDecision(event.target.value as typeof formalDecision)}>
          {Object.entries(formalDecisionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}</Field>
        <Field label="理由">{props => <Textarea {...props} value={formalReason} onChange={event => setFormalReason(event.target.value)} />}</Field>
      </CommandFrame>
    </WriteBlock> : <p className={mutedText}>当前身份没有复核权限，不能记录正式文档关系或采用外部依据。</p>}
    {taskId && canReview && <WriteBlock id={`reference-adopt-${taskId}`} title="为当前任务修订采用外部依据" open={opened.adopt} onToggle={toggle("adopt")}
      description="采用后会生成新的任务修订，并冻结当前的过程文档与外部依据。">
      <CommandFrame context={context} command={savedView(adoptCommand, adoptSaved)} label="为当前任务修订采用外部依据" submitLabel="保存决定"
        dirty={adoptDirty} onSubmit={adopt} surface="plain" permission="review"
        paused={!knowledgeUnusable ? null : knowledgeLoading ? "正在核对已发布知识与固定版本…" : "选好一篇当前有效的已发布知识、等它的固定版本读回后，才能保存。"}
        onKeep={keepAdopt} keepNote="保留我的修改：输入不变；正在复核的依据位置按上方读回的最新版本复核。先看读回的登记，确认这份决定仍然适用，再保存。"
        onRefill={() => { adoptCommand.rebase(); startNewSlot(); setReason(""); setActionImpact(""); }}>
        {reviewNote && <Notice tone="info" title="已载入要复核的依据">这一依据位置的最新固定依据和版本已填入下面。保留原版选“保留同一依据”，改用新来源选“替换依据”。</Notice>}
        <p className="text-label text-text-secondary">{headVersion === 0 ? "正在采用一项新依据。" : `正在复核已有依据（这一依据位置的第 ${headVersion} 版）；更换来源会改为“替换”。`}</p>
        {headVersion > 0 && <Button size="compact" variant="ghost" className="w-fit" onClick={startNewSlot}>改为采用另一项新依据</Button>}
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
            {knowledgeFailure && <Notice tone="error">{errorText(knowledgeFailure)}</Notice>}
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
            <Field label={kind === "run" ? "运行" : "固定引用"} hint={kind === "git" ? "登记 Git 固定来源后自动填入" : undefined}>{props => <Input {...props} value={referenceId} autoComplete="off" onChange={event => changeReference(setReferenceId)(event.target.value)} />}</Field>
            <Field label={kind === "run" ? "运行所用的固定任务修订" : "固定 commit 或知识修订"}>{props => <Input {...props} value={referenceRevision} autoComplete="off" onChange={event => changeReference(setReferenceRevision)(event.target.value)} />}</Field>
            <Field label={kind === "run" ? "运行输入的固定摘要" : "原文 SHA-256"} hint={kind === "run" ? "运行记录里的输入摘要（运行的完整标识里“输入 SHA-256”一项），不是过程记录的摘要" : undefined}>{props =>
              <Input {...props} value={referenceHash} autoComplete="off" onChange={event => changeReference(setReferenceHash)(event.target.value)} />}</Field>
          </div>
        </details>}
        <Field label="决定">{props => <Select {...props} className={wide} value={decision} onChange={event => setDecision(event.target.value as typeof decision)}>
          {headVersion === 0 ? <option value="adopt">{referenceDecisionLabel.adopt}新依据</option>
            : <><option value="retain">保留同一依据</option><option value="replace">替换依据</option></>}</Select>}</Field>
        <details>
          <summary className="w-fit cursor-pointer text-label text-primary hover:underline">高级：依据位置与并发版本</summary>
          <div className="mt-3 flex flex-col gap-3">
            <Field label="依据位置">{props => <Input {...props} value={slotId} autoComplete="off" onChange={event => setSlotId(event.target.value)} />}</Field>
            <Field label="已知的位置版本">{props => <Input {...props} type="number" min="0" value={headVersion} onChange={event => {
              const next = Number(event.target.value); setHeadVersion(next); setDecision(next === 0 ? "adopt" : "retain");
            }} />}</Field>
          </div>
        </details>
        <Field label="采用理由">{props => <Textarea {...props} value={reason} onChange={event => setReason(event.target.value)} />}</Field>
        <Field label="会改变的实际行动">{props => <Textarea {...props} value={actionImpact} onChange={event => setActionImpact(event.target.value)} />}</Field>
        <FullIdentifiers summary="将要登记的固定依据" rows={[{ label: "固定引用", value: referenceId }, { label: "固定版本", value: referenceRevision },
          { label: "SHA-256", value: referenceHash }]} />
      </CommandFrame>
    </WriteBlock>}
  </div>;
}
