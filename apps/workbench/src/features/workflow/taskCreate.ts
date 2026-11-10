// 新建任务 (docs/frontend/pages/tasks.md 新建任务): the draft a person fills in, what is still missing, and the one
// `task.create` command it becomes. The command keeps the fields of both earlier forms: the create page's content with
// 期望结果, acceptance mode, execution time and daily repeat, and the journey form's stage, linked documents and
// decision-only close rule. Pure, so the page and its tests agree.
import type { TaskKind } from "@evoloop/contracts";
import { localInstant } from "../../shared/zonedTime";
import { dailyScheduledInstant, scheduledInstant, scheduledTimezone } from "./taskTimingPresentation";

export const taskKinds: Record<TaskKind, string> = { implementation: "实施", research: "调研", validation: "验证" };
export const maxLinkedDocuments = 20;

export interface TaskDraft {
  title: string;
  /** Why the work exists and what it covers (Markdown). */
  why: string;
  outcome: string;
  acceptance: string;
  /** The responsible role. */
  owner: string;
  stageId: string;
  kind: TaskKind | "";
  acceptanceMode: "independent_agent" | "human_required";
  consumer: string;
  /** `use`: closing needs the current delivery's actual use. `decision`: a cognition role's research judgement only. */
  closeRule: "use" | "decision";
  /** Local wall time `YYYY-MM-DDTHH:mm` in `timezone`; empty for no agreed time. */
  executeAt: string;
  timezone: string;
  repeat: "none" | "daily";
  evidence: string;
  stopCondition: string;
  documentIds: string[];
}

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei"; } catch { return "Asia/Taipei"; }
}

export function emptyTaskDraft(timezone = browserTimezone(), stageId = ""): TaskDraft {
  return { title: "", why: "", outcome: "", acceptance: "", owner: "", stageId, kind: "", acceptanceMode: "independent_agent", consumer: "",
    closeRule: "use", executeAt: "", timezone, repeat: "none", evidence: "", stopCondition: "", documentIds: [] };
}

/** Whether the person has typed anything beyond the defaults (the stage chosen on arrival does not count). */
export function draftTouched(draft: TaskDraft, base: TaskDraft): boolean {
  return (Object.keys(draft) as (keyof TaskDraft)[]).some(key => key !== "stageId" && JSON.stringify(draft[key]) !== JSON.stringify(base[key]));
}

/**
 * A local date and time in an IANA time zone, as the UTC instant the service stores. It reads the clock the way the
 * scheduler does (shared/zonedTime): a time a daylight-saving gap skips is refused, a repeated one is its earlier instant.
 */
export function zonedInstant(local: string, timezone: string): string {
  if (!local.trim()) throw new Error("请选择执行的日期和时间。");
  return localInstant(local, scheduledTimezone(timezone)).iso;
}

export type DraftProblems = Partial<Record<keyof TaskDraft, string>>;

/** The form's label for each field, so a summary can say where the problems are. */
export const draftFieldLabels: Record<keyof TaskDraft, string> = {
  title: "任务名称", why: "为什么要做", outcome: "期望结果", acceptance: "怎样独立验收", owner: "负责职责", stageId: "所属阶段",
  kind: "任务类型", acceptanceMode: "验收方式", consumer: "实际使用成果的身份", closeRule: "关闭条件", executeAt: "执行时间",
  timezone: "时区", repeat: "是否重复", evidence: "来源或反馈证据", stopCondition: "停止条件", documentIds: "关联已发布的文档",
};

/**
 * Fields the form does not show for this draft. A decision-only task names no acceptance mode, and its consumer is
 * its owner (the service accepts `useRequired: false` only then), so neither is asked for.
 */
export function hiddenFields(draft: Pick<TaskDraft, "closeRule">): (keyof TaskDraft)[] {
  return draft.closeRule === "decision" ? ["acceptanceMode", "consumer"] : [];
}

/** What must be fixed before the draft can be sent, field by field, in words the form shows under each field. */
export function taskDraftProblems(draft: TaskDraft, options: { canReview: boolean }): DraftProblems {
  const problems: DraftProblems = {};
  const missing = (key: keyof TaskDraft, text: string) => { if (!String(draft[key]).trim()) problems[key] = text; };
  missing("title", "写一个能在列表里认出的名称。");
  missing("why", "写明为什么要做、要做什么。");
  missing("outcome", "写明做完后应得到什么。");
  missing("acceptance", "写明独立验收要看的证据。");
  missing("owner", "选择负责这项任务的职责。");
  if (draft.stageId) {
    if (draft.closeRule === "use") missing("consumer", "属于阶段的任务要写明实际使用成果的身份。");
    missing("evidence", "属于阶段的任务要写明来源或反馈证据。");
    missing("stopCondition", "属于阶段的任务要写明在什么情况下停止。");
  }
  if (draft.closeRule === "use" && draft.acceptanceMode === "human_required" && !draft.consumer.trim())
    problems.consumer = "必须本人验收时，填写验收人的受信身份。";
  if (draft.closeRule === "decision") {
    if (!draft.stageId) problems.stageId = "只作判断记录的任务必须属于一个推进中的阶段。";
    if (draft.kind !== "research") problems.kind = "只作判断记录的任务类型须是调研。";
  }
  if (draft.repeat === "daily") {
    if (!options.canReview) problems.repeat = "每日重复需要审阅权限。";
    if (!draft.executeAt.trim()) problems.executeAt = "每日重复必须填写首次执行时间。";
  }
  if (draft.executeAt.trim()) {
    try {
      const instant = zonedInstant(draft.executeAt, draft.timezone);
      if (draft.repeat === "daily") dailyScheduledInstant(instant);
    } catch (cause) { problems.executeAt = cause instanceof Error ? cause.message : "执行时间无效。"; }
  }
  try { scheduledTimezone(draft.timezone); } catch (cause) { if (draft.executeAt.trim()) problems.timezone = cause instanceof Error ? cause.message : "时区无效。"; }
  if (draft.documentIds.length > maxLinkedDocuments) problems.documentIds = `最多关联 ${maxLinkedDocuments} 份文档。`;
  // The contract's limits (task.create), said with the length; a text is never cut. Text fields are measured as sent.
  const limit = (key: keyof TaskDraft, value: string, max: number, text = (length: number) => `最多 ${max} 字，现在是 ${length} 字，请删减后再提交。`) => {
    if (!problems[key] && value.length > max) problems[key] = text(value.length);
  };
  limit("title", draft.title.trim(), 240);
  limit("acceptance", draft.acceptance.trim(), 4000);
  limit("consumer", draft.consumer.trim(), 4000);
  limit("evidence", draft.evidence.trim(), 4000);
  limit("stopCondition", draft.stopCondition.trim(), 4000);
  limit("timezone", draft.timezone.trim(), 80);
  // 为什么要做 and 期望结果 become one text (taskContent): its limit is said under both.
  const content = taskContent(draft);
  if (content.length > maxContent) {
    const text = `“为什么要做”和“期望结果”合起来最多 ${maxContent} 字，现在是 ${content.length} 字，请删减后再提交。`;
    problems.why ??= text; problems.outcome ??= text;
  }
  // A field the person cannot see is never named as the thing to fix.
  for (const key of hiddenFields(draft)) delete problems[key];
  return problems;
}

/** The task's text as sent: why it exists, then 期望结果. */
export function taskContent(draft: Pick<TaskDraft, "why" | "outcome">): string {
  return `${draft.why.trim()}\n\n期望结果\n${draft.outcome.trim()}`;
}
const maxContent = 65536;

/** The `task.create` command for a draft without problems. `taskId` stays the same for one draft. */
export function taskCreateCommand(draft: TaskDraft, taskId: string): Record<string, unknown> {
  const text = (value: string) => value.trim();
  const decision = draft.closeRule === "decision";
  const instant = text(draft.executeAt) ? zonedInstant(draft.executeAt, draft.timezone) : null;
  const timing = instant ? {
    executeAtUtc: draft.repeat === "daily" ? dailyScheduledInstant(instant) : scheduledInstant(instant),
    timezone: scheduledTimezone(draft.timezone), repeat: draft.repeat,
  } : null;
  const consumer = decision ? draft.owner : text(draft.consumer);
  return {
    type: "task.create", taskId, title: draft.title, kind: draft.kind || null,
    content: taskContent(draft), acceptance: draft.acceptance, owner: draft.owner,
    // A decision-only task names no acceptance mode: the service accepts `useRequired: false` only then.
    ...(decision ? {} : { acceptanceMode: draft.acceptanceMode }), useRequired: !decision,
    ...(consumer ? { consumer } : {}),
    ...(draft.stageId ? { stageId: draft.stageId } : {}),
    ...(draft.documentIds.length ? { documentIds: [...draft.documentIds] } : {}),
    ...(timing ? { timing } : {}),
    ...(text(draft.evidence) ? { evidence: text(draft.evidence) } : {}),
    ...(text(draft.stopCondition) ? { stopCondition: text(draft.stopCondition) } : {}),
  };
}
