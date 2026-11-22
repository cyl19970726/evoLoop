import * as React from "react";
import { Check, CircleHelp, Clock, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

/** The status table in docs/frontend/foundations.md. Business states map onto these tones in the workbench's shared layer. */
export type StatusTone = "progress" | "done" | "waiting" | "blocked" | "idle" | "unknown" | "history";

// A status is a small icon (or a dot) in the status hue followed by plain text: no filled capsule. Colour never carries the meaning alone.
// Running keeps its own blue (--running), apart from the green of links; done is neutral grey.
const tones: Record<StatusTone, { iconClass: string; Icon?: LucideIcon; spin?: boolean; hollow?: boolean }> = {
  progress: { iconClass: "text-running", Icon: LoaderCircle, spin: true },
  done: { iconClass: "text-done", Icon: Check },
  waiting: { iconClass: "text-warning", Icon: Clock },
  blocked: { iconClass: "text-destructive", Icon: TriangleAlert },
  // 待办: a hollow dot, so it is not mistaken for 完成.
  idle: { iconClass: "text-text-secondary", hollow: true },
  // 未知: a question mark.
  unknown: { iconClass: "text-muted-foreground", Icon: CircleHelp },
  history: { iconClass: "text-muted-foreground", hollow: true },
};

export interface StatusTagProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /** Two to four characters, for example 待验收. Colour never carries the meaning alone. */
  label: string;
  /** Optional second part, for example the reason after 受阻. */
  detail?: string | undefined;
}

export function StatusTag({ tone, label, detail, className, ...props }: StatusTagProps) {
  const { iconClass, Icon, spin, hollow } = tones[tone];
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 py-0.5 text-caption font-medium leading-(--leading-body) text-text-secondary", className)} data-tone={tone} {...props}>
      {Icon && <Icon aria-hidden="true" className={cn("size-3 shrink-0", iconClass, spin && "animate-spin motion-reduce:animate-none")} />}
      {hollow && <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full border border-current", iconClass)} />}
      <span className="truncate">{detail ? `${label} · ${detail}` : label}</span>
    </span>
  );
}

/** Counts, kinds and short marks. Neutral only: a badge never states a status. */
export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("inline-flex items-center justify-center text-caption leading-(--leading-body) text-text-secondary tabular-nums", className)} {...props} />;
}

const dot = "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-caption font-semibold leading-(--leading-tight) tabular-nums";

/**
 * The small count on 待我处理 and similar entries. `null` is a count that cannot be checked right now: a muted question
 * mark (the status table's 未知) instead of a number that may be wrong, named 数目待核对 for screen readers and on hover.
 */
export function CountDot({ count, className }: { count: number | null; className?: string }) {
  if (count === null) return <span title="数目待核对" data-count="unknown" className={cn(dot, "bg-field text-muted-foreground", className)}>
    <span aria-hidden="true">?</span><span className="sr-only">数目待核对</span></span>;
  if (count <= 0) return null;
  return <span className={cn(dot, "bg-count-bg text-count-fg", className)}>{count > 99 ? "99+" : count}</span>;
}

export type NoticeTone = "info" | "waiting" | "error";

const noticeTones: Record<NoticeTone, string> = {
  info: "bg-muted text-foreground",
  waiting: "bg-warning-soft text-foreground",
  error: "bg-danger-soft text-foreground",
};
const noticeTitle: Record<NoticeTone, string> = { info: "text-primary", waiting: "text-warning", error: "text-destructive" };

export interface NoticeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: NoticeTone | undefined;
  title?: React.ReactNode | undefined;
  action?: React.ReactNode | undefined;
}

/** An in-page note. It never stands in for an empty state. */
export function Notice({ tone = "info", title, action, children, className, ...props }: NoticeProps) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-lg px-4 py-3 text-label leading-(--leading-body)", noticeTones[tone], className)} {...props}>
      <div className="min-w-0 flex-1">
        {title && <p className={cn("m-0 font-semibold", noticeTitle[tone])}>{title}</p>}
        {children && <div className="text-text-secondary">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
