// The way back at the top of a page opened from another space or page (scenarios.md 跳转规则): “返回任务：<名称>”.
// A way back read from the address (`readReturn`) is shown with its own label, so the page says exactly what the pure
// function says. A way back without a link behind it (the document page's remembered source) names the task it goes back
// to, or the agent as every page names it (`agentDisplayName`), once read; until then it says only “返回任务”. The task
// table is never named after whichever row happens to be selected.
import { ArrowLeft } from "lucide-react";
import { cn } from "@evoloop/ui";
import { returnText, type ReturnPlace } from "../returnLink";
import type { NameRead } from "../workPresentation";
import { useSessionName, useTaskName } from "./RecordName";

const named = (read: NameRead) => read.state === "named" ? read.name : null;

export function ReturnLink({ projectId, href, place, label, className }: {
  projectId: string; href: string; place: ReturnPlace; label?: string; className?: string;
}) {
  const task = useTaskName(projectId, !label && place.kind === "task" ? place.taskId : null);
  // The same read as the task page's agent names (shared/agentRead.ts), so they share one answer.
  const agent = useSessionName(projectId, !label && place.kind === "agent" ? place.sessionKey : null);
  const text = label ?? returnText(place, place.kind === "task" ? named(task) : place.kind === "agent" ? named(agent) : null);
  // Same box as the page headers' other links: one text line that wraps a long name rather than widening the header.
  return <a href={href} data-return-link=""
    className={cn("inline-flex max-w-full items-center gap-1 text-label font-medium text-primary [overflow-wrap:anywhere] hover:underline", className)}>
    <ArrowLeft size={15} aria-hidden="true" className="shrink-0" />{text}
  </a>;
}
