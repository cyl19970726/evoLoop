// Drafts kept between mounts. Sensitive form content stays in this authenticated page's memory, never in storage:
// App.tsx empties the store when the project or the identity changes and on logout. This module has no UI imports,
// so the first-load bundle can clear it without loading the form components.

/** An operation whose result is unknown; the draft waits for it to be checked by its original ID. */
export interface PendingOperation { operationId: string; type: string }

/**
 * A kept draft: the values typed, the baseline they were written against (an object or a string; never what is on
 * screen when the form mounts again), and the operation sent from it whose result is still unknown.
 */
export interface SavedDraft { values: unknown; baseline: unknown; pending?: PendingOperation | undefined }

/** Where drafts are kept (a Map works). The key names the identity, project, object and form the draft is for. */
export type DraftStore = Pick<Map<string, SavedDraft>, "get" | "set" | "delete">;

const drafts = new Map<string, SavedDraft>();

/** The page's memory-only draft store shared by every command form. */
export const commandDrafts: DraftStore = {
  get: key => drafts.get(key),
  set: (key, draft) => drafts.set(key, draft),
  delete: key => drafts.delete(key),
};

export function clearCommandDrafts() { drafts.clear(); }

/** The key of a draft: who wrote it, in which project, for which object (`scope`) and which form. */
export function draftKeyFor(context: { principal: { actorId: string }; projectId: string }, scope: string, form: string): string {
  return `${context.principal.actorId}:${context.projectId}:${scope}:${form}`;
}

/** A draft as plain text, so the person can keep a copy before refilling the form: each label with what was typed. */
export function readableDraft(title: string, fields: ReadonlyArray<{ name: string; label: string }>, values: Record<string, string>): string {
  return `${title}\n\n${fields.map(field => `${field.label}\n${readableValue(values[field.name] ?? "")}`).join("\n\n")}`;
}

// A time field keeps "the clock reading|the instant it stands for" (shared/zonedTime.ts joinTimeField) and a date-time
// control "2026-11-10T10:28". A copy says them the way a person writes them: "2026-11-10 10:28（即 2026-11-10 02:28 UTC）".
// Written out here rather than imported, so this module stays free of the scheduling contract for the first load.
const clockReading = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/;
const utcInstant = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(?:\.\d+)?Z$/;
function readableValue(value: string): string {
  const [local = "", instant, ...rest] = value.split("|");
  const reading = clockReading.exec(local);
  if (!reading || rest.length) return value;
  const said = `${reading[1]} ${reading[2]}`;
  if (instant === undefined) return said;
  const utc = utcInstant.exec(instant);
  return utc ? `${said}（即 ${utc[1]} ${utc[2]}${utc[3] && utc[3] !== ":00" ? utc[3] : ""} UTC）` : said;
}
