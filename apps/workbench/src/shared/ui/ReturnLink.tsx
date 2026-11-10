// The way back at the top of a page opened from another space or page (scenarios.md 跳转规则): “返回任务：<名称>”.
// The name comes with the link when the source knew it; otherwise the task's title (or the agent's registered name) is
// read, and until it is back the link says only “返回任务”. One look for every page that offers a way back.
import { ArrowLeft } from "lucide-react";
import { cn } from "@evoloop/ui";
import { returnText, type ReturnPlace } from "../returnLink";
import type { NameRead } from "../workPresentation";
import { useSessionName, useTaskName } from "./RecordName";

const named = (read: NameRead) => read.state === "named" ? read.name : null;

export function ReturnLink({ projectId, href, place, title, className }: {
  projectId: string; href: string; place: ReturnPlace; title?: string | null; className?: string;
}) {
  const taskId = title ? null : place.kind === "task" ? place.taskId : place.kind === "tasks" ? place.selected : null;
  const task = useTaskName(projectId, taskId);
  const agent = useSessionName(projectId, !title && place.kind === "agent" ? place.sessionKey : null);
  const name = title || (taskId ? named(task) : place.kind === "agent" ? named(agent) : null);
  // Same box as the page headers' other links: one text line that wraps a long name rather than widening the header.
  return <a href={href} data-return-link=""
    className={cn("inline-flex max-w-full items-center gap-1 text-label font-medium text-primary [overflow-wrap:anywhere] hover:underline", className)}>
    <ArrowLeft size={15} aria-hidden="true" className="shrink-0" />{returnText(place, name)}
  </a>;
}
