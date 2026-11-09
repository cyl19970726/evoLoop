// Which allocation discussions formally lead to this role or agent. Only formal links and same-revision acceptance
// count; sharing a role with another agent does not. Shown on the role card and the agent's information panel.
import { useRef } from "react";
import { Button, CollapsibleRow } from "@evoloop/ui";
import type { MutationContext } from "../../shared/ActionForm";
import type { AllocationFilter } from "./allocationClient";
import { groupAllocationBacklinks, loadedBacklinkSummary } from "./allocationBacklinkGroups";
import { AllocationTraceCard, RelationReadState } from "./AllocationRelationsPanel";
import { muted } from "./CommandForm";
import { discussionHref } from "./discussionPresentation";
import { useAllocationNameState, type AllocationKnownNames } from "./useAllocationNames";
import { useAllocationTraces } from "./useAllocationTraces";

const noKnownNames: AllocationKnownNames = { tasks: [], roles: [], documents: [] };

export function AllocationBacklinks({ context, filter, refresh }: { context: MutationContext; filter: AllocationFilter; refresh: number }) {
  const root = useRef<HTMLElement>(null);
  const traces = useAllocationTraces(context, filter, refresh, root, "来源");
  const { names, reading } = useAllocationNameState(context.token, context.projectId, traces.items, noKnownNames, !traces.loading && !traces.error,
    `${traces.key}\0${refresh}\0${traces.readAgain}`);
  const groups = groupAllocationBacklinks(traces.items);
  return <section ref={root} data-ui="" aria-label="正式分工讨论来源" className="my-4 flex flex-col gap-2 rounded-lg bg-muted p-4">
    <h3 className="text-label font-semibold text-foreground">正式分工讨论来源</h3>
    <p className={muted}>只按正式链接和同一修订的接受记录反查；同一职责下的其他智能体不会自动算进来。</p>
    <RelationReadState noun="来源" traces={traces} />
    {groups.length > 0 && <ul className="flex flex-col">{groups.map(group => <li key={group.discussion.id} className="flex flex-col gap-1 border-t border-border py-2.5 first:border-t-0">
      <a href={discussionHref(context.projectId, group.discussion.id)} className="text-small font-medium text-primary underline-offset-4 hover:underline">{group.discussion.title || "分工讨论"}</a>
      <span className={muted}>{loadedBacklinkSummary(group, Boolean(traces.cursor || traces.partial))}</span>
      <CollapsibleRow summary={`展开 ${group.traces.length} 条具体关系`}>
        <p className={muted}>当前读到这条讨论的第 {group.discussion.version} 版；下面每条关系各有固定来源。</p>
        <div className="flex flex-col">{group.traces.map(trace => <AllocationTraceCard key={trace.id} trace={trace} projectId={context.projectId} names={names} reading={key => !traces.error && reading(key)} />)}</div>
      </CollapsibleRow>
    </li>)}</ul>}
    {traces.cursor && <Button size="compact" variant="ghost" className="self-start" disabled={traces.moreBusy || traces.loading} onClick={() => void traces.more()}>{traces.moreBusy ? "正在读取…" : "加载更多来源"}</Button>}
  </section>;
}
