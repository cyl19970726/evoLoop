// A stage in a left-column list: "短名 · 到期日". A long name is cut with an ellipsis; the due date never is, so it stays at the right edge of the column.
import { cn } from "@evoloop/ui";

export function StageLabel({ name, due, className }: { name: string; due: { text: string; title: string } | null; className?: string }) {
  return <span className={cn("flex min-w-0 items-baseline gap-1", className)} data-stage-label="">
    <span className="min-w-0 truncate" data-stage-label-name="">{name}</span>
    {due && <span className="shrink-0 tabular-nums" title={due.title} data-stage-label-due="">· {due.text}</span>}
  </span>;
}
