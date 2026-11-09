import type { Occurrence, ScheduleRule } from "@evoloop/contracts/scheduling";
export const utcInstant = (value: string): string => new Date(value).toISOString().replace("T", " ").replace(/\.000Z$/, " UTC").replace(/Z$/, " UTC");
export function scheduleRuleLabel(rule: ScheduleRule, timezone?: string): string {
  if (rule.kind === "once") return `仅一次 · ${utcInstant(rule.atUtc)}`;
  if (rule.kind === "interval") return `从 ${utcInstant(rule.anchorUtc)} 起，每 ${rule.everyMinutes} 分钟`;
  return `每天 ${rule.localTime}（${timezone ?? "定义时区"} 当地时间）`;
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
  if (!match) return null;
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
