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
