// 文档 / 知识: the two reading spaces of the 文档与知识 section, as a pair of links at the top of the inner rail.
import { cn } from "@evoloop/ui";
import { href } from "../routes";

export function ReadingSpaceSwitch({ projectId, current, className }: { projectId: string; current: "documents" | "knowledge"; className?: string }) {
  const item = "flex h-7 items-center justify-center rounded-full text-label outline-none focus-visible:shadow-[var(--focus-ring)]";
  const on = "bg-accent font-medium text-accent-strong shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_55%,transparent)]", off = "text-muted-foreground hover:text-foreground";
  return <nav aria-label="文档与知识" className={cn("grid grid-cols-2 rounded-full bg-tab-track p-0.5", className)}>
    <a href={href(projectId, "documents")} aria-current={current === "documents" ? "page" : undefined} className={cn(item, current === "documents" ? on : off)}>文档</a>
    <a href={href(projectId, "knowledge")} aria-current={current === "knowledge" ? "page" : undefined} className={cn(item, current === "knowledge" ? on : off)}>知识</a>
  </nav>;
}
