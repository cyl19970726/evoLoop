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

function zoneFormat(timezone: string): Intl.DateTimeFormat {
  const zone = timezone.trim();
  try { if (zone) return scheduleZoneFormat(zone); } catch { /* said below */ }
  throw new Error("时区无法识别，请重新选择时区。");
}

export function knownZone(timezone: string): boolean {
  try { zoneFormat(timezone); return true; } catch { return false; }
}

/** The time zones offered in a form: the ones already in use first, then common ones, then every zone the browser knows. */
export function timezoneOptions(inUse: ReadonlyArray<string | null | undefined> = []): { value: string; label: string }[] {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { all = []; }
  const order = [...inUse, readerZone(), ...Object.keys(zoneNames).filter(zone => zone !== "Etc/UTC"), ...all]
    .filter((zone): zone is string => !!zone && !!zone.trim());
  return [...new Set(order)].map(zone => ({ value: zone,
    label: !knownZone(zone) ? `${zone}（无法识别）` : zoneHasName(zone) && zoneName(zone) !== zone ? `${zoneName(zone)}（${zone}）` : zone }));
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
const utcText = (iso: string) => iso.replace("T", " ").replace(/:00\.000Z$|\.000Z$|Z$/, "") + " UTC";

/**
 * What a typed local time becomes, said before sending: the zone's clock, the reader's clock when it differs, and the
 * instant recorded. A repeated time says which of the two is used; a value that cannot be read says why. Empty input: null.
 */
export function localInstantPreview(local: string, timezone: string, reader = readerZone()): string | null {
  if (!local.trim()) return null;
  try {
    const { iso, later } = localInstant(local, timezone);
    const time = Date.parse(iso);
    const own = clock(time, timezone);
    let mine = own;
    try { mine = clock(time, reader); } catch { /* the reader's zone is the browser's own */ }
    return `按${zoneName(timezone)}时间 ${own}${mine !== own ? `，即你的时间 ${mine}` : ""}；记录为 ${utcText(iso)}。`
      + (later ? `这一当地时刻在夏令时结束时出现两次，按较早的一次，与协调器的规则相同；较晚的一次是 ${utcText(later)}。` : "");
  } catch (cause) { return cause instanceof Error ? cause.message : "日期或时间无效。"; }
}
