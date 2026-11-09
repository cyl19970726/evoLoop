import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

export interface ListRowProps {
  /** Avatar, icon or status mark on the left. */
  leading?: React.ReactNode | undefined;
  title: React.ReactNode;
  /** One muted line under the title. */
  meta?: React.ReactNode | undefined;
  /** Count, status tag or time on the right. */
  trailing?: React.ReactNode | undefined;
  selected?: boolean | undefined;
  /** A link row when set; otherwise a button row when onSelect is set; otherwise static. */
  href?: string | undefined;
  /** Runs when the row is chosen: the button row's action, or a note taken as a link row is followed. */
  onSelect?: () => void | undefined;
  className?: string | undefined;
}

/** One row in a rail or list. Rows are separated by space and selection, never boxed as cards. */
export function ListRow({ leading, title, meta, trailing, selected, href, onSelect, className }: ListRowProps) {
  const body = (
    <>
      {leading && <span className="flex shrink-0 items-center">{leading}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-small text-foreground", selected ? "font-semibold" : "font-normal")}>{title}</span>
        {meta && <span className="truncate text-caption text-muted-foreground">{meta}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">{trailing}</span>}
    </>
  );
  const rowClass = cn(
    "flex w-full items-center gap-2.5 rounded-md border-0 px-3 py-2 text-left no-underline outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
    selected ? "bg-selected" : "bg-transparent hover:bg-field/60",
    (href || onSelect) && "cursor-pointer",
    className,
  );
  if (href) return <a href={href} aria-current={selected ? "page" : undefined} onClick={onSelect} className={rowClass}>{body}</a>;
  if (onSelect) return <button type="button" aria-current={selected ? "true" : undefined} onClick={onSelect} className={cn(rowClass, "font-[inherit]")}>{body}</button>;
  return <div className={rowClass}>{body}</div>;
}

export interface CollapsibleRowProps {
  /** The one-line summary shown while collapsed, for example 执行了 5 个指令、读了 3 个文件. */
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean | undefined;
  className?: string | undefined;
}

/** A muted one-line summary that expands into indented detail. */
export function CollapsibleRow({ summary, children, defaultOpen, className }: CollapsibleRowProps) {
  return (
    <CollapsiblePrimitive.Root defaultOpen={defaultOpen} className={cn("flex flex-col gap-2", className)}>
      <CollapsiblePrimitive.Trigger className="group inline-flex cursor-pointer items-center gap-1.5 self-start rounded-md border-0 bg-transparent p-0 text-label text-muted-foreground outline-none hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]">
        <ChevronRight aria-hidden="true" className="size-3 transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        {summary}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="pl-[18px]">{children}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
