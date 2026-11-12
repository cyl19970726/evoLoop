// 项目用量 on 统筹安排 (docs/frontend/pages/sessions.md): the project's use against its daily limit (the same bar as an
// agent's context), the latest seven days one row each in 万, and the time zone “today” is counted in, in small print.
// These facts belong to the project, not to one agent; an agent's card only links here (#project-usage) when the
// project is close to or at its limit. A missing count is 未知 and a missing cost 未报告, never 0.
import { useEffect, useRef } from "react";
import type { UsageOverview } from "@evoloop/contracts";
import { Notice, StatusTag } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { mutedText } from "../../shared/ui/PageParts";
import { date } from "../../shared/ui/shared";
import { UsageBar, projectUsageAnchor, useUsageRead } from "./UsageBudgetPanel";
import { projectBudgetGauge, projectToday, recentProjectDays } from "./usagePresentation";

const heading = "text-label font-semibold text-foreground";
const cell = "px-2 py-1.5 text-right tabular-nums first:pl-0 first:text-left last:pr-0";

export function ProjectUsageSection({ projectId, token }: { projectId: string; token: string }) {
  const read = useUsageRead(projectId, token);
  const ref = useRef<HTMLElement | null>(null);
  // Arriving from an agent's reminder (…/sessions#project-usage): scroll here once the figures are on screen.
  useEffect(() => {
    if (read.data && typeof window !== "undefined" && window.location.hash === `#${projectUsageAnchor}`) ref.current?.scrollIntoView({ block: "start" });
  }, [!!read.data]);
  return <section ref={ref} id={projectUsageAnchor} aria-labelledby="arrangement-usage" className="flex scroll-mt-4 flex-col gap-2">
    <h2 id="arrangement-usage" className={heading}>项目用量</h2>
    <ProjectUsageView usage={read.data ?? null} error={read.isError && !read.data ? errorText(read.error) : null} stale={read.stale} />
  </section>;
}

/** The block's body for one usage read: reading, failed, or the limit, the days and the time zone. */
export function ProjectUsageView({ usage, error = null, stale = false }: { usage: UsageOverview | null; error?: string | null; stale?: boolean }) {
  const today = usage ? projectToday(usage.observedAt, usage.timeZone) : null;
  // Today counts as recorded only when the service lists a ledger row for it; without a usable today, as before.
  const gauge = usage ? projectBudgetGauge(usage.budget, today ? usage.daily.some(day => day.day === today) : null) : null;
  const days = usage ? recentProjectDays(usage.daily, today) : [];
  return <div className="flex min-w-0 flex-col gap-3 rounded-xl bg-raised px-4 py-3 shadow-sm">
      {error ? <Notice tone="error">项目用量暂不可读取：{error}。每日上限和近几天用量暂时无法判断。</Notice>
        : !usage || !gauge ? <p role="status" className={mutedText}>正在读取项目用量…</p>
          : <>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <h3 className={heading}>今日与每日上限</h3>
                <StatusTag tone={gauge.tone} label={gauge.status} />
              </div>
              {gauge.ratio !== null && <UsageBar ratio={gauge.ratio} tone={gauge.tone} label="项目今日用量占每日上限" valueText={gauge.exact ? `${Math.round(gauge.ratio * 100)}%，${gauge.exact}` : null} />}
              {/* The line shows the amounts rounded (33 亿 / 40 亿); the exact used amount and limit are its tooltip and its screen-reader text. */}
              <p className="text-caption text-text-secondary tabular-nums" data-project-limit-line="" {...(gauge.exact ? { title: gauge.exact } : {})}>
                {gauge.detail}{gauge.exact && <span className="sr-only">（{gauge.exact}）</span>}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className={heading}>近 7 天</h3>
              {days.some(day => day.recorded) ? <div className="min-w-0 overflow-x-auto">
                <table className="w-full min-w-[300px] text-small">
                  <thead><tr className="border-b border-border text-caption text-muted-foreground">
                    <th scope="col" className={`${cell} font-normal`}>日期</th><th scope="col" className={`${cell} font-normal`}>输入</th>
                    <th scope="col" className={`${cell} font-normal`}>输出</th><th scope="col" className={`${cell} font-normal`}>缓存输入</th>
                    <th scope="col" className={`${cell} font-normal`}>费用</th>
                  </tr></thead>
                  <tbody>{days.map(day => <tr key={day.day} className="border-b border-border last:border-b-0">
                    <th scope="row" className={`${cell} font-normal text-text-secondary`}>{day.day.slice(5)}</th>
                    {/* A day the service lists no ledger rows for had no record: said, never shown as 0. */}
                    {day.recorded ? <><td className={cell} title={day.inputFull ?? undefined}>{day.input}</td><td className={cell} title={day.outputFull ?? undefined}>{day.output}</td><td className={cell} title={day.cachedFull ?? undefined}>{day.cached}</td><td className={cell}>{day.cost}</td></>
                      : <td colSpan={4} className={`${cell} text-muted-foreground`}>没有记录</td>}
                  </tr>)}</tbody>
                </table>
              </div> : <p className="text-small text-text-secondary">近 7 天没有用量记录，不按 0 计。</p>}
            </div>
            <p className={mutedText}>按 {usage.timeZone} 计日 · 读于 {date(usage.observedAt)}{stale ? " · 上次读回，当前待核对" : ""}</p>
          </>}
  </div>;
}
