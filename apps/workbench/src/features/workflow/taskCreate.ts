// 新建任务 (docs/frontend/pages/tasks.md 新建任务): the draft a person fills in, what is still missing, and the one
// `task.create` command it becomes. The command keeps the fields of both earlier forms: the create page's content with
// 期望结果, acceptance mode, execution time and daily repeat, and the journey form's stage, linked documents and
// decision-only close rule. Pure, so the page and its tests agree.
import type { TaskKind } from "@evoloop/contracts";
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

const zoneParts = (timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The wall time an instant shows in a time zone, as if that wall time were UTC. */
function wallAsUtc(format: Intl.DateTimeFormat, instant: number): number {
  const part = (type: string) => Number(format.formatToParts(new Date(instant)).find(item => item.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/** A local date and time in an IANA time zone, as the UTC instant the service stores. */
export function zonedInstant(local: string, timezone: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!parts) throw new Error("请选择执行的日期和时间。");
  const [year, month, day, hour, minute, second = 0] = parts.slice(1).map(value => value === undefined ? 0 : Number(value)) as number[];
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (month! < 1 || month! > 12 || day! < 1 || day! > lastDay || hour! > 23 || minute! > 59 || second! > 59) throw new Error("执行时间无效。");
  const zone = scheduledTimezone(timezone);
  const format = zoneParts(zone);
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  // Two passes settle the zone's offset around a daylight-saving change.
  let instant = wall - (wallAsUtc(format, wall) - wall);
  instant = wall - (wallAsUtc(format, instant) - instant);
  if (wallAsUtc(format, instant) !== wall) throw new Error("所选时区没有这个时刻（夏令时调整），请换一个时间。");
  return new Date(instant).toISOString();
}

export type DraftProblems = Partial<Record<keyof TaskDraft, string>>;

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
    missing("consumer", "属于阶段的任务要写明实际使用成果的身份。");
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
  return problems;
}

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
    content: `${text(draft.why)}\n\n期望结果\n${text(draft.outcome)}`, acceptance: draft.acceptance, owner: draft.owner,
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
