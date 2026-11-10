// The rules every command form applies, as pure functions (docs/frontend/components.md, “提交表单”):
//   - a form records its baseline when it opens: every fixed input the command depends on; versions sent are always
//     the recorded ones, and a baseline that moved refuses the submit;
//   - a form nobody has typed into follows the latest content; a form with changes asks the person (keep the fields
//     they changed, or refill from the latest content);
//   - each submission gets a new operation ID; the command is checked by the shared schema (or the form's own).
import { commandSchema, type Command, type Permission } from "@evoloop/contracts";
import type { RecoverableCommand } from "./context";

export const baselineChangedText = "打开表单后，这里的内容已被更新。请先查看最新内容，再按最新内容重新提交。";
export const incompleteText = "请补全必需字段并检查输入格式。";
export const receiptFailedText = "浏览器不能保存恢复回执，本次尚未提交。";
export const blockedText = "本项目仍有结果未确认的操作，请先核对上方回执。";
export const unconfirmedTitle = "这次提交的结果未确认";
export const unconfirmedNote = "核对为已应用后，这份草稿会自动清除；核对为被拒绝时草稿保留。";

/**
 * A text over the contract's limit, said with its length; null when it fits. Forms check this before sending and never
 * cut the text (the browser's own `maxLength` would cut a pasted text without saying so).
 */
export function overLimitText(value: string, max: number | undefined): string | null {
  return max !== undefined && value.length > max ? `最多 ${max} 字，现在是 ${value.length} 字，请删减后再提交。` : null;
}

/** Why the identity may not send this form, or null. */
export function permissionText(permissions: readonly Permission[], needed: readonly Permission[]): string | null {
  const missing = needed.find(permission => !permissions.includes(permission));
  if (!missing) return null;
  return `当前身份没有${missing === "review" ? "审阅" : missing === "write" ? "写入" : "这项"}权限。`;
}

/** The fixed inputs a form was opened on. Values are compared exactly; key order does not matter. */
export type Baseline = Readonly<Record<string, string | number | boolean | null>>;
export type SubmittableCommand = Command | (Record<string, unknown> & RecoverableCommand);

/** A baseline as one comparable string (a string baseline is used as is). */
export function baselineText(value: Baseline | string | undefined): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  return JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
}

/**
 * Why a submission must not be sent now, or null. A changed baseline or a stale answer always refuses; so does an
 * earlier submission whose result is still unknown.
 */
export function submissionRefusal(state: { busy: boolean; blocked: boolean; stale: boolean; unconfirmed?: boolean; recorded?: string | undefined; current?: string | undefined }):
  "busy" | "blocked" | "unconfirmed" | "baseline" | null {
  if (state.busy) return "busy";
  if (state.unconfirmed) return "unconfirmed";
  if (state.blocked) return "blocked";
  if (state.stale || state.recorded !== undefined && state.current !== undefined && state.recorded !== state.current) return "baseline";
  return null;
}

/** The baseline a form compares against when it mounts: a kept draft's own baseline, else what is on screen now. */
export function openingBaseline<B>(saved: { baseline: unknown } | undefined, current: B): B {
  return saved ? saved.baseline as B : current;
}

/** Readable names of the baseline parts forms commonly record; a form can name its own (`partLabels`). */
export const commonPartLabels: Readonly<Record<string, string>> = {
  taskVersion: "任务版本", revisionId: "任务修订", assignmentVersion: "分派", currentKey: "承接的智能体", planVersion: "计划",
  dependencyVersion: "前置任务", timingVersion: "执行时间", executeAt: "执行时间", seriesState: "重复设置", queueVersion: "队列",
  entryId: "队列项", entryVersion: "队列项", entryState: "队列项状态", runVersion: "运行", deliveryId: "最新交付", followUpVersion: "跟进安排",
  itemId: "关注项", itemVersion: "关注项", sessionVersion: "智能体", profileRevision: "执行配置", roleVersion: "职责", linkVersion: "连接登记",
  handoffState: "交接状态", grants: "日程授权", draftBaseline: "版本",
};

/**
 * The parts of two baselines that differ, by their readable name; parts without a name are not listed. Two string
 * baselines that differ are one part, “版本”.
 */
export function changedParts(seen: unknown, current: unknown, labels: Readonly<Record<string, string>> = {}): string[] {
  if (typeof seen === "string" && typeof current === "string") return seen === current ? [] : ["版本"];
  if (!seen || !current || typeof seen !== "object" || typeof current !== "object") return [];
  const before = seen as Record<string, unknown>, after = current as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(part => (before[part] ?? "") !== (after[part] ?? "") && labels[part])
    .map(part => labels[part]!);
}

const cjk = /[㐀-鿿]/;
/** A message the person can act on: a Chinese explanation is kept, anything else becomes the general hint. */
export function personMessage(cause: unknown): string {
  return cause instanceof Error && cjk.test(cause.message) ? cause.message : incompleteText;
}

/**
 * Builds the command that is sent: the form's fields plus the project and a new operation ID, parsed by the shared
 * schema (which trims text), or checked by `validate` and kept as built. Throws a message for the person.
 */
export function prepareCommand(built: Record<string, unknown>, projectId: string, operationId: string,
  options: { validate?: ((candidate: Record<string, unknown>) => void) | undefined } = {}): SubmittableCommand {
  const candidate = { ...built, projectId, operationId };
  try {
    if (options.validate) { options.validate(candidate); return candidate as SubmittableCommand; }
    return commandSchema.parse(candidate);
  } catch { throw new Error(incompleteText); }
}

type Values = Record<string, string>;
/** A form's fields: `base` is what they were last filled with, `values` what is in them now. */
export interface FormState { base: Values; values: Values }

/** The person changed at least one field from what it was filled with. */
export function formDirty(state: FormState): boolean {
  return Object.keys({ ...state.base, ...state.values }).some(key => (state.values[key] ?? "") !== (state.base[key] ?? ""));
}

const changedFrom = (from: Values, to: Values, key: string) => (to[key] ?? "") !== (from[key] ?? "");

/** The fields whose latest content differs from what the form was filled with (what moved while the person typed). */
export function movedFields(state: FormState, latest: Values): string[] {
  return Object.keys({ ...state.base, ...latest }).filter(key => changedFrom(state.base, latest, key));
}

/**
 * The fields both the person and someone else changed, to different text. Keeping the person's text there would send
 * what they wrote against the older content as if it were written against the latest one, so these are never kept
 * without asking field by field.
 */
export function conflictingFields(state: FormState, latest: Values): string[] {
  return Object.keys({ ...state.base, ...latest }).filter(key => changedFrom(state.base, state.values, key)
    && changedFrom(state.base, latest, key) && (state.values[key] ?? "") !== (latest[key] ?? ""));
}

/**
 * “保留我的修改”: the fields only the person changed stay; every other field takes the latest content. A field both
 * changed (`conflictingFields`) takes the latest content unless `choices` says the person chose their own text for it.
 */
export function keepEdits(state: FormState, latest: Values, choices: Readonly<Record<string, "mine" | "latest">> = {}): FormState {
  const conflicts = new Set(conflictingFields(state, latest));
  const values = Object.fromEntries(Object.keys(latest).map(key => {
    const mine = changedFrom(state.base, state.values, key);
    const keep = conflicts.has(key) ? choices[key] === "mine" : mine;
    return [key, keep ? state.values[key] ?? "" : latest[key] ?? ""];
  }));
  return { base: latest, values };
}

/** The latest content differs from what a changed form was filled with: the person has to look before sending. */
export function contentMoved(state: FormState, latest: Values): boolean {
  return formDirty(state) && JSON.stringify(Object.entries(latest).sort()) !== JSON.stringify(Object.entries(state.base).sort());
}

/**
 * The one rule for a form when newer content arrives: a form nobody has typed into follows it, and when its baseline
 * moved it records the new one (`rebase`); a form with changes waits until the person has looked. While a version
 * conflict is being read back, nothing moves. Returns what to do, or null.
 */
export function followLatest(state: FormState, latest: Values, baselineChanged: boolean, awaitingReread: boolean): { state: FormState; rebase: boolean } | null {
  if (formDirty(state) || awaitingReread) return null;
  if (!baselineChanged && JSON.stringify(latest) === JSON.stringify(state.base)) return null;
  return { state: { base: latest, values: latest }, rebase: baselineChanged };
}

/** A kept value that is a form state (what CommandForm saves), or a plain record of values (an older draft). */
export function restoredFormState(saved: unknown, initials: Values): FormState | undefined {
  if (!saved || typeof saved !== "object") return undefined;
  const value = saved as Partial<FormState>;
  if (value.base && value.values && typeof value.base === "object" && typeof value.values === "object") return { base: value.base, values: value.values };
  return { base: initials, values: { ...initials, ...saved as Values } };
}
