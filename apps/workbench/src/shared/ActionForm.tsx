// The field-list form interface most pages use (fields, title, review, draftScope / draftBaseline, validateCommand …),
// drawn by the one command form (shared/command). Every ActionForm therefore follows the same rules as every other
// form: the receipt is saved before sending, a new operation ID per submission, an unknown result blocks and is
// checked by its original ID, a recorded baseline whose versions are the ones sent, untouched forms follow the latest
// content and changed ones ask, a conflict rereads first, drafts are kept with their baseline under a key that names
// the object (`context.draftScope`). See docs/frontend/components.md, “提交表单”.
import * as React from "react";
import type { ReactNode } from "react";
import type { AppliedResult, CommandResult, Permission } from "@evoloop/contracts";
import { CommandForm, type FormField } from "./command/CommandForm";
import type { MutationContext } from "./command/context";
import { commandDrafts, draftKeyFor } from "./command/drafts";
import type { Baseline, SubmittableCommand } from "./command/rules";

export type { MutationContext, RecoverableCommand } from "./command/context";
export { clearCommandDrafts, commandDrafts, readableDraft } from "./command/drafts";

export interface Field {
  name: string; label: string; value?: string; kind?: "text" | "textarea" | "select" | "multi" | "datetime";
  options?: { value: string; label: string }[]; optional?: boolean; hint?: string; advanced?: boolean;
  placeholder?: string; autoGrow?: boolean;
  /** The contract's length limit, checked before sending (no limit by default, as before). */
  maxLength?: number;
}

/** What a form opened on: its `baseline`, `context.draftBaseline`, or both (the string as `draftBaseline`). */
export type ActionBaseline = Baseline | string | undefined;
export function actionBaseline(baseline: Baseline | undefined, draftBaseline: string | undefined): ActionBaseline {
  if (baseline && draftBaseline !== undefined) return { ...baseline, draftBaseline };
  return baseline ?? draftBaseline;
}

export const toFormField = (field: Field): FormField => ({ ...field, initial: field.value });

export interface ActionFormProps {
  context: MutationContext; title: string; fields: Field[];
  /** The command's fields. `seen` is the baseline recorded when the form opened; build versions from it. */
  build(values: Record<string, string>, seen: ActionBaseline): Record<string, unknown>;
  /** Every fixed input the command depends on (versions, revisions, the object picked), as it is now. */
  baseline?: Baseline | undefined;
  /** Sending needs the review permission (write by default); `requiredPermissions` names them exactly. */
  review?: boolean; requiredPermissions?: Permission[];
  onApplied?: (result: AppliedResult) => void;
  validateCommand?: (command: Record<string, unknown>) => void;
  sendCommand?: (command: SubmittableCommand) => Promise<CommandResult>;
  /** Folded behind its title (the default), open at first, or drawn in place (`embedded`). */
  initiallyOpen?: boolean; embedded?: boolean;
  /** ⌘/Ctrl + Enter submits (a message composer). */
  submitOnModEnter?: boolean;
  /** Shown above the fields. */
  notes?: ReactNode;
  /** Why sending waits right now (a reread that failed), or nothing. */
  paused?: string | null | undefined;
}

/**
 * A command as a form, folded behind its title unless `embedded`. A form with a kept draft opens, so its notices are
 * seen. The draft is kept only when `context.draftScope` names the object.
 */
export function ActionForm({ context, title, fields, build, baseline, review = false, requiredPermissions, onApplied, validateCommand, sendCommand,
  initiallyOpen = false, embedded = false, submitOnModEnter = false, notes, paused }: ActionFormProps) {
  const draftKey = context.draftScope ? draftKeyFor(context, context.draftScope, title) : undefined;
  const [startOpen] = React.useState(() => initiallyOpen || !!(draftKey && commandDrafts.get(draftKey)));
  const form = <CommandForm<ActionBaseline> context={context} label={title} submitLabel={title} fields={fields.map(toFormField)}
    baseline={actionBaseline(baseline, context.draftBaseline)} build={build} onApplied={onApplied}
    permission={requiredPermissions ?? (review ? "review" : "write")} notes={notes} paused={paused} submitOnModEnter={submitOnModEnter}
    options={{ validate: validateCommand, send: sendCommand, draft: draftKey ? { store: commandDrafts, key: draftKey } : undefined }}
    surface="plain" copyable />;
  if (embedded) return form;
  return <details data-ui="" open={startOpen || undefined} className="my-3 min-w-0 rounded-xl bg-raised shadow-sm">
    <summary className="cursor-pointer rounded-xl px-4 py-3 text-small font-medium text-foreground outline-none focus-visible:shadow-[var(--focus-ring)]">{title}</summary>
    <div className="border-t border-border px-4 pb-4 pt-3">{form}</div>
  </details>;
}

export const reasonField: Field = { name: "reason", label: "理由与依据", kind: "textarea" };
export const option = (value: string, label: string) => ({ value, label });
