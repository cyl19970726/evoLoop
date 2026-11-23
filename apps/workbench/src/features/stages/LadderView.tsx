// The verification ladder (M0 …) of the project's own roadmap: folded to one line in the 总览 阶段 block, a section in 目标与阶段. A project with no
// roadmap has `available:false`: nothing is drawn (that is "none", not an error). A repository that cannot be read is the error: "阶梯读不到".
import * as React from "react";
import { ChevronRight } from "lucide-react";
import { errorText } from "../../shared/api";
import { href } from "../../shared/ui/shared";
import { useLadder } from "./stagesRead";
import { LADDER_UNREADABLE, ladderLines, ladderSummary } from "./stagesPresentation";

const muted = "text-caption text-muted-foreground";

function Levels({ projectId, levels }: { projectId: string; levels: NonNullable<ReturnType<typeof useLadder>["data"]>["levels"] }) {
  return <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-small" data-ladder-levels="">
    {levels.map(level => <li key={level.key} data-ladder-level={level.key} className="flex flex-col gap-0.5">
      <p className="m-0 text-foreground"><span className="font-semibold">{level.key}</span> {level.name} · <span className="text-text-secondary">{ladderLines({ available: true, source: { commit: null }, levels: [level] })[0]!.status}</span></p>
      <p className={`m-0 ${muted}`}>{level.evidenceStages.length
        ? <>供证据的阶段：{level.evidenceStages.map((stage, index) => <React.Fragment key={stage.id}>{index ? "、" : ""}<a className="text-primary hover:underline" href={`${href(projectId, "journey")}?stage=${stage.id}`} title={stage.shortName}><span className="inline-block max-w-[16rem] truncate align-bottom">{stage.shortName}</span></a></React.Fragment>)}</>
        : "暂无阶段补这一级"}</p>
    </li>)}
  </ol>;
}

export function LadderRow({ projectId, enabled, section = false }: { projectId: string; enabled: boolean; section?: boolean }) {
  const ladder = useLadder(projectId, enabled);
  if (ladder.isPending) return null;
  if (ladder.isError) return <p className={`m-0 ${muted}`} role="status" data-ladder-error="" title={errorText(ladder.error)}>{LADDER_UNREADABLE}</p>;
  const view = ladder.data;
  if (!view?.available) return null;
  const commit = view.source.commit ? `读自路线图 ${view.source.commit.slice(0, 7)}` : "";
  if (section) return <section aria-label="验证阶梯" className="flex flex-col gap-2" data-ladder="">
    <h2 className="text-label font-semibold text-foreground">验证阶梯</h2>
    <Levels projectId={projectId} levels={view.levels} />{commit && <p className={`m-0 ${muted}`}>{commit}</p>}
  </section>;
  return <details className="group min-w-0 text-small" data-ladder="">
    <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1 text-text-secondary outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
      <span className="shrink-0">验证阶梯</span><span className="min-w-0 truncate text-caption text-muted-foreground" data-ladder-summary="">{ladderSummary(view)}</span></summary>
    <div className="mt-2 pl-5"><Levels projectId={projectId} levels={view.levels} />{commit && <p className={`mt-1 ${muted}`}>{commit}</p>}</div>
  </details>;
}
