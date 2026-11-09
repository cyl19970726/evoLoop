import * as React from "react";
import { CircleHelp, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "../lib/cn";

interface StateFrameProps {
  icon?: React.ReactNode | undefined;
  title: string;
  children?: React.ReactNode | undefined;
  action?: React.ReactNode | undefined;
  className?: string | undefined;
  role?: "status" | "alert" | undefined;
}

function StateFrame({ icon, title, children, action, className, role }: StateFrameProps) {
  return (
    <div role={role} className={cn("flex flex-col items-start gap-2 rounded-lg bg-muted px-5 py-4", className)}>
      <p className="m-0 flex items-center gap-2 text-small font-semibold text-foreground">{icon}{title}</p>
      {children && <div className="text-label leading-[1.6] text-text-secondary">{children}</div>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  /** Why there is nothing here. Required: "暂无数据" alone is not an explanation. */
  reason: string;
  action?: React.ReactNode | undefined;
  className?: string | undefined;
}

/** Confirmed: there are no objects. */
export function EmptyState({ title, reason, action, className }: EmptyStateProps) {
  return <StateFrame title={title} action={action} className={className}>{reason}</StateFrame>;
}

export interface LoadingStateProps {
  /** Skeleton lines to draw. */
  lines?: number | undefined;
  label?: string | undefined;
  className?: string | undefined;
}

/** First read only. Later reads keep the old content and show RefreshingIndicator instead. */
export function LoadingState({ lines = 3, label = "正在读取", className }: LoadingStateProps) {
  return (
    <div role="status" aria-busy="true" className={cn("flex flex-col gap-2.5 py-2", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} aria-hidden="true" className="h-3 animate-pulse rounded-full bg-field motion-reduce:animate-none" style={{ width: `${92 - index * 17}%` }} />
      ))}
    </div>
  );
}

/** Shown next to content that is being read again; the old content stays on screen. */
export function RefreshingIndicator({ label = "正在核对", className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-1.5 text-caption text-muted-foreground", className)}>
      <LoaderCircle aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />{label}
    </span>
  );
}

export interface ErrorStateProps {
  title: string;
  /** What happened, in product language. */
  happened: string;
  /** Whether the previous content is still shown below. */
  previousContentKept?: boolean | undefined;
  /** What the person can do next. */
  next: string;
  /** Technical detail, collapsed by default. */
  diagnostics?: string | undefined;
  action?: React.ReactNode | undefined;
  className?: string | undefined;
}

/** A read or an operation failed. */
export function ErrorState({ title, happened, previousContentKept, next, diagnostics, action, className }: ErrorStateProps) {
  return (
    <StateFrame role="alert" icon={<TriangleAlert aria-hidden="true" className="size-4 text-destructive" />} title={title} action={action} className={cn("bg-danger-soft", className)}>
      <p className="m-0">{happened}{previousContentKept ? " 下面仍是上次读到的内容。" : ""}</p>
      <p className="m-0">{next}</p>
      {diagnostics && (
        <details className="mt-1 text-caption text-muted-foreground">
          <summary className="cursor-pointer">诊断信息</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono">{diagnostics}</pre>
        </details>
      )}
    </StateFrame>
  );
}

export interface UnknownStateProps {
  title: string;
  /** The last fact that is known for certain. */
  lastKnown: string;
  reason: string;
  /** Who can resolve it. */
  owner?: string | undefined;
  /** How to find out. */
  howToCheck?: string | undefined;
  action?: React.ReactNode | undefined;
  className?: string | undefined;
}

/** The result is unknown, access is missing, or the machine is offline. */
export function UnknownState({ title, lastKnown, reason, owner, howToCheck, action, className }: UnknownStateProps) {
  return (
    <StateFrame role="status" icon={<CircleHelp aria-hidden="true" className="size-4 text-muted-foreground" />} title={title} action={action} className={className}>
      <p className="m-0">最后已知：{lastKnown}</p>
      <p className="m-0">原因：{reason}</p>
      {owner && <p className="m-0">能处理的人：{owner}</p>}
      {howToCheck && <p className="m-0">怎样查回：{howToCheck}</p>}
    </StateFrame>
  );
}
