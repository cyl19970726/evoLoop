// A date and time typed on a local clock (a date-time control) in a chosen time zone, and the instant the service
// stores. The forms that agree on a time (日程, 执行时间与重复, 新建任务) ask for the clock reading in the zone the
// record names, never for UTC or an offset. The reading follows the scheduler's own rule
// (@evoloop/contracts/scheduling dailyRuleInstant, also used by packages/core computeDue), so a preview never differs
// from what the coordinator decides: a time that a daylight-saving gap skips does not exist, and a time that happens
// twice when daylight saving ends is its earlier instant.
import { dailyRuleInstant, scheduleWallClock, scheduleZoneFormat } from "@evoloop/contracts/scheduling";

const zoneNames: Record<string, string> = {
  "Asia/Shanghai": "上海", "Asia/Taipei": "台北", "Asia/Hong_Kong": "香港", "Asia/Singapore": "新加坡", "Asia/Tokyo": "东京",
  "Europe/London": "伦敦", "Europe/Berlin": "柏林", "America/New_York": "纽约", "America/Los_Angeles": "洛杉矶", UTC: "UTC", "Etc/UTC": "UTC",
};

/** The reader's own time zone. */
export const readerZone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
/** A zone in words where the page knows it ("台北"), otherwise its own name. */
export function zoneName(timezone: string): string { return zoneNames[timezone] ?? timezone; }
export function zoneHasName(timezone: string): boolean { return Object.hasOwn(zoneNames, timezone); }

// One formatter per zone (a zone the runtime does not know is remembered as null): forms draw the zone list on every
// render, and a formatter is costly to build.
const formats = new Map<string, Intl.DateTimeFormat | null>();
function zoneFormatOrNull(timezone: string): Intl.DateTimeFormat | null {
  const zone = timezone.trim();
  if (!zone) return null;
  if (!formats.has(zone)) {
    let format: Intl.DateTimeFormat | null = null;
    try { format = scheduleZoneFormat(zone); } catch { format = null; }
    formats.set(zone, format);
  }
  return formats.get(zone)!;
}

function zoneFormat(timezone: string): Intl.DateTimeFormat {
  const format = zoneFormatOrNull(timezone);
  if (!format) throw new Error("时区无法识别，请重新选择时区。");
  return format;
}

export function knownZone(timezone: string): boolean {
  return zoneFormatOrNull(timezone) !== null;
}

type ZoneOption = { value: string; label: string };
const zoneLabel = (zone: string) => !knownZone(zone) ? `${zone}（无法识别）` : zoneHasName(zone) && zoneName(zone) !== zone ? `${zoneName(zone)}（${zone}）` : zone;
let commonZones: ZoneOption[] | null = null;

/** The time zones offered in a form: the ones already in use first, then common ones, then every zone the browser knows. */
export function timezoneOptions(inUse: ReadonlyArray<string | null | undefined> = []): ZoneOption[] {
  if (!commonZones) {
    let all: string[] = [];
    try { all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { all = []; }
    commonZones = [...new Set([readerZone(), ...Object.keys(zoneNames).filter(zone => zone !== "Etc/UTC"), ...all])]
      .map(zone => ({ value: zone, label: zoneLabel(zone) }));
  }
  const first = [...new Set(inUse.filter((zone): zone is string => !!zone && !!zone.trim()))];
  return [...first.map(zone => ({ value: zone, label: zoneLabel(zone) })), ...commonZones.filter(option => !first.includes(option.value))];
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The zone's offset at an instant (wall clock minus UTC), as dailyRuleInstant reads it. */
function offsetAt(format: Intl.DateTimeFormat, time: number): number {
  const p = scheduleWallClock(format, time);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(time / 60_000) * 60_000;
}

/** Every instant that shows this wall clock, found the way dailyRuleInstant finds them (it keeps the earliest). */
function instantsOf(format: Intl.DateTimeFormat, date: { year: number; month: number; day: number }, hour: number, minute: number): number[] {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const found = new Set<number>();
  for (const probe of [target - 86_400_000, target, target + 86_400_000]) {
    const candidate = target - offsetAt(format, probe);
    const p = scheduleWallClock(format, candidate);
    if (p.year === date.year && p.month === date.month && p.day === date.day && p.hour === hour && p.minute === minute) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

export interface LocalInstant {
  /** The UTC instant, as the service stores it. */
  iso: string;
  /** The clock reading happens twice that day (daylight saving ends); `iso` is the earlier one, `later` the other. */
  later: string | null;
}

/**
 * A local date and time (`YYYY-MM-DDTHH:mm`, seconds optional, as a date-time control gives it) in an IANA zone, as
 * a UTC instant. Throws, in words, for an unreadable value, an unknown zone, or a time the zone skips that day.
 */
export function localInstant(local: string, timezone: string): LocalInstant {
  const parts = localPattern.exec(local.trim());
  if (!parts) throw new Error("请选择日期和时间。");
  const [year, month, day, hour, minute, second = 0] = parts.slice(1).map(value => value === undefined ? 0 : Number(value)) as number[];
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (year! < 1000 || month! < 1 || month! > 12 || day! < 1 || day! > lastDay || hour! > 23 || minute! > 59 || second! > 59)
    throw new Error("日期或时间无效。");
  const format = zoneFormat(timezone);
  const date = { year: year!, month: month!, day: day! };
  const at = dailyRuleInstant(format, date, hour!, minute!);
  if (at === null) throw new Error("所选时区没有这个时刻（夏令时调整），请换一个时间。");
  const all = instantsOf(format, date, hour!, minute!);
  const later = all.find(value => value > at);
  return { iso: new Date(at + second! * 1000).toISOString(), later: later === undefined ? null : new Date(later + second! * 1000).toISOString() };
}

/** An instant as the value of a date-time control showing the clock of `timezone`; "" when it cannot be read. */
export function localInputIn(value: string | null | undefined, timezone: string): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  try {
    const p = scheduleWallClock(zoneFormat(timezone), time);
    const seconds = new Date(time).getUTCSeconds();
    return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}${seconds ? `:${pad(seconds)}` : ""}`;
  } catch { return ""; }
}

function clock(time: number, timezone: string): string {
  return new Date(time).toLocaleString("zh-CN", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
export const utcText = (iso: string) => iso.replace("T", " ").replace(/:00\.000Z$|\.000Z$|Z$/, "") + " UTC";

// ── A time field that was filled from a record ─────────────────────────────────────────────────────────────────────
// The field keeps the clock reading the person sees and, when it was filled from a stored instant, that instant too
// ("2027-11-07T01:30|2027-11-07T06:30:00.000Z"). While the reading still names that instant in the form's zone, the
// stored instant is sent back exactly (milliseconds, and the later of two repeated readings, included); a reading the
// person changed is worked out again. A zone the browser does not know shows the stored instant on the UTC clock.

export interface TimeFieldValue { local: string; instant: string | null }

export function splitTimeField(value: string): TimeFieldValue {
  const at = value.indexOf("|");
  if (at < 0) return { local: value, instant: null };
  const instant = value.slice(at + 1);
  return { local: value.slice(0, at), instant: Number.isFinite(Date.parse(instant)) ? instant : null };
}

export const joinTimeField = ({ local, instant }: TimeFieldValue): string => instant ? `${local}|${instant}` : local;

/** The clock a field shows its stored instant on: the zone's own, or UTC when the browser does not know the zone. */
export const fieldClockZone = (timezone: string): string => knownZone(timezone) ? timezone : "UTC";

/** A field filled from a stored instant (or empty). */
export function timeFieldValue(instant: string | null | undefined, timezone: string): string {
  if (!instant || !Number.isFinite(Date.parse(instant))) return "";
  return joinTimeField({ local: localInputIn(instant, fieldClockZone(timezone)), instant });
}

/** The instant a field stands for: the stored one while its reading is unchanged, otherwise the reading worked out in `timezone`. */
export function timeFieldInstant(value: string, timezone: string): string {
  const { local, instant } = splitTimeField(value);
  if (!local.trim()) throw new Error("请选择日期和时间。");
  if (instant && localInputIn(instant, fieldClockZone(timezone)) === local.trim()) return instant;
  if (!knownZone(timezone)) throw new Error("浏览器不认识这个时区，改动后的时间无法换算；请先选一个能识别的时区。");
  return localInstant(local, timezone).iso;
}

/**
 * What a time field becomes when the record's time zone is changed while the field is filled. A value filled from the record
 * (it carries its instant) keeps that instant: its clock reading is worked out again in the new zone, so changing only the zone
 * never moves the moment. A value typed by hand has only a reading, which is now read on the new zone's clock; that is said, not hidden.
 */
export function timeFieldAfterZoneChange(value: string, from: string, to: string): { value: string; note: string | null } {
  const { local, instant } = splitTimeField(value);
  if (!local.trim() || from === to || !knownZone(to)) return { value, note: null };
  if (instant && localInputIn(instant, fieldClockZone(from)) === local.trim()) {
    const next = timeFieldValue(instant, to);
    return { value: next, note: `时区改成了 ${to}：这个时刻不变（${utcText(instant)}），当地时间已换算为 ${splitTimeField(next).local.replace("T", " ")}。` };
  }
  return { value, note: `时区改成了 ${to}：这里填的 ${local.replace("T", " ")} 现在按 ${to} 的当地时间算，不是原来那个时刻；需要的话请重新填写。` };
}

/** The two instants of a reading that happens twice (daylight saving ends), or null. */
export function repeatedInstants(local: string, timezone: string): { earlier: string; later: string } | null {
  try { const read = localInstant(local, timezone); return read.later ? { earlier: read.iso, later: read.later } : null; }
  catch { return null; }
}

/** What a time field becomes, said under it: the zone's clock, the reader's, and the instant recorded. */
export function timeFieldPreview(value: string, timezone: string, reader = readerZone()): string | null {
  const { local, instant } = splitTimeField(value);
  if (!local.trim()) return null;
  if (!knownZone(timezone)) {
    return instant && localInputIn(instant, "UTC") === local.trim()
      ? `浏览器不认识时区“${timezone}”，这里按 UTC 显示；不改就原样保留 ${utcText(instant)}。`
      : "浏览器不认识这个时区，改动后的时间无法换算；请先选一个能识别的时区。";
  }
  try {
    const at = timeFieldInstant(value, timezone);
    const time = Date.parse(at);
    const own = clock(time, timezone);
    let mine = own;
    try { mine = clock(time, reader); } catch { /* the reader's zone is the browser's own */ }
    return `按${zoneName(timezone)}时间 ${own}${mine !== own ? `，即你的时间 ${mine}` : ""}；记录为 ${utcText(at)}。`;
  } catch (cause) { return cause instanceof Error ? cause.message : "日期或时间无效。"; }
}
