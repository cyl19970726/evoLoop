import type { Occurrence, ScheduleRule } from "@evoloop/contracts/scheduling";
export const utcInstant = (value: string): string => new Date(value).toISOString().replace("T", " ").replace(/\.000Z$/, " UTC").replace(/Z$/, " UTC");
export function scheduleRuleLabel(rule: ScheduleRule, timezone?: string): string {
  if (rule.kind === "once") return `仅一次 · ${utcInstant(rule.atUtc)}`;
  if (rule.kind === "interval") return `从 ${utcInstant(rule.anchorUtc)} 起，每 ${rule.everyMinutes} 分钟`;
  return `每天 ${rule.localTime}（${timezone ?? "定义时区"} 当地时间）`;
}

// A schedule's times are said in the schedule's own time zone (the revision's IANA `timezone`), named in words where the
// page knows the zone; a reader in another zone also gets the time on their own clock.
const zoneNames: Record<string, string> = {
  "Asia/Shanghai": "上海", "Asia/Taipei": "台北", "Asia/Hong_Kong": "香港", "Asia/Singapore": "新加坡", "Asia/Tokyo": "东京",
  "Europe/London": "伦敦", "Europe/Berlin": "柏林", "America/New_York": "纽约", "America/Los_Angeles": "洛杉矶", UTC: "UTC", "Etc/UTC": "UTC",
};
export const readerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
export function zoneName(timezone: string): string { return zoneNames[timezone] ?? timezone; }
function wallTime(at: Date, timeZone: string, options: Intl.DateTimeFormatOptions = {}): string | null {
  try { return at.toLocaleString("zh-CN", { timeZone, hour12: false, ...options }); } catch { return null; }
}

/** One instant of a schedule: "2026/11/10 09:00:00 · 台北", plus "（你的时间 …）" when the reader's clock reads otherwise. */
export function scheduleTime(value: string, timezone: string, reader = readerZone()): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const own = wallTime(at, timezone);
  const mine = wallTime(at, reader) ?? at.toLocaleString("zh-CN", { hour12: false });
  if (own === null) return `${mine}（你的时间；日程时区无法识别）`;
  return own === mine ? `${own} · ${zoneName(timezone)}` : `${own} · ${zoneName(timezone)}（你的时间 ${mine}）`;
}

/** The rule in words, its instants in the schedule's zone; a daily rule also says what the next run is on the reader's clock. */
export function scheduleRuleText(rule: ScheduleRule, timezone: string, now = Date.now(), reader = readerZone()): string {
  if (rule.kind === "once") return `仅一次 · ${scheduleTime(rule.atUtc, timezone, reader)}`;
  if (rule.kind === "interval") return `从 ${scheduleTime(rule.anchorUtc, timezone, reader)} 起，每 ${rule.everyMinutes} 分钟`;
  const next = nextRuleInstant(rule, timezone, now);
  const at = next ? new Date(next) : null;
  const time = { hour: "2-digit", minute: "2-digit" } as const;
  const own = at && wallTime(at, timezone, time), mine = at && wallTime(at, reader, time);
  return `每天 ${rule.localTime}（${zoneName(timezone)}${Object.hasOwn(zoneNames, timezone) ? "" : " "}当地时间${own && mine && own !== mine ? `，你的时间 ${mine}` : ""}）`;
}
export function latestOccurrence(items: Occurrence[]) {
  return [...items].sort((a,b) => Date.parse(b.observedAtUtc) - Date.parse(a.observedAtUtc))[0] ?? null;
}
export function occurrenceLabel(item: Occurrence): string {
  return item.state === "created" ? "已创建待办任务" : item.state === "queued" ? "等待排队" : "已跳过";
}

/** A previous read may remain visible in its own scope, but only this completed read grants write access. */
export function scheduleReadView<T extends { scope: string; readKey: string }>(
  snapshot: T | null, scope: string, readKey: string,
  read: { readKey: string; loading: boolean; error: string },
): { value: T | null; loading: boolean; error: string; fresh: boolean } {
  const value = snapshot?.scope === scope ? snapshot : null;
  const loading = read.readKey !== readKey || read.loading;
  const error = read.readKey === readKey ? read.error : "";
  return { value, loading, error, fresh: !!value && value.readKey === readKey && !loading && !error };
}

/** The next instant the rule names after `now`, as a preview only: the coordinator, grants and the misfire and overlap
 * policies decide whether anything is created then. Daily rules follow the definition's IANA timezone, including
 * daylight-saving changes. Returns null when the rule has no future instant or the timezone is unknown. */
export function nextRuleInstant(rule: ScheduleRule, timezone: string, now: number): string | null {
  if (rule.kind === "once") {
    const at = Date.parse(rule.atUtc);
    return Number.isFinite(at) && at > now ? new Date(at).toISOString() : null;
  }
  if (rule.kind === "interval") {
    const anchor = Date.parse(rule.anchorUtc), every = rule.everyMinutes * 60_000;
    if (!Number.isFinite(anchor) || !(every > 0)) return null;
    if (anchor > now) return new Date(anchor).toISOString();
    return new Date(anchor + (Math.floor((now - anchor) / every) + 1) * every).toISOString();
  }
  const match = /^(\d{2}):(\d{2})$/.exec(rule.localTime);
  if (!match || !validLocalTime(rule.localTime)) return null;
  try {
    const format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const local = (at: number) => {
      const parts = Object.fromEntries(format.formatToParts(new Date(at)).map(part => [part.type, part.value]));
      return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute) };
    };
    // Offset of the zone at an instant, in milliseconds (local wall clock minus UTC).
    const offset = (at: number) => { const p = local(at); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(at / 60_000) * 60_000; };
    const today = local(now);
    for (let add = 0; add < 3; add++) {
      const wall = Date.UTC(today.y, today.m - 1, today.d + add, Number(match[1]), Number(match[2]));
      const first = wall - offset(wall);
      const at = wall - offset(first);
      if (at > now) return new Date(at).toISOString();
    }
    return null;
  } catch { return null; }
}

/** Whether the next instant can be worked out at all: a bad timezone or time is not "no future instant". */
export function ruleIsComputable(rule: ScheduleRule, timezone: string): boolean {
  if (rule.kind === "once") return Number.isFinite(Date.parse(rule.atUtc));
  if (rule.kind === "interval") return Number.isFinite(Date.parse(rule.anchorUtc)) && Number.isFinite(rule.everyMinutes) && rule.everyMinutes > 0;
  if (!validLocalTime(rule.localTime)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
}

function validLocalTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return !!match && Number(match[1]) < 24 && Number(match[2]) < 60;
}

/** 下次时间 for an active schedule: the previewed instant, no future instant, or a rule that cannot be worked out. */
export function nextTimeText(rule: ScheduleRule, timezone: string, now: number, format: (iso: string) => string): string {
  if (!ruleIsComputable(rule, timezone)) return "无法推算：规则的时区或时间不合法";
  const next = nextRuleInstant(rule, timezone, now);
  return next ? `${format(next)}（按规则推算的预览）` : "规则里没有以后的时刻";
}

const occurrenceReasons: Record<string, string> = {
  scheduled: "到了规则时刻，按规则创建任务",
  "overlap skipped": "上一份任务还没结束，按设置跳过这个时刻",
  "overlap queued": "上一份任务还没结束，这个时刻排队等待",
  "queued occurrence admitted": "排队的时刻已放行，创建了任务",
};

/** Why an instant ended as it did. The scheduler records a short English code (packages/core/src/scheduling). */
export function occurrenceReasonText(reason: string): string {
  return occurrenceReasons[reason] ?? "按协调器记录的原因处理，原文见来源";
}
export function occurrenceReasonKnown(reason: string): boolean {
  return Object.hasOwn(occurrenceReasons, reason);
}

/** The coordinator's last error is free English text; the page names it and keeps the original in the source layer. */
export const coordinatorErrorText = "最近一次检查出错，原文见来源";

/** What 当前身份的日程授权 says with no grant listed. Only a current, complete read may say there is none. */
export function grantEmptyText(read: { fresh: boolean; loading: boolean }): string {
  if (read.fresh) return "没有；已有安排可阅读，已撤权的定义仍可暂停或停止";
  return read.loading ? "正在重新核对授权，暂不能判断" : "授权未能重新读取，无法判断";
}
