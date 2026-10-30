import { useEffect, useState } from "react";
import type { Goal, Stage } from "@evoloop/contracts";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import { ArrowRight, Flag, MessageSquare, Target } from "lucide-react";
import { api, errorText } from "../api";
import { date, href } from "../ui/shared";
import { appendLeaderWorkPage, leaderPhaseLabel, loadLeaderWorkStatuses } from "../workflow/leaderWorkLoad";
import type { WorkTaskStatus } from "../workflow/workStatusPresentation";
import { readOutcome, selectAttention, type ProjectOutcome } from "./contextPresentation";
import "./overview.css";

interface ContextSnapshot {
  scope: string; goals: Goal[]; stages: Stage[]; goalProblem: string; workProblem: string;
  rows: LeaderWorkTask[]; statuses: Record<string, WorkTaskStatus>; complete: boolean; goalsComplete: boolean;
  outcomes: ProjectOutcome[]; useReadCount: number; useCandidateCount: number; useFailures: number; observedAt: string;
  goalObservedAt?: string; workObservedAt?: string; useObservedAt?: string;
  retainedGoals?: boolean; retainedWork?: boolean; retainedUse?: boolean;
}
export function ProjectContext({ token, projectId, refresh, active }: { token: string; projectId: string; refresh: number; active: boolean }) {
  const scope = `${projectId}:${token}`;
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);
  const [selection, setSelection] = useState<{scope: string; id: string} | null>(null);
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
            const candidates = page.items.filter(row => value.statuses[row.taskId]?.cognition === false && row.delivery?.observationResult)
              .sort((a, b) => Date.parse(b.dates.businessChangedAt) - Date.parse(a.dates.businessChangedAt));
            value.useCandidateCount = candidates.length;
            for (let start = 0; current && start < Math.min(6, candidates.length); start += 3) {
              const batch = candidates.slice(start, Math.min(start + 3, 6));
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
          value.rows = previous.rows; value.statuses = previous.statuses;
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
  const attention = value ? selectAttention(value.rows, value.statuses) : null;
  const use = value?.outcomes[0];
  return <section className="project-context" aria-label="目标、当前取舍与使用反馈" aria-busy={reading}>
    <section className="overview-goal">
      <div className="overview-section-title"><Target size={18} aria-hidden="true" /><h2>当前目标</h2><a href={href(projectId, "journey")}>目标与阶段 <ArrowRight size={14} /></a></div>
      {stages.length > 1 && <label className="overview-stage-select">选择正在推进的阶段<select value={stage?.id ?? ""} onChange={e => setSelection({scope, id:e.target.value})}><option value="">{stages.length} 个阶段，选择阅读</option>{stages.map(item => <option key={item.id} value={item.id}>{item.deliverable}</option>)}</select></label>}
      <h3>{goal?.outcome ?? (stages.length > 1 ? `当前有 ${stages.length} 个正在推进的阶段` : reading && !value ? "正在核对项目目标…" : value?.goalProblem ? "目标与阶段暂未核对完整" : value?.goals.length ? "项目有多个目标，请进入目标与阶段核对" : "项目目标尚未读回或登记")}</h3>
      {!stage && stages.length > 1 && <ul className="overview-stage-contexts">{stages.slice(0,3).map(item => <li key={item.id}><strong>{value?.goals.find(goal => goal.id === item.goalId)?.outcome ?? "目标名称尚未核对"}</strong><span>{item.deliverable}</span></li>)}</ul>}
      {stage ? <details className="overview-stage-details"><summary>阶段交付与学习问题</summary><dl className="overview-goal-facts"><div><dt>阶段交付</dt><dd>{stage.deliverable}</dd></div><div><dt>要弄清的问题</dt><dd>{stage.learningQuestion}</dd></div></dl></details> : <p className="muted">{value && !value.goalProblem && stages.length === 0 ? "没有读到正在推进的阶段。可与现有责任 Agent 明确首项工作、消费者和需要补的证据。" : "按真实阶段关系阅读，不从最近任务或队列推定项目目标。"}</p>}
      {goal && <details><summary>目标的消费者、约束与范围</summary><p>消费者：{goal.consumer} · 责任：{goal.owner}</p><p>{goal.constraints}</p><p>{goal.scope}</p></details>}
      {value?.goalProblem && <div className="overview-read-problem" role="status"><p>目标/阶段读取未完成，已读工作仍可查看。</p><details><summary>读取原因</summary>{value.goalProblem}</details></div>}
      {value?.retainedGoals && <p className="overview-read-problem">保留上次目标与阶段，读于 {value.goalObservedAt ? date(value.goalObservedAt) : "上次读取"}，本次未能确认最新状态。</p>}
      {value && !value.goalsComplete && <p className="muted">目标列表仅覆盖已读部分。</p>}
    </section>
    <div className="overview-evidence-grid">
      <section className="overview-attention"><div className="overview-section-title"><Flag size={17} aria-hidden="true" /><h2>本次优先核对</h2></div>
        {attention ? <><span className="pill">{leaderPhaseLabel[attention.phase]}</span><h3><a href={href(projectId, "task", attention.taskId)}>{attention.title}</a></h3><p>{attention.nextAction}</p><p className="muted">下一责任：{attention.responsible.label}</p>{attention.review?.decision === "deferred" && <details><summary>已暂缓的原因</summary><p>{attention.review.reason}</p></details>}<a className="overview-text-action" href={`${href(projectId, "task", attention.taskId)}${attention.delivery ? "?tab=delivery" : ""}`}>{attention.delivery ? "核对交付与使用" : "查看当前工作"} <ArrowRight size={14} /></a></> : <p>{!value || reading ? "正在核对当前工作…" : value.workProblem || !value.complete ? "已读范围尚不能确定当前需核对事项，请进入任务列表。" : "已读工作中没有未关闭的业务任务。"}</p>}
        {value?.workProblem && <details className="overview-read-problem"><summary>工作来源或使用回读存在缺项</summary>{value.workProblem}</details>}
        {value?.retainedWork && <p className="overview-read-problem">以上为上次工作，读于 {value.workObservedAt ? date(value.workObservedAt) : "上次读取"}，请回原任务核对当前状态。</p>}
      </section>
      <section className="overview-use"><div className="overview-section-title"><MessageSquare size={17} aria-hidden="true" /><h2>最近使用反馈</h2></div>
        {use ? <><span className="pill">{use.observation.observerKind === "human" ? "真人" : "Agent"} · {({used:"已使用",failed:"使用失败",notUsed:"未使用"} as const)[use.observation.result]}</span><h3><a href={`${href(projectId, "task", use.taskId)}?tab=delivery`}>{use.title}</a></h3><p>{use.observation.reason.slice(0,200)}{use.observation.reason.length > 200 ? "…" : ""}</p><p className="muted">{use.observation.observer} · {date(use.observation.createdAt)}<br />本次技术检查：{use.delivery.technicalResult === "passed" ? "通过" : "失败"}</p><details><summary>实际使用的完整证据</summary><p>{use.observation.evidence}</p><p>{use.observation.reason}</p></details></> : <p>{!value || reading ? "正在核对当前交付的使用…" : value.workProblem || value.useFailures ? "当前交付的使用来源未能核实。请到原任务核对；读取失败不代表没有使用。" : "已读范围尚无可展示的当前交付使用观察。技术通过和任务关闭都不替代实际使用。"}</p>}
        {value?.retainedUse && <p className="overview-read-problem">保留上次核对的反馈，读于 {value.useObservedAt ? date(value.useObservedAt) : "上次读取"}；本次尚未确认它仍是当前交付。</p>}
        {value && <p className="overview-source-note">从最近变化的{value.useReadCount}项已登记使用的交付核对；已读工作中共{value.useCandidateCount}项候选{value.useFailures ? `，${value.useFailures}项来源未核实` : ""}。{!value.complete ? "工作索引未完整读取。" : ""}</p>}
      </section>
    </div>
    <p className="overview-source-note">{value ? `目标与证据读于 ${date(value.observedAt)}${reading ? " · 正在重新核对" : ""}` : "目标与使用证据尚未读回"}。各来源分别读取，完整依据与后续判断在原对象中查阅。</p>
  </section>;
}
