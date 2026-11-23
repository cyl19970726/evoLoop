// The stage table (docs/frontend/milestones-design.md §4): one row per stage, five cells: 名称、到期日、怎样算到了、任务、状态. The 总览 shows it with each row a
// link into 目标与阶段; 目标与阶段 shows it with the full 怎样算到了 and a row that opens in place. Only the row of the stage the service names is 当前,
// drawn like a selected item (neutral fill, heavier text); the status is the service's own word in the shared status mark. No cards, no capsules.
import * as React from "react";
import type { StageProjection, StageProjectionStage } from "@evoloop/contracts/stage-projection";
import { ChevronRight } from "lucide-react";
import { Button, StatusTag, cn } from "@evoloop/ui";
import { checkCell, dueCell, isCurrent, overdueNote, stageName, statusTone, taskCell, NO_TASKS } from "./stagesPresentation";

const wide = "@xl:grid-cols-[minmax(6.5rem,1fr)_3rem_minmax(0,2.4fr)_7rem_7.5rem]";
const rowBase = "grid w-full min-w-0 grid-cols-1 items-start gap-x-3 gap-y-0.5 rounded-md px-3 py-1 text-left text-small leading-tight text-text-secondary no-underline";

export interface StageTableProps {
  projection: StageProjection;
  stages: StageProjectionStage[];
  /** The text of a stage that has no short name (old stages): first line of its deliverable. */
  deliverables?: ReadonlyMap<string, string>;
  /** Overview: every row is a link to this address. Journey: a row opens in place and this builds the address of its `?stage=`. */
  hrefFor(stage: StageProjectionStage): string;
  /** 目标与阶段: the full 怎样算到了, and a row that opens (the id that is open, and what a click does). */
  expandable?: { openId: string | null; onToggle(id: string): void; detail(stage: StageProjectionStage): React.ReactNode };
  label: string;
}

export function StageTable({ projection, stages, deliverables, hrefFor, expandable, label }: StageTableProps) {
  const full = !!expandable;
  return <div className="@container" data-stage-table="">
    <div aria-hidden="true" className={cn("hidden gap-x-3 px-3 pb-1 text-caption text-muted-foreground @xl:grid", wide)}>
      <span>名称</span><span>到期日</span><span>怎样算到了</span><span>任务</span><span>状态</span></div>
    <ul aria-label={label} className="m-0 flex list-none flex-col p-0">{stages.map(stage => {
      const current = isCurrent(projection, stage);
      const due = dueCell(stage.dueOn);
      const open = expandable?.openId === stage.id;
      const name = stageName(stage, deliverables?.get(stage.id));
      const cells = <>
        <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">
          {current && <span data-current-mark="" className="mr-1.5 whitespace-nowrap text-caption font-semibold text-primary">当前</span>}<span className={cn(current && "font-semibold")}>{name}</span>
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 @xl:contents">
          <span title={due.title} className="tabular-nums">{due.text}</span>
          <span className={cn("order-last col-span-full min-w-0 text-text-secondary [overflow-wrap:anywhere] @xl:order-none @xl:col-span-1", !full && "line-clamp-2")} data-check="">{checkCell(stage.checkMethod)}</span>
          <span className={cn(taskCell(stage.tasks) === NO_TASKS && "text-muted-foreground")}>{taskCell(stage.tasks)}</span>
          <span className="min-w-0"><StatusTag tone={statusTone[stage.status]} label={stage.statusLabel} />
            {stage.status === "overdue_awaiting_review" && <span className="block text-caption text-muted-foreground" data-overdue-note="">{overdueNote(projection)}</span>}</span>
        </span>
      </>;
      const common = { "data-stage-row": stage.id, "data-current": current ? "true" : undefined } as const;
      return <li key={stage.id} className="border-t border-border first:border-t-0" {...common}>
        {expandable
          ? <Button variant="row" aria-expanded={open} aria-current={current ? "true" : undefined} aria-label={`${name}：${open ? "收起" : "展开"}`} onClick={() => expandable.onToggle(stage.id)}
            className={cn(rowBase, wide, "relative pl-7 hover:no-underline")}>
            <ChevronRight aria-hidden="true" size={14} className={cn("absolute left-2.5 top-2.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />{cells}</Button>
          : <a href={hrefFor(stage)} aria-current={current ? "true" : undefined} className={cn("selected-mark hover:bg-selected hover:text-foreground focus-visible:shadow-[var(--focus-ring)] outline-none", rowBase, wide)}>{cells}</a>}
        {open && expandable && <div role="region" aria-label={`${name}的任务与回看`} className="px-3 pb-3 pl-7" data-stage-detail={stage.id}>{expandable.detail(stage)}</div>}
      </li>;
    })}</ul>
  </div>;
}
