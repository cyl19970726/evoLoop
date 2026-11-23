import * as React from "react";
import { useEffect, useState } from "react";
import { Button, Select, cn } from "@evoloop/ui";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import type { Goal, Stage } from "@evoloop/contracts";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import { ArrowRight, Target } from "lucide-react";
import { api, errorText } from "../../shared/api";
import { date, href } from "../../shared/ui/shared";
import { appendLeaderWorkPage, loadLeaderWorkStatuses } from "../../shared/leaderWorkLoad";
import type { WorkTaskStatus } from "../../shared/workStatusPresentation";
import { isRoleOwnerId } from "../../shared/ownerRole";
import { RoleName } from "../../shared/ui/RecordName";
import { readOutcome, type ProjectOutcome } from "./contextPresentation";
import { VersionFold } from "./MilestonesBlock";
import { FoldLine, OrganisationLine, OutcomeBlock, PriorityBlock, UseBlock } from "./OverviewTop";
import { feedbackCandidates, longestStall, organisationText, priorityLimit, stalledTasks } from "./overviewFirstScreen";
import { StageLabel, StagesBlock, useStageLabelOf, useStageProjection } from "../stages";
import { readOverviewParam, writeOverviewParam } from "./overviewAddress";

interface ContextSnapshot {
  scope: string; goals: Goal[]; stages: Stage[]; goalProblem: string; workProblem: string;
  rows: LeaderWorkTask[]; counts?: Record<string, number>; statuses: Record<string, WorkTaskStatus>; complete: boolean; goalsComplete: boolean;
  outcomes: ProjectOutcome[]; useReadCount: number; useCandidateCount: number; useFailures: number; observedAt: string;
  goalObservedAt?: string; workObservedAt?: string; useObservedAt?: string;
  retainedGoals?: boolean; retainedWork?: boolean; retainedUse?: boolean;
}
export function ProjectContext({ token, projectId, actorId, refresh, active, flowGlance }: { token: string; projectId: string; actorId: string; refresh: number; active: boolean; flowGlance?: React.ReactNode }) {
  const scope = `${projectId}:${token}`;
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);
  const [selection, setSelection] = useState<{scope: string; id: string} | null>(() => { const id = readOverviewParam("stage"); return id ? { scope: `${projectId}:${token}`, id } : null; });
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (!active) return;
    let current = true; setReading(true);
    const client = api(token);
    void (async () => {
      const value: ContextSnapshot = { scope, goals: [], stages: [], goalProblem: "", workProblem: "", rows: [], statuses: {}, complete: false,
        goalsComplete: false, outcomes: [], useReadCount: 0, useCandidateCount: 0, useFailures: 0, observedAt: new Date().toISOString() };
      await Promise.allSettled([
        (async () => {
          try {
            let cursor: string | undefined; const seen = new Set<string>();
            for (let n = 0; n < 10; n++) {
              const page = await client.goals(projectId, cursor);
              if (!current) return;
              if (page.items.some(goal => goal.projectId !== projectId)) throw new Error("目标响应不属于当前项目");
              if (page.items.length > 50 || value.goals.length + page.items.length > 500 || page.items.some(goal => value.goals.some(known => known.id === goal.id))) throw new Error("目标分页重复或超出读取范围");
              value.goals.push(...page.items);
              if (!page.nextCursor) { value.goalsComplete = true; break; }
              if (seen.has(page.nextCursor)) throw new Error("目标分页游标重复");
              seen.add(page.nextCursor); cursor = page.nextCursor;
            }
            value.stages = await client.stages(projectId);
            if (value.stages.some(stage => stage.projectId !== projectId)) throw new Error("阶段响应不属于当前项目");
          } catch (cause) { value.goalProblem = errorText(cause); }
        })(),
        (async () => {
          try {
            let page = await client.leaderWork(projectId, "tasks", undefined, true) as LeaderWorkPage<LeaderWorkTask>;
            value.counts = page.counts;
            const seen = new Set<string>();
            while (current && page.nextCursor && page.items.length < 500) {
              if (seen.has(page.nextCursor)) throw new Error("工作分页游标重复");
              seen.add(page.nextCursor);
              page = appendLeaderWorkPage(page, await client.leaderWork(projectId, "tasks", page.nextCursor, true) as LeaderWorkPage<LeaderWorkTask>);
            }
            if (!current) return;
            value.rows = page.items;
            value.complete = !page.nextCursor && !page.partial;
            const kinds = await loadLeaderWorkStatuses(page.items.map(row => row.taskId), async ids => (await client.workStatuses(projectId, ids)).items);
            value.statuses = Object.fromEntries(kinds.statuses.map(item => [item.taskId, item]));
            if (kinds.missing.length) value.workProblem = "部分工作的来源分类未读全";
            // The three most recently registered feedbacks: by the work index's own feedback time per Task, not by the Task revision's time.
            const candidates = feedbackCandidates(page.items.filter(row => value.statuses[row.taskId]?.cognition === false && row.delivery?.observationResult));
            value.useCandidateCount = candidates.length;
            // A candidate whose detail cannot be read still counts as a failed read; keep reading until three are in hand or the candidates run out (at most 12).
            for (let start = 0; current && start < Math.min(12, candidates.length) && value.outcomes.length < priorityLimit; start += 3) {
              const batch = candidates.slice(start, Math.min(start + 3, 12));
              const reads = await Promise.allSettled(batch.map(async row => {
                const detail = await client.task(projectId, row.taskId);
                if (detail.task.projectId !== projectId) throw new Error("使用来源不属于当前项目");
                const outcome = readOutcome(row, detail);
                if (!outcome) throw new Error("使用来源已变化，需重新核对");
                return outcome;
              }));
              for (const read of reads) { value.useReadCount++; if (read.status === "fulfilled") value.outcomes.push(read.value); else value.useFailures++; }
            }
            value.outcomes.sort((a, b) => Date.parse(b.observation.createdAt) - Date.parse(a.observation.createdAt));
          } catch (cause) { value.workProblem = errorText(cause); }
        })(),
      ]);
      value.observedAt = new Date().toISOString();
      if (!value.goalProblem) value.goalObservedAt = value.observedAt;
      if (!value.workProblem) value.workObservedAt = value.observedAt;
      if (!value.workProblem && !value.useFailures) value.useObservedAt = value.observedAt;
      if (current) setSnapshot(previous => {
        if (previous?.scope !== scope) return value;
        if (value.goalProblem) {
          value.goals = previous.goals; value.stages = previous.stages;
          value.goalsComplete = previous.goalsComplete;
          value.goalObservedAt = previous.goalObservedAt; value.retainedGoals = true;
        }
        if (value.workProblem && !value.rows.length) {
          value.rows = previous.rows; value.statuses = previous.statuses; value.counts = previous.counts;
          value.complete = previous.complete;
          value.workObservedAt = previous.workObservedAt; value.retainedWork = true;
        }
        if ((value.workProblem || value.useFailures) && !value.outcomes.length && previous.outcomes.length) {
          value.outcomes = previous.outcomes;
          value.useObservedAt = previous.useObservedAt; value.retainedUse = true;
        }
        return value;
      });
    })().finally(() => { if (current) setReading(false); });
    return () => { current = false; };
  }, [token, projectId, scope, refresh, active]);
  const value = snapshot?.scope === scope ? snapshot : null;
  const stages = value?.stages.filter(stage => stage.state === "active") ?? [];
  const stage = stages.length === 1 ? stages[0] : stages.find(item => selection?.scope === scope && item.id === selection.id);
  const goal = stage ? value?.goals.find(item => item.id === stage.goalId) : value?.goals.length === 1 ? value.goals[0] : undefined;
  const card = "flex min-w-0 flex-col gap-2 rounded-xl bg-raised px-4 py-3 border border-border compact:p-5";
  const muted = "text-caption text-muted-foreground";
  const problem = "rounded-lg bg-warning-soft px-3 py-2 text-caption text-text-secondary";
  const title = (icon: React.ReactNode, text: string, link?: React.ReactNode) => <div className="flex items-center gap-2 text-text-secondary">
    <span aria-hidden="true" className="[&_svg]:size-4">{icon}</span><h2 className="text-label font-semibold text-foreground">{text}</h2>{link}
  </div>;
  const choose = (id: string) => { setSelection({ scope, id }); if (active) writeOverviewParam("stage", id); };
  // A stage is named by its short name and due date (the stage projection); one without a short name keeps the first line of its text.
  const projection = useStageProjection(projectId, active);
  const labelOf = useStageLabelOf(projectId, active);
  const nameOf = (item: Stage) => labelOf(item).name;
  const stageButton = (item: Stage) => <Button variant="row" key={item.id} aria-pressed={stage?.id === item.id} onClick={() => choose(item.id)}
    className="rounded-lg px-3 py-2 text-small aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-foreground">
    <span title={item.deliverable} className="block min-w-0"><StageLabel {...labelOf(item)} /></span>
  </Button>;
  // The left list: one line per stage, the stage the service calls 当前 drawn as a selected item; a click lands on that stage's row in 目标与阶段.
  const railLink = (item: Stage) => <a key={item.id} href={`${href(projectId, "journey")}?stage=${item.id}`} data-rail-stage={item.id}
    aria-current={projection.data?.currentStageId === item.id ? "true" : undefined}
    className="selected-mark block rounded-lg px-3 py-2 text-small text-text-secondary hover:bg-selected hover:text-foreground focus-visible:shadow-[var(--focus-ring)] outline-none">
    <span title={item.deliverable} className="block min-w-0"><StageLabel {...labelOf(item)} /></span>
  </a>;
  const now = Date.now();
  const stalled = value ? stalledTasks(value.rows, now) : [];
  const work = !value ? "reading" as const : value.workProblem ? "failed" as const : "ready" as const;
  const outcomeState = !value ? "reading" as const : (value.workProblem || value.useFailures) && !value.outcomes.length ? "failed" as const : "ready" as const;
  const goalTitle = goal?.outcome ?? (stages.length > 1 ? `当前有 ${stages.length} 个正在推进的阶段` : reading && !value ? "正在核对项目目标…" : value?.goalProblem ? "目标与阶段暂未核对完整" : value?.goals.length ? "项目有多个目标，请进入目标与阶段核对" : "项目目标尚未读回或登记");
  return <section data-ui="" className="project-context flex flex-col gap-3" aria-label="首屏：要你处理的、使用与结果、阶段" aria-busy={reading}>
    {stages.length > 1 && <ContextRailContent>
      <nav aria-label="正在推进的阶段" className="flex flex-col gap-0.5 pt-2">
        <span className="px-3 pb-1.5 pt-2 text-caption text-muted-foreground">正在推进的阶段 · {stages.length}</span>
        {stages.map(railLink)}
      </nav>
    </ContextRailContent>}
    <PriorityBlock projectId={projectId} actorId={actorId} enabled={active && !!actorId} stalled={stalled} work={work} />
    <UseBlock projectId={projectId} actorId={actorId} enabled={active && !!actorId} />
    <OutcomeBlock projectId={projectId} outcomes={value?.outcomes ?? []} state={outcomeState} />
    {value?.retainedUse && <p className={problem}>结果是否有效显示的是上次核对的反馈，读于 {value.useObservedAt ? date(value.useObservedAt) : "上次读取"}；本次尚未确认它仍是当前交付。</p>}
    <div className="@container border-t border-border pt-3"><StagesBlock projectId={projectId} active={active} /></div>
    <OrganisationLine text={value ? organisationText(value.counts, longestStall(value.rows, now)) : "组织自己在处理：正在读取"}>{flowGlance}</OrganisationLine>
    <FoldLine label="当前目标" summary={`目标：${goalTitle}`} data-overview-goal="">
    <section className={cn(card, "overview-goal")} aria-label="当前目标">
      {title(<Target />, "当前目标", <a href={href(projectId, "journey")} className="ml-auto flex items-center gap-1 text-caption text-text-secondary hover:text-foreground">目标与阶段 <ArrowRight size={13} aria-hidden="true" /></a>)}
      <h3 className="line-clamp-2 text-heading font-semibold text-foreground compact:line-clamp-none" title={goal?.outcome}>{goal?.outcome ?? (stages.length > 1 ? `当前有 ${stages.length} 个正在推进的阶段` : reading && !value ? "正在核对项目目标…" : value?.goalProblem ? "目标与阶段暂未核对完整" : value?.goals.length ? "项目有多个目标，请进入目标与阶段核对" : "项目目标尚未读回或登记")}</h3>
      {/* The inner rail is hidden below 1100px or when folded, so the card always offers every active stage. */}
      {!stage && stages.length > 1 && <details className="text-small" data-stage-picker=""><summary className="cursor-pointer text-text-secondary">选一个阶段阅读（{stages.length} 个正在推进）</summary><div className="mt-2 flex flex-col gap-1">{stages.map(item => <div key={item.id} className="rounded-lg bg-field">{stageButton(item)}<span className="block px-3 pb-2 text-caption text-muted-foreground">{value?.goals.find(entry => entry.id === item.goalId)?.outcome ?? "目标名称尚未核对"}</span></div>)}</div></details>}
      {stage && stages.length > 1 && <label className="flex flex-col gap-1">
        <span className={muted}>切换阶段 · 共 {stages.length} 个正在推进</span>
        <Select className="w-full" value={stage.id} onChange={event => choose(event.target.value)}>
          {stages.map(item => <option key={item.id} value={item.id}>{nameOf(item)}</option>)}
        </Select>
      </label>}
      {stage ? <dl className="grid grid-cols-2 gap-x-3 gap-y-1 compact:gap-3">
        <div><dt className={muted}>阶段交付</dt><dd className="m-0 line-clamp-1 text-small text-foreground compact:line-clamp-none">{stage.deliverable}</dd></div>
        <div><dt className={muted}>要弄清的问题</dt><dd className="m-0 line-clamp-1 text-small text-foreground compact:line-clamp-none">{stage.learningQuestion}</dd></div>
      </dl> : <p className={muted}>{value && !value.goalProblem && stages.length === 0 ? "没有读到正在推进的阶段。可与现有责任智能体明确首项工作、消费者和需要补的证据。" : "按真实阶段关系阅读，不从最近任务或队列推定项目目标。"}</p>}
      {goal && <details className="text-small"><summary className="cursor-pointer text-text-secondary">目标全文、消费者、约束与范围</summary><div className="mt-2 flex flex-col gap-1 text-text-secondary"><p className="compact:hidden">目标：{goal.outcome}</p><p>消费者：{goal.consumer} · 责任：{isRoleOwnerId(goal.owner) ? <RoleName projectId={projectId} roleId={goal.owner} /> : goal.owner}</p><p>{goal.constraints}</p><p>{goal.scope}</p></div></details>}
      {value?.goalProblem && <div className={problem} role="status">目标与阶段读取未完成，已读工作仍可查看。<details><summary className="cursor-pointer">读取原因</summary>{value.goalProblem}</details></div>}
      {value?.retainedGoals && <p className={problem}>保留上次目标与阶段，读于 {value.goalObservedAt ? date(value.goalObservedAt) : "上次读取"}，本次未能确认最新状态。</p>}
      {value && !value.goalsComplete && <p className={muted}>目标列表仅覆盖已读部分。</p>}
    </section>
    </FoldLine>
    <VersionFold projectId={projectId} active={active} />
    <p className={muted}>{value ? `目标与证据读于 ${date(value.observedAt)}${reading ? " · 正在重新核对" : ""}` : "目标与使用证据尚未读回"}。各来源分别读取，完整依据在原对象中查阅。</p>
  </section>;
}
