// The four discussion writes: prepare a package, record an observed handoff, record (or correct) a decision, and
// link an existing follow-up object. Each is the shared command form (shared/command: useCommand with CommandFrame)
// with its own field layout and the baseline it fixes (discussionBaseline.ts). The form records the baseline when it
// opens; while the reader has typed, a part that moves (or a version conflict, which rereads first) stops sending until
// the reader keeps their input or refills; a recovery confirmation has to be given again.
import { useEffect, useState } from "react";
import type { DiscussionEvent, DiscussionRecord, DiscussionTarget } from "@evoloop/contracts";
import { Button, Checkbox, Field, Input, Textarea, cn } from "@evoloop/ui";
import { CommandFrame, readableDraft, useCommand, type MutationContext } from "../../shared/command";
import { SelectField, muted } from "./formParts";
import {
  discussionDecisionPayload, discussionHandoffPayload, discussionLinkPayload, discussionPreparePayload,
  type PrepareValues, type VerifiedDocumentHead,
} from "./commands";
import type { Choices } from "./discussionClient";
import {
  decisionBaseline, discussionPartLabels, handoffBaseline, linkBaseline, prepareBaseline, preparePart, targetKey, type Baseline, type PrepareSelection,
} from "./discussionBaseline";
import { targetKindLabel, type TargetKind } from "./discussionPresentation";

const required = "必填";
type Values = Record<string, string>;

/**
 * The shared command for one discussion form. An untouched form follows the latest baseline; once the reader has
 * typed, a moved part has to be looked at. A version conflict rereads the page first. `command.adopt` takes one part
 * as it reads now, when the reader picks that object themself.
 */
function useDiscussionCommand(context: MutationContext, current: Baseline, dirty: boolean) {
  const command = useCommand(context, current, { partLabels: discussionPartLabels, onStale: context.onChanged });
  useEffect(() => {
    if (!dirty && command.baselineChanged && !command.awaitingReread) command.rebase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, command.baselineChanged, command.awaitingReread]);
  return command;
}

const keepNote = "保留我的修改：输入不变；先看上方读回的新内容，确认这份输入仍然适用，再保存。";
/** The draft as text for “复制当前草稿”: each label with what was typed. */
const draftText = (title: string, labels: Record<string, string>, values: Values) =>
  () => readableDraft(title, Object.entries(labels).map(([name, label]) => ({ name, label })), values);

function useDraft<T extends Values>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [dirty, setDirty] = useState(false);
  const [tried, setTried] = useState(false);
  return {
    values, dirty, tried, setTried, touch: () => setDirty(true),
    set: (name: keyof T, value: string) => { setValues(current => ({ ...current, [name]: value })); setDirty(true); },
    error: (name: keyof T) => tried && !values[name]?.trim() ? required : undefined,
    missing: (names: Array<keyof T>) => names.some(name => !values[name]?.trim()),
    clear: () => { setValues(initial); setDirty(false); setTried(false); },
  };
}

function TextField({ label, hint, error, value, onChange, multiline, rows }: {
  label: string; hint?: string; error?: string; value: string; onChange(value: string): void; multiline?: boolean; rows?: number;
}) {
  return <Field label={label} hint={hint} error={error}>{control => multiline
    ? <Textarea {...control} rows={rows ?? 3} value={value} autoComplete="off" onChange={event => onChange(event.target.value)} />
    : <Input {...control} value={value} autoComplete="off" onChange={event => onChange(event.target.value)} />}</Field>;
}

const prepareInitial = { title: "", goalId: "", stageId: "", taskId: "", question: "", options: "", authorizationBoundary: "",
  targetSessionLabel: "", targetSessionRef: "", body: "" };
// The typed text; the picked objects are chosen again from the reread lists, so their identifiers are not copied.
const prepareLabels = { title: "交接包标题", question: "本次要讨论的问题", options: "备选做法", authorizationBoundary: "授权与不能自行决定的边界",
  targetSessionLabel: "拟交接的智能体", targetSessionRef: "智能体的安全引用", body: "补充上下文" };

/** Prepare a fixed package: the goal version, optional stage and task, adopted documents, and the question to answer. */
export function PrepareForm({ context, choices, rereading, onPrepared, onCancel }: {
  context: MutationContext; choices: Choices; rereading: boolean; onPrepared(id: string): void; onCancel(): void;
}) {
  const [kind, setKind] = useState<PrepareValues["kind"]>("allocation");
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const draft = useDraft(prepareInitial);
  const { values } = draft;
  const selection: PrepareSelection = { goalId: values.goalId, stageId: values.stageId, taskId: values.taskId, documentIds };
  const command = useDiscussionCommand(context, prepareBaseline(choices, selection), draft.dirty);
  const stages = choices.stages.filter(stage => stage.goalId === values.goalId);
  const adopted = choices.documents.filter(document => !!document.adoptedRevisionId);
  const requiredNames = ["title", "goalId", "question", "options", "authorizationBoundary", "targetSessionLabel"] as const;
  /** Picking an object takes its revision as read now; the stage list depends on the goal, so a new goal clears it. */
  const pick = (part: "goal" | "stage" | "task", value: string) => {
    const next = { ...selection, ...(part === "goal" ? { goalId: value, stageId: "" } : part === "stage" ? { stageId: value } : { taskId: value }) };
    draft.set(`${part}Id` as "goalId", value);
    if (part === "goal") { draft.set("stageId", ""); command.adopt({ stage: "" }); }
    command.adopt({ [part]: preparePart(choices, part, next) });
  };
  const toggleDocument = (id: string) => {
    const next = documentIds.includes(id) ? documentIds.filter(item => item !== id) : [...documentIds, id];
    setDocumentIds(next); draft.touch(); command.adopt({ documents: preparePart(choices, "documents", { ...selection, documentIds: next }) });
  };
  const send = () => {
    draft.setTried(true);
    if (draft.missing([...requiredNames]) || documentIds.length > 20) return;
    void command.submit(() => discussionPreparePayload(choices, { ...values, kind, documentIds },
      { discussionId: crypto.randomUUID(), documentId: crypto.randomUUID() }, context.projectId), result => { draft.clear(); setDocumentIds([]); onPrepared(result.entityId); });
  };
  const refill = () => { command.rebase(); draft.clear(); setDocumentIds([]); };
  return <CommandFrame context={context} command={command} label="准备讨论" submitLabel="生成交接包" dirty={draft.dirty} onSubmit={send}
    onKeep={() => command.rebase()} onRefill={refill} keepNote={keepNote} rereading={rereading} onCancel={onCancel} className="gap-4 rounded-xl"
    copy={draftText("准备讨论", prepareLabels, values)}>
    <div role="group" aria-label="讨论什么" className="flex flex-wrap gap-2">
      {(["allocation", "direction"] as const).map(item => <Button key={item} size="compact" variant={kind === item ? "secondary" : "ghost"} aria-pressed={kind === item}
        className={cn(kind === item && "bg-selected")} onClick={() => setKind(item)}>{item === "allocation" ? "讨论当前分工" : "讨论下一阶段"}</Button>)}
    </div>
    <p className={muted}>交接包固定所选目标的版本、可选的阶段与任务、已采纳文档，系统生成完整来源头，正文只补充本次的问题。</p>
    <TextField label="交接包标题" value={values.title} error={draft.error("title")} onChange={value => draft.set("title", value)} />
    <SelectField label="固定目标" value={values.goalId} error={draft.error("goalId")} onChange={value => pick("goal", value)}>
      <option value="">请选择</option>{choices.goals.map(goal => <option key={goal.id} value={goal.id}>{goal.outcome} · 第 {goal.version} 版</option>)}
    </SelectField>
    <div className="grid gap-4 compact:grid-cols-2">
      <SelectField label="关联阶段（可选）" value={values.stageId} disabled={!values.goalId} onChange={value => pick("stage", value)}
        hint={values.goalId ? (stages.length ? "只列出所选目标下的阶段。" : "所选目标下没有阶段。") : "先选目标。"}>
        <option value="">不关联阶段</option>{stages.map(stage => <option key={stage.id} value={stage.id}>{stage.deliverable} · 第 {stage.version} 版</option>)}
      </SelectField>
      <SelectField label="关联任务（可选）" value={values.taskId} onChange={value => pick("task", value)} hint="同时选了阶段时，任务必须属于该阶段。">
        <option value="">不关联任务</option>{choices.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </SelectField>
    </div>
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-label font-semibold text-foreground">已采纳的过程文档（可多选，最多 20 份）</legend>
      {adopted.length === 0 ? <p className={muted}>项目里还没有已采纳的过程文档。</p>
        : <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md bg-field p-2">{adopted.map(document => <label key={document.id} className="flex items-center gap-2 text-small text-foreground">
          <Checkbox checked={documentIds.includes(document.id)} onCheckedChange={() => toggleDocument(document.id)} />
          <span className="min-w-0 truncate">{document.title}</span></label>)}</div>}
      {documentIds.length > 20 && <span className="text-caption text-destructive">最多选 20 份，现在选了 {documentIds.length} 份。</span>}
    </fieldset>
    <TextField label="本次要讨论的问题" multiline value={values.question} error={draft.error("question")} onChange={value => draft.set("question", value)} />
    <TextField label="备选做法" hint="每行一项，一到十项。" multiline rows={4} value={values.options} error={draft.error("options")} onChange={value => draft.set("options", value)} />
    <TextField label="授权与不能自行决定的边界" multiline value={values.authorizationBoundary} error={draft.error("authorizationBoundary")} onChange={value => draft.set("authorizationBoundary", value)} />
    <div className="grid gap-4 compact:grid-cols-2">
      <TextField label="拟交接的智能体" value={values.targetSessionLabel} error={draft.error("targetSessionLabel")} onChange={value => draft.set("targetSessionLabel", value)} />
      <TextField label="智能体的安全引用（可选）" hint="本项目页面、http(s) 地址或 codex://threads/<ID>。记下引用不表示已送达。" value={values.targetSessionRef} onChange={value => draft.set("targetSessionRef", value)} />
    </div>
    <TextField label="补充上下文（可选）" hint="固定来源由系统生成，这里只写补充说明。" multiline value={values.body} onChange={value => draft.set("body", value)} />
  </CommandFrame>;
}

// The three forms below fold away (`onCancel`) once their write is applied — including when an unknown result is
// later read back as applied — and the reread shows what was recorded. `notReady` names why sending is not possible now.
interface DetailFormProps { context: MutationContext; record: DiscussionRecord; notReady: string | undefined; rereading: boolean; onCancel(): void }

/** Record that someone was actually seen taking the package over; it does not prove delivery or reading. */
export function HandoffForm({ context, record, notReady, rereading, onCancel }: DetailFormProps) {
  const draft = useDraft({ evidence: "", reason: "" });
  const command = useDiscussionCommand(context, handoffBaseline(record), draft.dirty);
  const send = () => {
    draft.setTried(true);
    if (draft.missing(["evidence", "reason"])) return;
    void command.submit(() => discussionHandoffPayload(record, draft.values), () => { draft.clear(); onCancel(); });
  };
  return <CommandFrame context={context} command={command} label="登记承接观察" submitLabel="登记承接" dirty={draft.dirty} onSubmit={send}
    onKeep={() => command.rebase()} onRefill={() => { command.rebase(); draft.clear(); }} keepNote={keepNote} paused={notReady} rereading={rereading}
    onCancel={onCancel} className="gap-4 rounded-xl" copy={draftText("登记承接观察", { evidence: "实际怎样观察到承接", reason: "理由与依据" }, draft.values)}>
    <TextField label="实际怎样观察到承接" hint="只登记人工观察，不证明自动送达或对方已读完。" multiline value={draft.values.evidence} error={draft.error("evidence")} onChange={value => draft.set("evidence", value)} />
    <TextField label="理由与依据" multiline value={draft.values.reason} error={draft.error("reason")} onChange={value => draft.set("reason", value)} />
  </CommandFrame>;
}

/**
 * Record a decision, or a correction of the current one. When the document's current version differs from what the
 * discussion registered, the reader confirms both were compared and why the record continues from the document; that
 * confirmation is dropped whenever the head, the discussion or the decision it corrects changes, or the view is stale.
 */
export function DecisionForm({ context, record, latest, head, notReady, rereading, onCancel }: DetailFormProps & {
  latest: DiscussionEvent | undefined; head: VerifiedDocumentHead;
}) {
  const mismatch = head.revisionId !== record.currentDocumentRevisionId;
  const draft = useDraft({ choice: "", unresolved: "", relookCondition: "", evidence: "", reason: "", documentRecoveryReason: "" });
  const [confirmed, setConfirmed] = useState(false);
  const command = useDiscussionCommand(context, decisionBaseline(record, latest, head), draft.dirty || confirmed);
  const recheck = command.baselineChanged;
  useEffect(() => { if (recheck) setConfirmed(false); }, [recheck]);
  const names = ["choice", "unresolved", "relookCondition", "evidence", "reason", ...(mismatch ? ["documentRecoveryReason" as const] : [])] as const;
  const send = () => {
    draft.setTried(true);
    if (draft.missing([...names]) || (mismatch && !confirmed)) return;
    void command.submit(() => discussionDecisionPayload(record, latest, head, { ...draft.values, ...(confirmed ? { confirmRecovery: "confirmed" } : {}) }),
      () => { draft.clear(); setConfirmed(false); onCancel(); });
  };
  const title = latest ? "纠正当前决定" : "登记讨论决定";
  return <CommandFrame context={context} command={command} label={title} submitLabel={latest ? "保存纠正" : "保存决定"} dirty={draft.dirty || confirmed}
    onSubmit={send} onKeep={() => command.rebase()} onRefill={() => { command.rebase(); draft.clear(); setConfirmed(false); }} keepNote={keepNote}
    permission="review" paused={notReady} rereading={rereading} onCancel={onCancel} className="gap-4 rounded-xl"
    copy={draftText(title, { choice: "本次取舍", unresolved: "还没解决的问题", relookCondition: "什么情况下重看", evidence: "讨论依据与实际观察", reason: "理由",
      documentRecoveryReason: "为什么从文档当前版接续" }, draft.values)}>
    {latest && <p className={muted}>保存后当前决定会标为已纠正。旧决定和已链接的对象都保留，不会自动撤销任何行动。</p>}
    <TextField label="本次取舍（也可以明确维持现状）" multiline value={draft.values.choice} error={draft.error("choice")} onChange={value => draft.set("choice", value)} />
    <TextField label="还没解决的问题" multiline value={draft.values.unresolved} error={draft.error("unresolved")} onChange={value => draft.set("unresolved", value)} />
    <TextField label="什么情况下重看" multiline value={draft.values.relookCondition} error={draft.error("relookCondition")} onChange={value => draft.set("relookCondition", value)} />
    <TextField label="讨论依据与实际观察" multiline value={draft.values.evidence} error={draft.error("evidence")} onChange={value => draft.set("evidence", value)} />
    <TextField label="理由" multiline value={draft.values.reason} error={draft.error("reason")} onChange={value => draft.set("reason", value)} />
    {mismatch && <div className="flex flex-col gap-3 rounded-lg bg-warning-soft p-3">
      <label className="flex items-start gap-2 text-small text-foreground">
        <Checkbox checked={confirmed} disabled={recheck} onCheckedChange={checked => setConfirmed(checked === true)} className="mt-0.5" />
        <span>我已核对讨论登记版和文档当前版（第 {head.version} 版），确认从文档当前版接续，追加恢复记录和本次决定。</span>
      </label>
      {draft.tried && !confirmed && !recheck && <span className="text-caption text-destructive">两版不同时，需要先确认已核对。</span>}
      <TextField label="为什么从文档当前版接续" multiline value={draft.values.documentRecoveryReason} error={draft.error("documentRecoveryReason")} onChange={value => draft.set("documentRecoveryReason", value)} />
    </div>}
  </CommandFrame>;
}

export interface TargetChoice { value: string; kind: TargetKind; label: string; target: DiscussionTarget }

/** Every object a decision can link to, at the revision or version that was read. */
export function targetChoices(choices: Choices): TargetChoice[] {
  return [
    ...choices.tasks.map(task => ({ value: `task:${task.id}`, kind: "task" as const, label: task.title, target: { kind: "task" as const, id: task.id, revisionId: task.currentRevisionId } })),
    ...choices.stages.map(stage => ({ value: `stage:${stage.id}`, kind: "stage" as const, label: `${stage.deliverable} · 第 ${stage.version} 版`, target: { kind: "stage" as const, id: stage.id, version: stage.version } })),
    ...choices.roles.map(role => ({ value: `role:${role.id}`, kind: "role" as const, label: role.proposal.title, target: { kind: "role" as const, id: role.id, revisionId: role.currentRevisionId } })),
    ...choices.documents.map(document => ({ value: `document:${document.id}`, kind: "document" as const, label: `${document.title} · 第 ${document.version} 版`, target: { kind: "document" as const, id: document.id, revisionId: document.currentRevisionId } })),
  ];
}

/** Link one existing object as the follow-up of the current decision. The decision itself never creates it. */
export function LinkForm({ context, record, decision, choices, notReady, rereading, onCancel }: DetailFormProps & { decision: DiscussionEvent; choices: TargetChoice[] }) {
  const draft = useDraft({ target: "", reason: "" });
  const picked = choices.find(item => item.value === draft.values.target);
  const command = useDiscussionCommand(context, linkBaseline(record, decision, picked?.target), draft.dirty);
  const send = () => {
    draft.setTried(true);
    if (draft.missing(["target", "reason"])) return;
    void command.submit(() => {
      if (!picked) throw new Error("所选对象已不在读回的清单里，请重新选择。");
      return discussionLinkPayload(record, decision, picked.target, draft.values.reason);
    }, () => { draft.clear(); onCancel(); });
  };
  const pick = (value: string) => { draft.set("target", value); command.adopt({ target: targetKey(choices.find(item => item.value === value)?.target) }); };
  return <CommandFrame context={context} command={command} label="链接后续对象" submitLabel="链接对象" dirty={draft.dirty} onSubmit={send}
    onKeep={() => command.rebase()} onRefill={() => { command.rebase(); draft.clear(); }} keepNote={keepNote} permission="review" paused={notReady}
    rereading={rereading} onCancel={onCancel} className="gap-4 rounded-xl" copy={draftText("链接后续对象", { reason: "理由" }, draft.values)}>
    <p className={muted}>只链接已经存在、能读到的对象；讨论决定本身不会创建任务、阶段或常设职责。</p>
    <SelectField label="实际的后续对象" value={draft.values.target} error={draft.error("target")} onChange={pick}>
      <option value="">请选择</option>
      {(["task", "stage", "role", "document"] as const).map(kind => {
        const items = choices.filter(item => item.kind === kind);
        return items.length > 0 && <optgroup key={kind} label={targetKindLabel[kind]}>{items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup>;
      })}
    </SelectField>
    <TextField label="理由" multiline value={draft.values.reason} error={draft.error("reason")} onChange={value => draft.set("reason", value)} />
  </CommandFrame>;
}
