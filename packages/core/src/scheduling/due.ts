import type { DueSelection, ScheduleRevision } from "@evoloop/contracts/scheduling";

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_DAILY_DAYS = 370;
const DEFAULT_GRACE = 5 * MINUTE;

export class ScheduleRuleError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleRuleError"; }
}

function instant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new ScheduleRuleError("timestamp must be canonical UTC ISO");
  return time;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { throw new ScheduleRuleError("invalid IANA timezone"); }
}

function localParts(format: Intl.DateTimeFormat, time: number): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(time)) if (["year", "month", "day", "hour", "minute"].includes(part.type)) parts[part.type] = Number(part.value);
  return parts;
}

function offset(format: Intl.DateTimeFormat, time: number): number {
  const p = localParts(format, time);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - Math.floor(time / MINUTE) * MINUTE;
}

function dailyInstant(format: Intl.DateTimeFormat, date: Date, hour: number, minute: number): number | null {
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  const candidates = new Set<number>();
  for (const probe of [target - DAY, target, target + DAY]) {
    const candidate = target - offset(format, probe);
    const p = localParts(format, candidate);
    if (p.year === date.getUTCFullYear() && p.month === date.getUTCMonth() + 1 && p.day === date.getUTCDate() && p.hour === hour && p.minute === minute) candidates.add(candidate);
  }
  // At fall-back, the earlier UTC instant owns this local wall-clock slot.
  return candidates.size ? Math.min(...candidates) : null;
}

export function validateScheduleRevision(revision: ScheduleRevision): void {
  formatter(revision.timezone);
  if (revision.version < 1 || !Number.isSafeInteger(revision.version)) throw new ScheduleRuleError("invalid schedule version");
  if (!revision.authorization.scopeId || !revision.authorization.roleId || !revision.authorization.authorizedBy || !revision.template.title || !revision.template.goal || !revision.template.acceptance || !revision.template.owner) throw new ScheduleRuleError("schedule scope and task template required");
  if (revision.authorization.expiresAtUtc) instant(revision.authorization.expiresAtUtc);
  if (revision.rule.kind === "once") instant(revision.rule.atUtc);
  else if (revision.rule.kind === "interval") {
    instant(revision.rule.anchorUtc);
    if (!Number.isSafeInteger(revision.rule.everyMinutes) || revision.rule.everyMinutes < 1 || revision.rule.everyMinutes > 525_600) throw new ScheduleRuleError("interval must be 1 to 525600 minutes");
  } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(revision.rule.localTime)) throw new ScheduleRuleError("daily time must be HH:mm");
  if (revision.misfire.kind === "bounded" && (!Number.isSafeInteger(revision.misfire.maxCatchUp) || revision.misfire.maxCatchUp < 1 || revision.misfire.maxCatchUp > 100)) throw new ScheduleRuleError("bounded catch-up must be 1 to 100");
}

/** Pure, bounded due selection. Watermark is exclusive; now is inclusive. */
export function computeDue(revision: ScheduleRevision, watermarkUtc: string, nowUtc: string): DueSelection {
  validateScheduleRevision(revision);
  const from = instant(watermarkUtc), now = instant(nowUtc);
  if (now < from) throw new ScheduleRuleError("clock moved behind schedule watermark");
  if (revision.authorization.expiresAtUtc && now > instant(revision.authorization.expiresAtUtc)) return { plannedAtUtc: [], skippedCount: 0, totalDue: 0, checkedThroughUtc: nowUtc };
  let due: number[] = [];
  let total = 0;
  if (revision.rule.kind === "once") {
    const at = instant(revision.rule.atUtc);
    if (at > from && at <= now) { total = 1; due = [at]; }
  } else if (revision.rule.kind === "interval") {
    const anchor = instant(revision.rule.anchorUtc);
    const period = revision.rule.everyMinutes * MINUTE;
    const first = Math.max(0, Math.floor((from - anchor) / period) + 1);
    const last = Math.floor((now - anchor) / period);
    total = Math.max(0, last - first + 1);
    const keep = revision.misfire.kind === "bounded" ? revision.misfire.maxCatchUp : 1;
    for (let index = Math.max(first, last - keep + 1); index <= last; index++) due.push(anchor + index * period);
  } else {
    const format = formatter(revision.timezone);
    const firstLocal = localParts(format, from), lastLocal = localParts(format, now);
    const firstDate = Date.UTC(firstLocal.year!, firstLocal.month! - 1, firstLocal.day!);
    const lastDate = Date.UTC(lastLocal.year!, lastLocal.month! - 1, lastLocal.day!);
    if ((lastDate - firstDate) / DAY > MAX_DAILY_DAYS) throw new ScheduleRuleError("daily catch-up horizon exceeds 370 days; review required");
    const [hour, minute] = revision.rule.localTime.split(":").map(Number);
    for (let day = firstDate; day <= lastDate; day += DAY) {
      const at = dailyInstant(format, new Date(day), hour!, minute!);
      if (at !== null && at > from && at <= now) due.push(at);
    }
    total = due.length;
  }
  if (revision.misfire.kind === "skip") due = due.filter(at => now - at <= DEFAULT_GRACE).slice(-1);
  else if (revision.misfire.kind === "latest") due = due.slice(-1);
  else due = due.slice(-revision.misfire.maxCatchUp);
  return { plannedAtUtc: due.map(at => new Date(at).toISOString()), skippedCount: total - due.length, totalDue: total, checkedThroughUtc: nowUtc };
}
