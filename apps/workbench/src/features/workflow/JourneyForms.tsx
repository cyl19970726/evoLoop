// The writes on 目标与阶段: create and revise a goal, propose, accept and review a stage, correct the latest review.
// Each form is built on @evoloop/ui and sends through useCommand, so the operation ID is kept as a recovery receipt
// first, and a form opened on one version refuses to send after the record moved until the person has looked again.
// Drafts live in the page (not storage), each kept with the baseline it was written against: switching stages and
// coming back keeps what was typed, and a draft written on an older version is never sent as if it were current.
import React from "react";
import type { Goal, Stage, StageReview } from "@evoloop/contracts";
import { Button, Field, Input, Notice, Select, Textarea } from "@evoloop/ui";
import type { MutationContext } from "../../shared/ActionForm";
import { nextChoiceLabel } from "./journeyPresentation";
import { baselineChangedText, useCommand, type SavedDraft } from "./useCommand";

export type Drafts = Map<string, SavedDraft>;
/** The page's drafts; the page is remounted for another project or identity, which drops them. */
export const DraftsContext = React.createContext<Drafts | null>(null);

interface FormField {
  name: string; label: string; kind?: "text" | "textarea" | "select";
  options?: { value: string; label: string }[]; hint?: string; optional?: boolean; rows?: number;
}
type Values = Record<string, string>;

/**
 * One write as a form. `draftKey` names the object (and the record) the draft is for; `earlierDrafts` is the key
 * prefix of drafts written for an earlier record of the same object (an older review), offered to bring over but
 * never sent as they are. `paused` explains why sending waits (the content on screen is being checked).
 */
export function RecordForm({ context, label, submitLabel, fields, initial, baseline, permission, paused, draftKey, earlierDrafts, build, onApplied }: {
  context: MutationContext; label: string; submitLabel: string; fields: FormField[]; initial: Values;
  baseline?: string; permission: "write" | "review"; paused?: string | null; draftKey: string; earlierDrafts?: string;
  build(values: Values, seen: string | undefined): Record<string, unknown>; onApplied?(): void;
}) {
  const drafts = React.useContext(DraftsContext);
  // A version conflict rereads the project, so the latest content is on screen before the person decides.
  const command = useCommand(context, baseline, { draft: drafts ? { store: drafts, key: draftKey } : undefined, onStale: context.onChanged });
  const [base, setBase] = React.useState(initial);
  const [values, setValues] = React.useState<Values>(() => (command.restoredDraft as Values | undefined) ?? initial);
  const [errors, setErrors] = React.useState<Values>({});
  const [saved, setSaved] = React.useState(false);
  const [, setLooked] = React.useState(0);
  const allowed = context.principal.permissions.includes(permission);
  const dirty = fields.some(field => (values[field.name] ?? "") !== (base[field.name] ?? ""));
  const latest = JSON.stringify(initial);
  const reset = () => { command.dropDraft(); setBase(initial); setValues(initial); setErrors({}); };
  // An untouched form follows the latest record; a typed draft waits until the person has looked at it.
  React.useEffect(() => {
    if (!dirty && (command.baselineChanged || latest !== JSON.stringify(base))) { command.rebase(); reset(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command.baselineChanged, dirty, latest]);
  const update = (name: string, value: string) => {
    const next = { ...values, [name]: value };
    setValues(next); setSaved(false);
    command.saveDraft(next);
    if (errors[name]) setErrors(({ [name]: _, ...rest }) => rest);
  };
  /** Keep the draft: from now on it is checked against the latest version, which the person has looked at. */
  const keepDraft = () => { command.rebase(); setBase(initial); };
  const refill = () => { command.rebase(); reset(); };
  const earlier = earlierDrafts && drafts ? [...drafts.keys()].find(key => key.startsWith(earlierDrafts) && key !== draftKey) : undefined;
  const bringOver = (key: string) => {
    const kept = drafts?.get(key)?.values as Values | undefined;
    drafts?.delete(key);
    if (kept) { setValues(kept); command.saveDraft(kept); }
    setLooked(count => count + 1);
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const problems = Object.fromEntries(fields.filter(field => !field.optional && !(values[field.name] ?? "").trim())
      .map(field => [field.name, `请填写${field.label}。`]));
    setErrors(problems);
    if (Object.keys(problems).length) return;
    const applied = await command.submit(() => build(values, command.recordedBaseline));
    if (applied) { reset(); setSaved(true); onApplied?.(); }
  }
  const control = (field: FormField) => (props: { id: string; "aria-describedby"?: string | undefined; "aria-invalid"?: boolean | undefined }) => {
    const common = { ...props, name: field.name, value: values[field.name] ?? "", autoComplete: "off" };
    if (field.kind === "textarea") return <Textarea {...common} rows={field.rows ?? 3} onChange={event => update(field.name, event.target.value)} />;
    if (field.kind === "select") return <Select {...common} className="w-full" onChange={event => update(field.name, event.target.value)}>
      <option value="">请选择</option>{field.options?.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </Select>;
    return <Input {...common} onChange={event => update(field.name, event.target.value)} />;
  };
  const fromEarlierMount = command.restoredDraft !== undefined && !command.outcome;
  return <form onSubmit={submit} aria-label={label} data-dirty={dirty ? "true" : undefined} className="flex flex-col gap-3" noValidate>
    {earlier && !dirty && <Notice tone="waiting" title="还有一份针对较早回看写的草稿" data-earlier-draft=""
      action={<span className="flex flex-wrap gap-2"><Button size="compact" onClick={() => bringOver(earlier)}>带入这份草稿</Button>
        <Button size="compact" variant="ghost" onClick={() => { drafts?.delete(earlier); setLooked(count => count + 1); }}>丢弃</Button></span>}>
      那条回看已被后来的纠正替代，草稿没有提交。带入后请对照上面的最新回看再提交。</Notice>}
    {command.baselineChanged && <Notice tone="waiting" data-baseline-changed="" title={fromEarlierMount ? "这份草稿写于较早的版本" : "内容已被更新"}
      action={paused ? undefined : <span className="flex flex-wrap gap-2">
        <Button size="compact" onClick={keepDraft}>保留草稿，按最新版本核对</Button>
        <Button size="compact" variant="ghost" onClick={refill}>用最新内容重填</Button></span>}>
      {paused ? "正在读回最新内容；读回后再决定保留草稿还是重填。草稿在下面，暂不能提交。"
        : `${baselineChangedText}页面上已是读回的最新内容。保留草稿：草稿不变，提交时按最新版本核对；重填：换成最新内容，草稿丢弃。`}</Notice>}
    {fields.map(field => <Field key={field.name} label={field.optional ? `${field.label}（可选）` : field.label} hint={field.hint} error={errors[field.name]}>{control(field)}</Field>)}
    {!allowed && <p className="text-caption text-muted-foreground">当前身份没有{permission === "review" ? "审阅" : "写入"}权限，不能{submitLabel}。</p>}
    {context.blocked && <p className="text-caption text-muted-foreground">本项目仍有结果未确认的操作，请先核对回执，再提交。</p>}
    {paused && <p className="text-caption text-muted-foreground">{paused}</p>}
    {command.outcome && !(command.baselineChanged && command.outcome.stale) && <Notice tone={command.outcome.failed ? "error" : "info"}>{command.outcome.message}</Notice>}
    {saved && !command.outcome && <p role="status" className="text-caption text-muted-foreground">已保存，上面已是读回的最新内容。</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" size="compact" disabled={!allowed || context.blocked || !!paused || command.busy || command.baselineChanged}>{command.busy ? "保存中…" : submitLabel}</Button>
      {dirty && <Button size="compact" variant="ghost" onClick={reset}>清空草稿</Button>}
    </div>
  </form>;
}

/** Draft keys name the object a draft is for; a correction also names the review it replaces. */
export const draftKeys = {
  goalNew: "goal:new",
  goal: (goalId: string) => `goal:${goalId}`,
  stageNew: (goalId: string) => `stage:new:${goalId}`,
  accept: (stageId: string) => `stage:${stageId}:accept`,
  review: (stageId: string) => `stage:${stageId}:review`,
  corrections: (stageId: string) => `stage:${stageId}:correct:`,
  correct: (stageId: string, reviewId: string) => `stage:${stageId}:correct:${reviewId}`,
};

const goalFields: FormField[] = [
  { name: "outcome", label: "想达成的结果", kind: "textarea" },
  { name: "constraints", label: "必须遵守的约束", kind: "textarea" },
  { name: "consumer", label: "谁会实际使用成果" },
  { name: "authority", label: "已授权的工作与需另行取舍的边界", kind: "textarea" },
  { name: "scope", label: "可投入范围与资源" },
  { name: "owner", label: "承接责任者", hint: "写职责名称、职责标识或负责的人。" },
];
export const goalFieldLabels = Object.fromEntries(goalFields.map(field => [field.name, field.label])) as Record<keyof Goal, string>;
const reason: FormField = { name: "reason", label: "理由与依据", kind: "textarea" };
const pick = (values: Record<string, string>, names: string[]) => Object.fromEntries(names.map(name => [name, values[name] ?? ""]));

export function GoalCreateForm({ context, paused, onApplied }: { context: MutationContext; paused?: string | null; onApplied?(): void }) {
  return <RecordForm context={context} label="建立目标" submitLabel="保存目标" permission="write" paused={paused} draftKey={draftKeys.goalNew} fields={goalFields}
    initial={Object.fromEntries(goalFields.map(field => [field.name, ""]))} onApplied={onApplied}
    build={values => ({ type: "goal.create", goalId: crypto.randomUUID(), ...pick(values, goalFields.map(field => field.name)) })} />;
}

export function GoalReviseForm({ context, goal, paused }: { context: MutationContext; goal: Goal; paused?: string | null }) {
  const names = goalFields.map(field => field.name);
  return <RecordForm context={context} label="修订目标" submitLabel="保存修订" permission="write" paused={paused} draftKey={draftKeys.goal(goal.id)}
    fields={[...goalFields, reason]} baseline={String(goal.version)} initial={{ ...pick(goal as unknown as Record<string, string>, names), reason: "" }}
    build={(values, seen) => ({ type: "goal.revise", goalId: goal.id, expectedVersion: Number(seen), ...pick(values, [...names, "reason"]) })} />;
}

export function StageProposeForm({ context, goal, paused }: { context: MutationContext; goal: Goal; paused?: string | null }) {
  const fields: FormField[] = [
    { name: "deliverable", label: "阶段交付", kind: "textarea", hint: "这一阶段要交出什么。" },
    { name: "learningQuestion", label: "学习问题", kind: "textarea", hint: "这一阶段想弄清什么。" }, reason,
  ];
  return <RecordForm context={context} label="提出阶段" submitLabel="提出阶段" permission="write" paused={paused} draftKey={draftKeys.stageNew(goal.id)}
    fields={fields} initial={{ deliverable: "", learningQuestion: "", reason: "" }}
    build={values => ({ type: "stage.propose", stageId: crypto.randomUUID(), goalId: goal.id, ...pick(values, ["deliverable", "learningQuestion", "reason"]) })} />;
}

export function StageAcceptForm({ context, stage, paused }: { context: MutationContext; stage: Stage; paused?: string | null }) {
  return <RecordForm context={context} label="接受阶段" submitLabel="接受阶段" permission="review" paused={paused} draftKey={draftKeys.accept(stage.id)}
    fields={[reason]} baseline={String(stage.version)} initial={{ reason: "" }}
    build={(values, seen) => ({ type: "stage.accept", stageId: stage.id, expectedVersion: Number(seen), reason: values.reason })} />;
}

const reviewFields: FormField[] = [
  { name: "adopted", label: "采用的认识与支持证据", kind: "textarea" },
  { name: "rejected", label: "被推翻或仍不能成立的解释", kind: "textarea" },
  { name: "gap", label: "目标差距与未知", kind: "textarea" },
  { name: "nextChoice", label: "下一选择", kind: "select", options: Object.entries(nextChoiceLabel).map(([value, label]) => ({ value, label })) },
  { name: "evidence", label: "交付、实际使用与反例证据", kind: "textarea" }, reason,
];
const reviewNames = reviewFields.map(field => field.name);

export function StageReviewForm({ context, stage, paused }: { context: MutationContext; stage: Stage; paused?: string | null }) {
  return <RecordForm context={context} label="记录阶段回看" submitLabel="记录回看" permission="review" paused={paused} draftKey={draftKeys.review(stage.id)}
    fields={reviewFields} baseline={String(stage.version)} initial={Object.fromEntries(reviewNames.map(name => [name, ""]))}
    build={(values, seen) => ({ type: "stage.review", stageId: stage.id, expectedVersion: Number(seen), ...pick(values, reviewNames) })} />;
}

/** A correction names the latest review it replaces; the old judgement stays in the history. */
export function StageCorrectForm({ context, stage, latest, paused }: { context: MutationContext; stage: Stage; latest: StageReview; paused?: string | null }) {
  return <RecordForm context={context} label="追加阶段回看纠正" submitLabel="追加纠正" permission="review" paused={paused} draftKey={draftKeys.correct(stage.id, latest.id)} earlierDrafts={draftKeys.corrections(stage.id)}
    fields={reviewFields} baseline={`${stage.version}:${latest.id}`}
    initial={{ ...pick(latest as unknown as Record<string, string>, reviewNames.filter(name => name !== "reason")), reason: "" }}
    build={(values, seen) => {
      const [version, reviewId] = (seen ?? "").split(":");
      return { type: "stage.review.correct", stageId: stage.id, expectedVersion: Number(version), supersedesReviewId: reviewId, ...pick(values, reviewNames) };
    }} />;
}
