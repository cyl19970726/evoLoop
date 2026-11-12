// 上下文与用量 in the agent's right column (docs/frontend/pages/sessions.md 右栏): first “它还能用多久” — the context against
// its hand-off threshold as a bar — then “它今天用了多少” in four small figures, with this Session's running total folded.
// Project-wide facts (daily limit, recent project days, the usage time zone) are not this agent's; only a project close
// to or at its daily limit is said here, in one line. A missing count is 未知 or 没有记录, never 0; a missing cost 未报告.
import type { UsageOverview } from "@evoloop/contracts";
import { Notice, StatusTag, cn } from "@evoloop/ui";
import { runtimeClient } from "../../shared/runtimeClient";
import { useProjectQuery } from "../../shared/query";
import { mutedText } from "../../shared/ui/PageParts";
import { date, href } from "../../shared/ui/shared";
import { budgetReminder, contextGauge, todayTiles, tokenText, usageDayText } from "./usagePresentation";

const card = "flex min-w-0 flex-col gap-2 rounded-lg bg-muted px-3 py-2.5";
const bar: Record<string, string> = { progress: "bg-primary", waiting: "bg-warning", blocked: "bg-destructive" };

function range(): { from: string; to: string } {
  // Include tomorrow in UTC so the project's local "today" is inside the window even east of UTC.
  const to = new Date(Date.now() + 86_400_000);
  const from = new Date(to.getTime() - 13 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** What the native host last reported for this thread (the observation, not the ledger), when there is one. */
export interface NativeUsage { inputTokens: number | null; outputTokens: number | null; current: boolean }

/** One agent's context and use, from the usage read. */
export function SessionUsageView({ usage, sessionId, projectId, nativeUsage = null, stale = false }: {
  usage: UsageOverview; sessionId: string; projectId: string; nativeUsage?: NativeUsage | null; stale?: boolean;
}) {
  const session = usage.sessions.find(item => item.sessionId === sessionId) ?? null;
  const gauge = contextGauge(session?.context);
  const tiles = todayTiles(session);
  const reminder = budgetReminder(usage.budget);
  return <div className="flex min-w-0 flex-col gap-2.5">
    <div className="session-context flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3 className="text-label font-semibold text-foreground">上下文</h3>
        <StatusTag tone={gauge.tone} label={gauge.status} />
      </div>
      {gauge.ratio !== null && <div role="progressbar" aria-label="上下文占交接阈值" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(gauge.ratio * 100)} className="h-1.5 w-full overflow-hidden rounded-full bg-field">
        <div className={cn("h-full rounded-full", bar[gauge.tone] ?? "bg-primary")} style={{ width: `${Math.max(2, Math.round(gauge.ratio * 100))}%` }} />
      </div>}
      <p className="text-caption text-text-secondary tabular-nums">{gauge.detail}</p>
      {gauge.handoff && <Notice tone="waiting" title="请交接新线程" className="mt-1">
        上下文已到交接阈值：普通结果通知会留在队列里暂停，业务任务的运行不受影响。请用同一职责开新线程，并在交接里写明原智能体、原线程和固定任务。
        {" "}<a className="text-primary hover:underline" href={href(projectId, "runtime")}>去分工与运行</a>
      </Notice>}
    </div>
    <div className="session-usage-today flex min-w-0 flex-col gap-1">
      <h3 className="text-label font-semibold text-foreground">今日</h3>
      {tiles ? <dl className="grid min-w-0 grid-cols-4 gap-1.5">{tiles.map(tile => <div key={tile.label} className="flex min-w-0 flex-col gap-0.5 rounded-md bg-raised px-1.5 py-1.5">
        <dt className="text-caption text-muted-foreground">{tile.label}</dt>
        <dd className="m-0 truncate text-small font-medium text-foreground tabular-nums">{tile.value}</dd>
      </div>)}</dl> : <p className="text-small text-text-secondary">{session ? "今日没有用量记录，不按 0 计" : "这个智能体还没有用量记录，不按 0 计"}</p>}
    </div>
    {reminder && <p className={cn("text-caption [overflow-wrap:anywhere]", reminder.tone === "blocked" ? "text-destructive" : "text-warning")}>
      {reminder.text} · <a className="text-primary hover:underline" href={href(projectId, "sessions")}>去统筹安排</a></p>}
    {(session?.recorded || nativeUsage) && <details className="min-w-0 text-caption text-text-secondary">
      <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">本会话累计</summary>
      <div className="mt-1 flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
        {session?.recorded && <p>记账：{usageDayText(session.total)}</p>}
        {nativeUsage && <p>原生回报（这条线程）：输入 {tokenText(nativeUsage.inputTokens)} · 输出 {tokenText(nativeUsage.outputTokens)}{nativeUsage.current ? "" : "（上次记录）"}</p>}
        <p className={mutedText}>读于 {date(usage.observedAt)}</p>
      </div>
    </details>}
    {stale && <p className={mutedText}>上次读回，当前待核对。</p>}
  </div>;
}

export function SessionUsagePanel({ projectId, token, sessionId, nativeUsage = null }: {
  projectId: string; token: string; sessionId: string; nativeUsage?: NativeUsage | null;
}) {
  const { from, to } = range();
  const read = useProjectQuery(projectId, ["runtime", "usage", from, to],
    async () => {
      const value = await runtimeClient(token, projectId).usage(from, to);
      if (!value || !Array.isArray(value.sessions) || !value.budget) throw new Error("用量响应不完整");
      return value;
    }, { refetchInterval: 60_000 });
  return <section aria-label="上下文与用量" className={`session-usage ${card}`}>
    <h2 className="text-label font-semibold text-foreground">上下文与用量</h2>
    {read.isError && !read.data ? <Notice tone="error">用量暂不可读取：{read.error instanceof Error ? read.error.message : "读取失败"}。上下文和今日用量暂时无法判断。</Notice>
      : !read.data ? <p role="status" className={mutedText}>正在读取上下文与用量…</p>
        : <SessionUsageView usage={read.data} sessionId={sessionId} projectId={projectId} nativeUsage={nativeUsage} stale={read.stale} />}
  </section>;
}
