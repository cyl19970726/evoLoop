// 目标与阶段, first screen (docs/frontend/milestones-design.md §4): the same table as the 总览 with the full 怎样算到了; a row opens in place (`?stage=<id>`) to its Tasks
// by state, its latest review, how to tell it is reached and which ladder levels it fills. Below the table: the open Tasks that belong to no stage (each with a
// select that files it under a stage, `task.stage.set`), how many are explicitly outside any stage, the verification ladder, and the folded 已回看的阶段.
import * as React from "react";
import { hasPermission } from "@evoloop/contracts";
import type { StageProjection, StageProjectionStage } from "@evoloop/contracts/stage-projection";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { ChevronRight } from "lucide-react";
import { Select } from "@evoloop/ui";
import { onNavigate } from "../../shared/navigation";
import { useCommand, type MutationContext } from "../../shared/command";
import { date, href } from "../../shared/ui/shared";
import { LadderRow } from "./LadderView";
import { StageTable } from "./StageTable";
import { NO_REVIEW, nextChoiceLabel, NOT_REGISTERED, NO_STAGES, groupTasks, isUnowned, stageName, stageRows, unownedLine } from "./stagesPresentation";

const muted = "text-caption text-muted-foreground";
const fold = "group text-small";
const foldSummary = "flex w-fit cursor-pointer list-none items-center gap-1.5 text-label font-medium text-text-secondary outline-none hover:text-foreground focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden";

export interface StagesSectionProps {
  context: MutationContext; active: boolean; projection: StageProjection;
  deliverables: ReadonlyMap<string, string>;
  work: { items: LeaderWorkTask[]; complete: boolean } | undefined;
  openId: string | null; onToggle(id: string): void;
  /** After a Task is filed under a stage: the page rereads its own project queries. */
  onApplied(): void; propose: boolean;
}

/** One open Task with no stage: a select that files it under an active stage. The command is `task.stage.set`; the row leaves the area when the reread shows it owned. */
function AssignRow({ context, task, options, onApplied }: { context: MutationContext; task: LeaderWorkTask; options: Array<{ id: string; name: string }>; onApplied(): void }) {
  const command = useCommand(context, undefined);
  const allowed = hasPermission(context.principal, context.projectId, "task");
  const reread = () => { context.onChanged(); onApplied(); };
  const choose = (stageId: string) => { if (stageId) void command.submit(() => ({ type: "task.stage.set", taskId: task.taskId, stageId, reason: "在目标与阶段页归到阶段" }), reread); };
  const hint = `${task.taskId}-assign-hint`;
  return <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2 first:border-t-0" data-unowned-task={task.taskId}>
    <a href={href(context.projectId, "task", task.taskId)} className="min-w-0 flex-1 text-small text-foreground [overflow-wrap:anywhere] hover:underline">{task.title}</a>
    <label className="flex items-center gap-2"><span className={muted}>归到阶段</span>
      <Select aria-label={`把「${task.title}」归到阶段`} aria-describedby={allowed ? undefined : hint} className="w-48 max-w-full" value="" disabled={!allowed || command.busy || !options.length} onChange={event => choose(event.target.value)}>
        <option value="">选一个阶段…</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</Select></label>
    {!allowed && <p id={hint} className={`m-0 basis-full ${muted}`}>这个身份没有任务写权限，不能归阶段。</p>}
    {!options.length && allowed && <p className={`m-0 basis-full ${muted}`}>现在没有已接受的阶段可以选。</p>}
    {command.outcome && !command.outcome.applied && <p role="status" className={`m-0 basis-full ${muted}`}>{command.outcome.message}</p>}
  </li>;
}

/** What opens under a row: Tasks by state (links), the latest review, the check method in full, the ladder levels it fills. */
function StageDetail({ projectId, stage, tasks, workComplete }: { projectId: string; stage: StageProjectionStage; tasks: LeaderWorkTask[] | null; workComplete: boolean }) {
  const review = stage.latestReview;
  return <div className="flex flex-col gap-3 pt-1 text-small">
    <section aria-label="任务" className="flex flex-col gap-1">
      <h3 className="text-label font-semibold text-foreground">任务 · {stage.tasks.total}</h3>
      {tasks === null ? <p className={`m-0 ${muted}`}>任务正在读取，或没有读回。</p>
        : !tasks.length ? <p className="m-0 text-text-secondary">{stage.tasks.total ? "已读的任务里没有这个阶段的，任务没有读全。" : "还没有任务。"}</p>
        : groupTasks(tasks).map(group => <div key={group.bucket} data-task-group={group.bucket}>
          <p className={`m-0 ${muted}`}>{group.label} {group.tasks.length}</p>
          <ul className="m-0 flex list-none flex-col p-0">{group.tasks.map(task => <li key={task.taskId}><a className="text-foreground hover:underline [overflow-wrap:anywhere]" href={href(projectId, "task", task.taskId)}>{task.title}</a></li>)}</ul></div>)}
      {tasks !== null && !workComplete && <p className={`m-0 ${muted}`}>任务只读了一部分。</p>}
    </section>
    <section aria-label="最新回看" className="flex flex-col gap-0.5">
      <h3 className="text-label font-semibold text-foreground">最新回看</h3>
      {review ? <>
        <p className="m-0"><span className={muted}>采纳　</span>{review.adopted}</p>
        <p className="m-0"><span className={muted}>拒绝　</span>{review.rejected}</p>
        <p className="m-0"><span className={muted}>缺口　</span>{review.gap}</p>
        <p className="m-0"><span className={muted}>下一步　</span>{nextChoiceLabel[review.nextChoice]} · {date(review.createdAt)} · <a className="text-primary hover:underline" href={`#review-${review.id}`}>回看原文</a></p>
      </> : <p className="m-0 text-text-secondary">{NO_REVIEW}</p>}
    </section>
    <section aria-label="检查办法" className="flex flex-col gap-0.5">
      <h3 className="text-label font-semibold text-foreground">检查办法</h3>
      <p className="m-0 whitespace-pre-wrap text-text-secondary [overflow-wrap:anywhere]">{stage.checkMethod?.trim() || NOT_REGISTERED}</p>
    </section>
    <section aria-label="补哪一级" className="flex flex-col gap-0.5">
      <h3 className="text-label font-semibold text-foreground">补哪一级</h3>
      <p className="m-0 text-text-secondary">{stage.ladderKeys.length ? stage.ladderKeys.join("、") : NOT_REGISTERED}</p>
    </section>
  </div>;
}

export function StagesSection({ context, active, projection, deliverables, work, openId, onToggle, onApplied, propose }: StagesSectionProps) {
  const projectId = context.projectId;
  const rows = stageRows(projection);
  const journey = href(projectId, "journey");
  const hrefFor = (stage: StageProjectionStage) => `${journey}?stage=${stage.id}`;
  const detail = (stage: StageProjectionStage) => <StageDetail projectId={projectId} stage={stage} workComplete={!!work?.complete}
    tasks={work ? work.items.filter(task => task.stage?.stageId === stage.id) : null} />;
  const expandable = { openId, onToggle, detail };
  const unowned = (work?.items ?? []).filter(isUnowned);
  const options = projection.stages.filter(stage => stage.state === "active").map(stage => ({ id: stage.id, name: stageName(stage, deliverables.get(stage.id)) }));
  const [unassignedOpen, setUnassignedOpen] = React.useState(() => typeof location !== "undefined" && location.hash === "#unassigned");
  React.useEffect(() => onNavigate(() => { if (location.hash === "#unassigned") setUnassignedOpen(true); }), []);
  // Landing on `?stage=`: the row is brought into view once it is drawn.
  React.useEffect(() => { if (openId && active) document.querySelector(`[data-stage-row="${CSS.escape(openId)}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [openId, active, rows.main.length]);
  const foldedOpen = !!openId && rows.folded.some(stage => stage.id === openId);
  if (propose) return null;
  return <section aria-label="阶段" className="flex flex-col gap-4" data-stages="">
    <div className="flex flex-col gap-2">
      {rows.main.length
        ? <StageTable projection={projection} stages={rows.main} deliverables={deliverables} hrefFor={hrefFor} expandable={expandable} label="阶段" />
        : <p className="m-0 text-small text-text-secondary" data-no-stages="">{NO_STAGES}。可以在下面为目标提出阶段。</p>}
      {projection.tasksNoStage.declared > 0 && <p className={`m-0 ${muted}`} data-declared="">明确不属于阶段 {projection.tasksNoStage.declared} 项</p>}
    </div>
    <details id="unassigned" className={fold} open={unassignedOpen} onToggle={event => setUnassignedOpen(event.currentTarget.open)} data-unassigned="">
      <summary className={foldSummary}><ChevronRight aria-hidden="true" className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
        未归属的 {projection.tasksNoStage.unowned} 项未关闭任务</summary>
      <div className="mt-2 pl-5">
        <p className={`m-0 mb-1 ${muted}`} data-unowned-line="">{unownedLine(projection.tasksNoStage.unowned, work ? { items: unowned.length, complete: work.complete } : null)}</p>
        {work ? <ul className="m-0 flex list-none flex-col p-0">{unowned.map(task => <AssignRow key={task.taskId} context={context} task={task} options={options} onApplied={onApplied} />)}</ul>
          : <p className={`m-0 ${muted}`}>任务正在读取，读回后在这里列出。</p>}
      </div>
    </details>
    <LadderRow projectId={projectId} enabled={active} section />
    {rows.folded.length > 0 && <details className={fold} open={foldedOpen || undefined} data-folded-stages="">
      <summary className={foldSummary}><ChevronRight aria-hidden="true" className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />已回看的阶段 · {rows.folded.length}</summary>
      <div className="mt-2"><StageTable projection={projection} stages={rows.folded} deliverables={deliverables} hrefFor={hrefFor} expandable={expandable} label="已回看的阶段" /></div>
    </details>}
  </section>;
}
