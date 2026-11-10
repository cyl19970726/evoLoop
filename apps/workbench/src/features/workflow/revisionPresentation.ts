// Who made a task revision and why, in words (docs/frontend/principles.md 界面用语、原始标识放在来源层). Most reasons
// are written by people and shown as written. A few are written by the service for agents and logs: a task a schedule
// generated (`schedule:<role id>` · `schedule <schedule id> at <ISO time>`), a daily repetition (`Task timing series
// <series id> at <ISO time>`), and the first revision (`Initial task`). Those are said in Chinese, with the time in
// local time; the original author, reason and identifiers go to 完整标识.

export interface RevisionOriginRow { label: string; value: string; text?: boolean }
export interface RevisionOrigin {
  /** Who: the actor as recorded, or what generated the revision (“日程「每日巡检」”). */
  author: string;
  /** Why, in Chinese when the service wrote it. */
  reason: string;
  /** One line for a summary: “test-owner · 新建任务”, or “由日程「每日巡检」在 2026/11/10 10:28:00 生成”. */
  line: string;
  /** The schedule whose name the line wants, when a schedule generated the revision. */
  scheduleId: string | null;
  /** The original author, reason and identifiers, for 完整标识; empty when nothing was replaced. */
  identifiers: RevisionOriginRow[];
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const scheduleReason = new RegExp(`^schedule (${uuid}) at (\\S+)$`, "i");
const seriesReason = new RegExp(`^Task timing series (${uuid}) at (\\S+)$`, "i");
const fixedReasons: Record<string, string> = {
  "Initial task": "新建任务",
  "Task content updated for future occurrences": "更新了以后各次的任务要求",
};

const raw = (actorId: string, reason: string): RevisionOriginRow[] =>
  [{ label: "原始作者", value: actorId }, { label: "原始理由", value: reason, text: true }];

/**
 * `scheduleTitle` is the generating schedule's name when it has been read (null while reading or when it cannot be
 * read: the line then says only “由日程生成”). `time` writes an ISO time as the page does.
 */
export function revisionOrigin(revision: { actorId?: string | null; reason?: string | null }, scheduleTitle: string | null, time: (iso: string) => string): RevisionOrigin {
  // A record without an author or reason says so; it never breaks the line.
  const actorId = revision.actorId?.trim() || "";
  const reason = revision.reason?.trim() || "";
  if (actorId.startsWith("schedule:")) {
    const schedule = scheduleReason.exec(reason);
    const title = scheduleTitle?.trim();
    const at = schedule?.[2] ?? null;
    const line = title && at ? `由日程「${title}」在 ${time(at)} 生成` : "由日程生成";
    const roleId = actorId.slice("schedule:".length);
    return { author: title ? `日程「${title}」` : "日程", reason: at ? `在 ${time(at)} 按日程自动生成` : "按日程自动生成", line,
      scheduleId: schedule?.[1] ?? null,
      identifiers: [...(schedule ? [{ label: "日程", value: schedule[1]! }, { label: "计划时间（UTC）", value: schedule[2]! }] : []),
        ...(roleId ? [{ label: "授权职责", value: roleId }] : []), ...raw(actorId, reason)] };
  }
  const series = seriesReason.exec(reason);
  if (series) {
    const line = `由每天重复在 ${time(series[2]!)} 生成`;
    return { author: actorId, reason: `每天重复在 ${time(series[2]!)} 自动生成`, line, scheduleId: null,
      identifiers: [{ label: "重复序列", value: series[1]! }, { label: "计划时间（UTC）", value: series[2]! }, ...raw(actorId, reason)] };
  }
  const fixed = fixedReasons[reason];
  if (fixed) return { author: actorId, reason: fixed, line: `${actorId} · ${fixed}`, scheduleId: null, identifiers: [{ label: "原始理由", value: reason, text: true }] };
  const author = actorId || "作者未记录";
  return { author, reason: reason || "理由未记录", line: `${author} · ${reason || "理由未记录"}`, scheduleId: null, identifiers: [] };
}
