// The "运行受阻" bar above every page (docs/frontend/pages/inbox.md): one line that says what stopped, who is stopped and what the person
// has to do, with the way to the object. The line is the <summary> of a native <details>: closed it is that one line (neutral, a small red
// dot); open it lists the affected agents and the source layer (hold number, version, release command). Only on an affected agent's own
// page the line turns red. Plain classes and the shell's own parts: no command name, hold number or version appears in the line itself.
import { ChevronDown } from "lucide-react";
import type { ProviderHoldListing } from "@evoloop/contracts/provider-hold";
import { cn } from "@evoloop/ui";
import { SessionName, useSessionName } from "../../shared/ui/RecordName";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { holdFacts, holdIdentifiers, holdIsHere, holdLine, holdSummary, holdTarget } from "../../shared/providerHoldPresentation";

export function ProviderHoldBar({ listing, projectId, route }: { listing: ProviderHoldListing | undefined; projectId: string; route: { section: string; session?: string | undefined } }) {
  const summary = holdSummary(listing);
  const first = summary?.sessionIds[0];
  const name = useSessionName(projectId, first ? `owned:${first}` : null);
  if (!summary) return null;
  const here = holdIsHere(summary, route);
  const line = holdLine(summary, name.state === "named" ? name.name : null);
  return <div data-ui="" className="px-4 pt-3 compact:px-8" data-provider-hold-bar="" data-here={here ? "true" : "false"}>
    <details className={cn("group rounded-lg", here ? "bg-danger-soft" : "bg-muted")}>
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-label [&::-webkit-details-marker]:hidden" data-provider-hold-line="">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
        <span role={here ? "alert" : "status"} className={cn("min-w-0 flex-1 truncate", here ? "font-medium text-destructive" : "text-foreground")} title={line}>{line}</span>
        <a href={holdTarget(projectId, summary)} className="shrink-0 whitespace-nowrap text-primary hover:underline" data-provider-hold-link="">去处理</a>
        <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        <span className="sr-only">展开或收起详情</span>
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3 text-small text-text-secondary" data-provider-hold-detail="">
        <p className="m-0 text-foreground">{line}。</p>
        {summary.holds.map(hold => <p key={hold.id} className="m-0">{holdFacts(hold)}</p>)}
        {summary.sessionIds.length > 0 && <ul aria-label="受影响的智能体" className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
          {summary.sessionIds.map(id => <li key={id}><a className="text-primary hover:underline" href={`/p/${projectId}/sessions?session=${encodeURIComponent(`owned:${id}`)}`}><SessionName projectId={projectId} sessionKey={`owned:${id}`} /></a></li>)}</ul>}
        <FullIdentifiers rows={holdIdentifiers(summary)} />
      </div>
    </details>
  </div>;
}
