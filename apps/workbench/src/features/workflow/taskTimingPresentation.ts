import type { TaskTimingView } from "../../shared/api";
import { timeFieldInstant } from "../../shared/zonedTime";

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
  catch { throw new Error("时区无法识别，请重新选择时区。"); }
  if (!timezone) throw new Error("请选择时区。");
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

export function nextTimingLabel(timing: TaskTimingView, nowUtc = new Date().toISOString()): string {
  if (timing.seriesState === "stopped") return "已停止后续复制";
  if (timing.repeat === "none") return "仅本次，无后续时点";
  if (!timing.nextAtUtc) return "下一时点尚未安排";
  const prefix = Date.parse(timing.nextAtUtc) <= Date.parse(nowUtc)
    ? "待补的约定时点" : "未来下一时点";
  return `${prefix} ${formatScheduled(timing.nextAtUtc, timing.timezone)}`;
}

export function timingSetPayload(taskId: string, taskVersion: number, current: TaskTimingView | null,
  values: { executeAtUtc: string; timezone: string; repeat: "none" | "daily"; scope: "this" | "this_and_future" | "future"; reason: string }) {
  return { type: "task.timing.set" as const, taskId, expectedTaskVersion: taskVersion,
    expectedTimingVersion: timingVersion(current), executeAtUtc: values.repeat === "daily" ? dailyScheduledInstant(values.executeAtUtc) : scheduledInstant(values.executeAtUtc),
    timezone: scheduledTimezone(values.timezone), repeat: values.repeat, scope: values.scope, reason: values.reason.trim() };
}

/**
 * 执行时间与重复's forms: the date and time typed on the clock of `timezone` (as 新建任务 asks for it), sent as the same
 * task.timing.set a typed ISO time with its offset gave before. A time filled from the record and left as it was is sent
 * back exactly as stored (shared/zonedTime timeFieldInstant).
 */
export function timingFormPayload(taskId: string, taskVersion: number, current: TaskTimingView | null,
  values: { executeAt: string; timezone: string; repeat: "none" | "daily"; scope: "this" | "this_and_future" | "future"; reason: string }) {
  if (!values.executeAt.trim()) throw new Error("请选择约定执行时间。");
  const { executeAt, ...rest } = values;
  return timingSetPayload(taskId, taskVersion, current, { ...rest, executeAtUtc: timeFieldInstant(executeAt, values.timezone) });
}

export function timingStopPayload(taskId: string, current: TaskTimingView, reason: string) {
  return { type: "task.timing.stop" as const, taskId, expectedTimingVersion: timingVersion(current), reason: reason.trim() };
}

const recordId = /\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*/gi;
/** The service's waiting reason without the record IDs it names (they belong to 完整标识): “上一份任务仍为待办”. */
export function timingWaitingText(reason: string): string {
  return reason.replace(recordId, "").trim() || "有尚未结算的前一份任务";
}
