// One evaluation write. It is the shared command form (ActionForm on shared/command, docs/frontend/components.md
// “提交表单”) with what evaluations add: an introduction above the fields, a pause while the evaluation record is
// being checked (`hold`), and drawn in place inside its section or folded behind its title. Drafts are kept with
// their baseline in the shared memory-only store (`context.draftScope` names the attempt, the revision or the
// definition), and can be copied as text when the baseline moved.
import type { ReactNode } from "react";
import { ActionForm, type ActionFormProps, type Field, type MutationContext } from "../../shared/ActionForm";

export interface EvaluationFormProps {
  context: MutationContext; title: string; fields: Field[];
  build: ActionFormProps["build"];
  /** Writes in evaluations need the review permission, as before. */
  review?: boolean;
  onApplied?: ActionFormProps["onApplied"];
  /** Shown above the fields. */
  intro?: ReactNode;
  /** When set, submission is paused and this says why (for example a reread that failed). */
  hold?: string | undefined;
  /** Collapsed behind its title until opened (the default), or always open inside its section. */
  collapsible?: boolean;
}

export function EvaluationForm({ context, title, fields, build, review = false, onApplied, intro, hold, collapsible = true }: EvaluationFormProps) {
  return <ActionForm context={context} title={title} fields={fields} build={build} review={review} onApplied={onApplied}
    notes={intro} paused={hold} embedded={!collapsible} />;
}
