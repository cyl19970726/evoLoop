// The one command form implementation. Rules: rules.ts; the hook: useCommand.ts; the form: CommandForm.tsx.
// shared/ActionForm.tsx keeps the older field-list interface on top of CommandForm.
export type { MutationContext, RecoverableCommand } from "./context";
export { clearCommandDrafts, commandDrafts, draftKeyFor, readableDraft, type DraftStore, type PendingOperation, type SavedDraft } from "./drafts";
export {
  baselineChangedText, baselineText, blockedText, changedParts, contentMoved, followLatest, formDirty, incompleteText, keepEdits,
  openingBaseline, permissionText, personMessage, prepareCommand, receiptFailedText, restoredFormState, submissionRefusal,
  unconfirmedNote, unconfirmedTitle, type Baseline, type FormState, type SubmittableCommand,
} from "./rules";
export { useCommand, type CommandOptions } from "./useCommand";
export {
  BaselineNotice, CommandBlock, CommandForm, CommandFrame, OutcomeNotice, initialValues, missingFields,
  type CommandFormProps, type CommandFrameProps, type CommandView, type FormField, type FormHandle,
} from "./CommandForm";
