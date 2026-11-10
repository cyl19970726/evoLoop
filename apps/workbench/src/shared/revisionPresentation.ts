// Who made a revision (a task's or a process document's) and why, in words (docs/frontend/principles.md 界面用语、原始标识
// 放在来源层). Most reasons are written by people and shown as written. A few are written by the service for agents and
// logs; those are said in Chinese:
// - a schedule's task: author `schedule:<role id>`, reason `schedule <schedule id> at <planned UTC time>`. The time is when
//   that run of the schedule was planned for, not when the revision was made (that is the revision's own createdAt);
// - a daily repetition: `Task timing series <series id> at <planned UTC time>`;
// - `Initial task`, `Initial task content`, `Initial draft`, `Task collaboration opened`,
//   `Task content updated for future occurrences`, `Runtime dispatch reserved`, `Managed dispatch <dispatch id>`.
// A planned time is written in the schedule's (or the repetition's) own time zone, as the schedule page writes it; while
// that zone is not read, in the reader's zone, saying so. The original author, reason and identifiers go to 完整标识.
import { actorIdentifier, actorText } from "./actorPresentation";
import { readerZone, zoneName } from "./zonedTime";

export interface RevisionOriginRow { label: string; value: string; text?: boolean }
export interface RevisionOrigin {
  /** Who: the actor as recorded, or what generated the revision (“日程「每日巡检」”). */
  author: string;
  /** Why, in Chinese when the service wrote it. */
  reason: string;
  /** One line for a summary: “test-owner · 新建任务”, or “按日程「每日巡检」生成，计划时间 2026/11/10 10:28:00 · 上海”. */
  line: string;
  /** The schedule whose name and zone the line wants, when a schedule generated the revision. */
  scheduleId: string | null;
  /** Whether a daily repetition generated the revision (its zone is read from the task's timing). */
  series: boolean;
  /** The original author, reason and identifiers, for 完整标识; empty when nothing was replaced. */
  identifiers: RevisionOriginRow[];
}

export interface RevisionOriginContext {
  /** The generating schedule once read: its name and IANA time zone. */
  schedule?: { title: string; timezone: string } | null;
  /** The daily repetition's IANA time zone once read. */
  seriesZone?: string | null;
  /** The reader's time zone; the browser's by default. */
  reader?: string;
}

// Zone names come from shared/zonedTime.ts, as on the schedule page (features/scheduling/presentation.ts scheduleTime).
function wallTime(at: Date, timeZone: string): string | null {
  try { return at.toLocaleString("zh-CN", { timeZone, hour12: false }); } catch { return null; }
}

/**
 * A planned instant: in `zone` as the schedule page writes it (“2026/11/10 10:28:00 · 上海”, plus the reader's clock when
 * it reads otherwise). With no zone read yet, in the reader's zone and saying so; with a zone the browser does not
 * recognise, on the reader's clock in the schedule page's words (“（你的时间；日程时区无法识别）”). `whose` names the
 * record the zone belongs to: 日程 or 每天重复.
 */
export function plannedTime(iso: string, zone: string | null | undefined, reader = readerZone(), whose: "日程" | "每天重复" = "日程"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const mine = wallTime(at, reader) ?? at.toLocaleString("zh-CN", { hour12: false });
  if (!zone) return `${mine}（按你的时区 ${zoneName(reader)}）`;
  const own = wallTime(at, zone);
  if (own === null) return `${mine}（你的时间；${whose}时区无法识别）`;
  return own === mine ? `${own} · ${zoneName(zone)}` : `${own} · ${zoneName(zone)}（你的时间 ${mine}）`;
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const scheduleReason = new RegExp(`^schedule (${uuid}) at (\\S+)$`, "i");
const seriesReason = new RegExp(`^Task timing series (${uuid}) at (\\S+)$`, "i");
const managedDispatch = new RegExp(`^Managed dispatch (${uuid})$`, "i");
const fixedReasons: Record<string, string> = {
  "Initial task": "新建任务",
  "Initial task content": "新建任务时的正文",
  "Initial draft": "初稿",
  "Task collaboration opened": "开启任务协作",
  "Task content updated for future occurrences": "更新了以后各次的任务要求",
  "Runtime dispatch reserved": "派发执行时开始任务并固定依据",
};

const raw = (actorId: string, reason: string): RevisionOriginRow[] =>
  [...(actorId ? [{ label: "原始作者", value: actorId }] : []), { label: "原始理由", value: reason, text: true }];

export function revisionOrigin(revision: { actorId?: string | null; reason?: string | null }, context: RevisionOriginContext = {}): RevisionOrigin {
  // A record without an author or reason says so; it never breaks the line.
  const actorId = revision.actorId?.trim() || "";
  const reason = revision.reason?.trim() || "";
  const reader = context.reader ?? readerZone();
  if (actorId.startsWith("schedule:")) {
    const schedule = scheduleReason.exec(reason);
    const title = context.schedule?.title.trim() || null;
    const named = title ? `日程「${title}」` : "日程";
    const at = schedule ? plannedTime(schedule[2]!, context.schedule?.timezone, reader) : null;
    const roleId = actorId.slice("schedule:".length);
    return { author: named, reason: at ? `按${named}自动生成，计划时间 ${at}` : "按日程自动生成",
      line: at ? `按${named}生成，计划时间 ${at}` : "由日程生成", scheduleId: schedule?.[1] ?? null, series: false,
      identifiers: [...(schedule ? [{ label: "日程", value: schedule[1]! }, { label: "计划时间（UTC）", value: schedule[2]! }] : []),
        ...(roleId ? [{ label: "授权职责", value: roleId }] : []), ...raw(actorId, reason)] };
  }
  const series = seriesReason.exec(reason);
  if (series) {
    const at = plannedTime(series[2]!, context.seriesZone, reader, "每天重复");
    const author = actorId ? actorText(actorId) : "作者未记录";
    return { author, reason: `按每天重复自动生成，计划时间 ${at}`, line: `按每天重复生成，计划时间 ${at}`, scheduleId: null, series: true,
      identifiers: [{ label: "重复序列", value: series[1]! }, { label: "计划时间（UTC）", value: series[2]! }, ...raw(actorId, reason)] };
  }
  // An author known only by an identifier (a UUID, an automatic run's worker) is said in words; the value is kept.
  const author = actorId ? actorText(actorId) : "作者未记录";
  const authorRows = actorIdentifier(actorId) ? [{ label: "原始作者", value: actorId }] : [];
  const dispatch = managedDispatch.exec(reason);
  const said = dispatch ? "自动循环派发并开始任务" : fixedReasons[reason];
  if (said) return { author, reason: said, line: `${author} · ${said}`, scheduleId: null, series: false,
    identifiers: [...(dispatch ? [{ label: "派发记录", value: dispatch[1]! }] : []), ...authorRows, { label: "原始理由", value: reason, text: true }] };
  return { author, reason: reason || "理由未记录", line: `${author} · ${reason || "理由未记录"}`, scheduleId: null, series: false, identifiers: authorRows };
}
