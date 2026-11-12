// The one command form implementation. Rules: rules.ts; the hook: useCommand.ts; the form: CommandForm.tsx.
// shared/ActionForm.tsx keeps the older field-list interface on top of CommandForm.
export type { MutationContext, RecoverableCommand } from "./context";
export { clearCommandDrafts, commandDrafts, draftKeyFor, readableDraft, type DraftStore, type PendingOperation, type SavedDraft } from "./drafts";
export {
  baselineChangedText, baselineText, blockedText, changedParts, commonPartLabels, conflictingFields, contentMoved, followLatest, formDirty, incompleteText, keepEdits, movedFields,
  openingBaseline, overLimitText, permissionText, personMessage, prepareCommand, receiptFailedText, restoredFormState, submissionRefusal,
  unconfirmedNote, unconfirmedTitle, type Baseline, type FormState, type SubmittableCommand,
} from "./rules";
export { useCommand, type CommandOptions } from "./useCommand";
export {
  BaselineNotice, CommandBlock, CommandForm, CommandFrame, FieldInput, FormPendingContext, OutcomeNotice, fieldOptional, initialValues, missingFields, useFormPending,
  type CommandFormProps, type CommandFrameProps, type CommandView, type ConflictChoices, type CustomControl, type FieldConflict, type FormField, type FormHandle,
} from "./CommandForm";
