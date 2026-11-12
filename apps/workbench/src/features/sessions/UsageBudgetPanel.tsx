import type { UsageDay, UsageOverview } from "@evoloop/contracts";
import { Notice } from "@evoloop/ui";
import { runtimeClient } from "../../shared/runtimeClient";
import { useProjectQuery } from "../../shared/query";
import { FactList, mutedText } from "../../shared/ui/PageParts";
import { date } from "../../shared/ui/shared";
import { budgetText, contextText, usageDayText } from "./usagePresentation";

function range(): { from: string; to: string } {
  // Include tomorrow in UTC so the project's local "today" is inside the window even east of UTC.
  const to = new Date(Date.now() + 86_400_000);
  const from = new Date(to.getTime() - 13 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** Per-Session and per-day usage, the Session's context pressure, and the project's daily budget. */
export function UsageBudgetView({ usage, sessionId, stale = false, inline = false }: {
  usage: UsageOverview; sessionId: string; stale?: boolean;
  /** Label beside value, as in the agent's right column. */
  inline?: boolean;
}) {
  const session = usage.sessions.find(item => item.sessionId === sessionId);
  const days: UsageDay[] = usage.daily.slice(-7).reverse();
  return <div className="flex min-w-0 flex-col gap-2" aria-label="用量与预算">
    <FactList inline={inline} rows={[
      ["今日（本智能体）", session ? session.recorded ? usageDayText(session.today) : "今日没有记账记录；不按 0 计"
        : "今日没有记录；不按 0 计"],
      ["上下文管理", session ? contextText(session.context) : "本智能体没有用量记录"],
      ["每日上限", budgetText(usage.budget)],
      ["用量时区", `${usage.timeZone} · 读于 ${date(usage.observedAt)}`],
    ]} />
    {session?.context.state === "handoff_required" && <Notice tone="waiting" title="请交接新线程">
      该智能体的上下文已达到交接阈值。普通结果通知会保留在队列中并暂停，业务 Task Run 不受影响；请用同一职责开启新线程，并把原 Session、原生线程和固定 Task 作为第一责任写入交接。
    </Notice>}
    {usage.budget.state === "warning" && <Notice tone="waiting" title="接近每日上限">
      今日用量已到上限的 {Math.round((usage.budget.ratio ?? 0) * 100)}%；普通结果通知仍会处理，但请核对是否必要。
    </Notice>}
    {days.length > 0 && <details className="min-w-0">
      <summary className="cursor-pointer text-caption text-text-secondary">最近 {days.length} 天的项目用量</summary>
      <ul className="mt-1 flex flex-col gap-1 text-caption">
        {days.map(day => <li key={day.day} className="flex min-w-0 justify-between gap-2">
          <span className="shrink-0 text-muted-foreground">{day.day}</span>
          <span className="min-w-0 text-right">{usageDayText(day)}</span>
        </li>)}
      </ul>
    </details>}
    {stale && <p className={mutedText}>上次读回，当前待核对。</p>}
  </div>;
}

export function UsageBudgetPanel({ projectId, token, sessionId, inline = false }: {
  projectId: string; token: string; sessionId: string; inline?: boolean;
}) {
  const { from, to } = range();
  const read = useProjectQuery(projectId, ["runtime", "usage", from, to],
    () => runtimeClient(token, projectId).usage(from, to), { refetchInterval: 60_000 });
  if (read.isError && !read.data) return <Notice tone="error">用量暂不可读取：{read.error instanceof Error ? read.error.message : "读取失败"}</Notice>;
  if (!read.data) return <p className={mutedText}>正在读取用量与预算…</p>;
  return <UsageBudgetView usage={read.data} sessionId={sessionId} stale={read.stale} inline={inline} />;
}
