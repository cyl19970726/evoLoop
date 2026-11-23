// The overview's 阶段 block (docs/frontend/milestones-design.md §4): this project's own stages, one row each, replacing the roadmap-phase block. Rows link into
// 目标与阶段 at that stage; the verification ladder is one folded line at the right of the title; below the table, how many open Tasks have no stage.
import { errorText } from "../../shared/api";
import { href } from "../../shared/ui/shared";
import { useStageProjection } from "./stagesRead";
import { LadderRow } from "./LadderView";
import { StageTable } from "./StageTable";
import { NO_STAGES, stageRows } from "./stagesPresentation";

const card = "flex min-w-0 flex-col gap-1 rounded-xl bg-raised px-4 py-2 border border-border compact:px-5";
const muted = "text-caption text-muted-foreground";

export function StagesBlock({ projectId, active }: { projectId: string; active: boolean }) {
  const projection = useStageProjection(projectId, active);
  const data = projection.data;
  const rows = data ? stageRows(data) : null;
  const journey = href(projectId, "journey");
  return <section className={`${card} @container`} aria-label="阶段" data-overview-stages="">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-label font-semibold text-foreground">阶段</h2>
      <LadderRow projectId={projectId} enabled={active} />
    </div>
    {projection.isPending && <p className={muted} role="status">正在读取阶段…</p>}
    {projection.isError && !data && <p className={muted} role="status">阶段这次没有读到（{errorText(projection.error)}）。读不到不代表没有阶段。</p>}
    {rows && !rows.main.length && <p className="m-0 text-small text-text-secondary" data-no-stages="">{NO_STAGES}。<a className="text-primary hover:underline" href={journey}>到目标与阶段提出阶段</a></p>}
    {data && rows && rows.main.length > 0 && <>
      <StageTable projection={data} stages={rows.main} label="阶段" hrefFor={stage => `${journey}?stage=${stage.id}`} />
      {data.tasksNoStage.unowned > 0 && <p className={`m-0 text-right ${muted}`} data-unowned="">
        {data.tasksNoStage.unowned} 项未关闭任务未归属阶段 · <a className="text-primary hover:underline" href={`${journey}#unassigned`}>归到阶段</a></p>}
    </>}
  </section>;
}
