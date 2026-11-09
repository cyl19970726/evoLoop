// The parts the task page's tabs share: a titled section, a collapsible action row and what a read that is pending or
// failed may say. The forms themselves are the shared command form (shared/command).
import React, { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button, ErrorState, LoadingState, Notice, RefreshingIndicator, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { CommandBlock, type FormField } from "../../shared/command";
import { readStanding } from "../../shared/query";

/** Why the task page may not write right now (a historical revision, a reread, an unconfirmed operation), or "". */
export const TaskWriteBlock = CommandBlock;

export function TabSection({ title, meta, action, children, id, className }: {
  title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode; id?: string; className?: string;
}) {
  const headingId = React.useId();
  return <section id={id} aria-labelledby={headingId} className={cn("flex scroll-mt-20 flex-col gap-3", className)}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id={headingId} className="text-heading font-semibold text-foreground">{title}</h2>
      {meta && <span className="text-caption text-muted-foreground">{meta}</span>}
      {action && <span className="ml-auto flex items-center gap-2">{action}</span>}
    </div>
    {children}
  </section>;
}

/**
 * One action or record that opens in place: a title, a muted line under it, and its content when open. The content
 * mounts the first time the row opens, so a form records its baseline when the person opens it, not when the page
 * loaded; closing the row keeps the draft and that baseline for as long as the page lives (a changed baseline then
 * refuses the submit). Drafts are not kept across a reload or another project.
 */
export function ActionRow({ title, description, children, defaultOpen = false, id, dirty, trailing }: {
  title: ReactNode; description?: ReactNode; children: ReactNode; defaultOpen?: boolean; id?: string; dirty?: boolean; trailing?: ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [opened, setOpened] = React.useState(defaultOpen);
  return <details id={id} open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setOpened(true); }} data-dirty={dirty ? "true" : undefined} className="group border-t border-border first:border-t-0">
    <summary className="flex cursor-pointer list-none items-start gap-2 py-3 outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-small font-medium text-foreground">{title}</span>
        {description && <span className="text-caption text-muted-foreground">{description}</span>}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </summary>
    {opened && <div className="flex flex-col gap-3 pb-4 pl-[22px]">{children}</div>}
  </details>;
}

export const reasonField = (label = "理由与依据", hint?: string): FormField => ({ name: "reason", label, kind: "textarea", ...(hint ? { hint } : {}) });

interface QueryLike<T> { data: T | undefined; error: unknown; isPending: boolean; isFetching: boolean; isPlaceholderData?: boolean; refetch(): unknown }

/** Whether a read can be shown as current: answered, and its last reread did not fail. */
export function readCurrent<T>(read: Pick<QueryLike<T>, "data" | "error">): boolean {
  return read.data !== undefined && !read.error;
}

/**
 * What a read may show besides its data (readStanding): the first read is pending, a failed first read cannot tell
 * anything, a failed reread keeps the same key's last answer marked 上次读回. Returns null when the data is current.
 */
export function ReadNote<T>({ read, what, lines = 3 }: { read: QueryLike<T>; what: string; lines?: number }) {
  const retry = <Button size="compact" disabled={read.isFetching} onClick={() => void read.refetch()}>重新读取</Button>;
  const standing = readStanding({ data: read.data, isError: !!read.error, isPlaceholderData: !!read.isPlaceholderData });
  if (read.isPending && !read.error) return <LoadingState lines={lines} label={`正在读取${what}`} />;
  if (standing.failed) return <ErrorState title={`${what}暂不可读取`} happened={errorText(read.error)}
    next="可以重新读取；读取失败不代表没有记录。" action={retry} />;
  if (standing.stale) return <Notice tone="waiting" title="上次读回，当前待核对" action={retry}>重新读取{what}失败：{errorText(read.error)}。下面是上次读回的内容。</Notice>;
  if (standing.previous) return <RefreshingIndicator label={`正在读取${what}`} />;
  if (read.isFetching && read.data !== undefined) return <RefreshingIndicator label={`正在核对${what}`} />;
  return null;
}

/** A label above a value, in plain blocks (the old global sheet still lays out every `dl > div` as a grid). */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div role="group" aria-label={label} className={cn("flex min-w-0 flex-col gap-0.5", className)}>
    <p className="text-caption text-muted-foreground">{label}</p>
    <div className="text-label text-foreground [overflow-wrap:anywhere]">{children}</div>
  </div>;
}

/** A short muted line. */
export function Fine({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-caption text-muted-foreground", className)}>{children}</p>;
}
