import type { TaskTimingView } from "../api";

export function timingVersion(timing: TaskTimingView | null): number {
  if (!timing) return 0;
  if (!Number.isSafeInteger(timing.version) || timing.version < 1) throw new Error("执行时间版本未读回；请重新读取后编辑。");
  return timing.version;
}

export function scheduledInstant(value: string): string {
  const input = value.trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(input);
  if (!parts)
    throw new Error("请输入带 Z 或时区偏移的 ISO 8601 时间。");
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > lastDay ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59 ||
    Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) throw new Error("执行时间无效。");
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) throw new Error("执行时间无效。");
  return date.toISOString();
}

export function scheduledTimezone(value: string): string {
  const timezone = value.trim();
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }); }
  catch { throw new Error("请输入有效的 IANA 时区，例如 Asia/Taipei。"); }
  if (!timezone) throw new Error("请输入 IANA 时区。");
  return timezone;
}

export function dailyScheduledInstant(value: string): string {
  const instant = scheduledInstant(value);
  if (!instant.endsWith(":00.000Z")) throw new Error("每天重复的执行时间须精确到整分钟（秒为 00）。");
  return instant;
}

export function formatScheduled(value: string | null, timezone: string): string {
  if (!value) return "尚未安排";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间无法识别";
  try {
    return `${new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)}（${timezone}）`;
  } catch { return "时区无法识别"; }
}

export function repeatLabel(repeat: TaskTimingView["repeat"]): string {
  return repeat === "daily" ? "每天固定时间" : "仅本次";
}

export function timingSetPayload(taskId: string, taskVersion: number, current: TaskTimingView | null,
  values: { executeAtUtc: string; timezone: string; repeat: "none" | "daily"; scope: "this" | "this_and_future" | "future"; reason: string }) {
  return { type: "task.timing.set" as const, taskId, expectedTaskVersion: taskVersion,
    expectedTimingVersion: timingVersion(current), executeAtUtc: values.repeat === "daily" ? dailyScheduledInstant(values.executeAtUtc) : scheduledInstant(values.executeAtUtc),
    timezone: scheduledTimezone(values.timezone), repeat: values.repeat, scope: values.scope, reason: values.reason.trim() };
}

export function timingStopPayload(taskId: string, current: TaskTimingView, reason: string) {
  return { type: "task.timing.stop" as const, taskId, expectedTimingVersion: timingVersion(current), reason: reason.trim() };
}
