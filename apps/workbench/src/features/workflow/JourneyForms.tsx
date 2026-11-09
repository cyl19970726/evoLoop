// The writes on 目标与阶段: create and revise a goal, propose, accept and review a stage, correct the latest review.
// Each form is the shared command form (shared/command, docs/frontend/components.md “提交表单”): the operation ID is
// kept as a recovery receipt first, and a form opened on one version refuses to send after the record moved until
// the person has looked again. Drafts live in the page (not storage), each kept with the baseline it was written
// against: switching stages and coming back keeps what was typed, and a draft written on an older version is never
// sent as if it were current.
import React from "react";
import type { Goal, Stage, StageReview } from "@evoloop/contracts";
import { Button, Notice } from "@evoloop/ui";
import { CommandForm, restoredFormState, type FormField, type MutationContext, type SavedDraft } from "../../shared/command";
import { nextChoiceLabel } from "./journeyPresentation";

export type Drafts = Map<string, SavedDraft>;
/** The page's drafts; the page is remounted for another project or identity, which drops them. */
export const DraftsContext = React.createContext<Drafts | null>(null);

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
  const [, setLooked] = React.useState(0);
  const earlier = earlierDrafts && drafts ? [...drafts.keys()].find(key => key.startsWith(earlierDrafts) && key !== draftKey) : undefined;
  const drop = (key: string) => { drafts?.delete(key); setLooked(count => count + 1); };
  return <CommandForm<string | undefined> context={context} label={label} submitLabel={submitLabel} permission={permission} paused={paused}
    fields={fields.map(field => ({ ...field, initial: initial[field.name] ?? "" }))} baseline={baseline} build={build} onApplied={onApplied}
    options={{ draft: drafts ? { store: drafts, key: draftKey } : undefined }} surface="plain" clearable
    notes={form => earlier && !form.dirty && <Notice tone="waiting" title="还有一份针对较早回看写的草稿" data-earlier-draft=""
      action={<span className="flex flex-wrap gap-2">
        <Button size="compact" onClick={() => {
          const kept = restoredFormState(drafts?.get(earlier)?.values, form.initials);
          drop(earlier);
          if (kept) form.fill(kept.values);
        }}>带入这份草稿</Button>
        <Button size="compact" variant="ghost" onClick={() => drop(earlier)}>丢弃</Button></span>}>
      那条回看已被后来的纠正替代，草稿没有提交。带入后请对照上面的最新回看再提交。</Notice>} />;
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
