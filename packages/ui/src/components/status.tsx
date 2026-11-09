import * as React from "react";
import { Check, CircleHelp, Clock, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

/** The status table in docs/frontend/foundations.md. Business states map onto these tones in the workbench's shared layer. */
export type StatusTone = "progress" | "done" | "waiting" | "blocked" | "idle" | "unknown" | "history";

const tones: Record<StatusTone, { className: string; Icon?: LucideIcon; spin?: boolean }> = {
  progress: { className: "bg-accent text-primary", Icon: LoaderCircle, spin: true },
  done: { className: "bg-field text-text-secondary", Icon: Check },
  waiting: { className: "bg-warning-soft text-warning", Icon: Clock },
  blocked: { className: "bg-danger-soft text-destructive", Icon: TriangleAlert },
  idle: { className: "bg-field text-text-secondary" },
  unknown: { className: "bg-transparent text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]", Icon: CircleHelp },
  history: { className: "bg-transparent text-muted-foreground" },
};

export interface StatusTagProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /** Two to four characters, for example 待验收. Colour never carries the meaning alone. */
  label: string;
  /** Optional second part, for example the reason after 受阻. */
  detail?: string | undefined;
}

export function StatusTag({ tone, label, detail, className, ...props }: StatusTagProps) {
  const { className: toneClass, Icon, spin } = tones[tone];
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-caption font-medium leading-[1.55]", toneClass, className)} data-tone={tone} {...props}>
      {Icon && <Icon aria-hidden="true" className={cn("size-3 shrink-0", spin && "animate-spin motion-reduce:animate-none")} />}
      <span className="truncate">{detail ? `${label} · ${detail}` : label}</span>
    </span>
  );
}

/** Counts, kinds and short marks. Neutral only: a badge never states a status. */
export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("inline-flex min-w-5 items-center justify-center rounded-full bg-field px-2 text-caption leading-5 text-text-secondary tabular-nums", className)} {...props} />;
}

/** The small count on 待我处理 and similar entries. */
export function CountDot({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return <span className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold leading-4 text-on-brand tabular-nums", className)}>{count > 99 ? "99+" : count}</span>;
}

export type NoticeTone = "info" | "waiting" | "error";

const noticeTones: Record<NoticeTone, string> = {
  info: "bg-accent text-foreground",
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
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-lg px-4 py-3 text-label leading-[1.6]", noticeTones[tone], className)} {...props}>
      <div className="min-w-0 flex-1">
        {title && <p className={cn("m-0 font-semibold", noticeTitle[tone])}>{title}</p>}
        {children && <div className="text-text-secondary">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
