// Small building blocks shared by the evaluation detail, its attempts and its right column.
import type { ReactNode } from "react";
import type { EvaluationFixedRef } from "@evoloop/contracts";
import { cn } from "@evoloop/ui";
import { fixedRefHref, fixedRefIdentity, fixedRefName, fixedTitleKey } from "./presentation";

export const muted = "text-caption text-muted-foreground";
export const card = "flex min-w-0 flex-col gap-3 rounded-xl bg-raised p-4 shadow-sm compact:p-5";
export const linkClass = "text-primary underline-offset-2 hover:underline focus-visible:shadow-[var(--focus-ring)] outline-none rounded-sm";

/** Label over value, stacked; values wrap instead of overflowing. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="m-0 flex flex-col gap-2.5">{rows.map(([label, value]) => <div key={label} className="flex min-w-0 flex-col gap-0.5">
    <dt className={muted}>{label}</dt><dd className="m-0 min-w-0 whitespace-pre-wrap break-words text-small text-foreground">{value}</dd>
  </div>)}</dl>;
}

/** One block of the right column; blocks are separated by a thin line, as on the other rewritten pages. */
export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="flex min-w-0 flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <h2 className="text-label font-semibold text-foreground">{title}</h2>{children}
  </section>;
}

/** The only place raw IDs and hashes appear: collapsed, monospaced, wrapping anywhere. */
export function IdentityDetails({ rows, label = "完整标识", className }: { rows: Array<[string, string]>; label?: string; className?: string }) {
  return <details className={cn("min-w-0 text-caption text-muted-foreground", className)}>
    <summary className="w-fit cursor-pointer rounded-sm outline-none hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]">{label}</summary>
    <dl className="m-0 mt-1.5 flex flex-col gap-1">{rows.map(([name, value], index) => <div key={`${name}:${index}`} className="flex min-w-0 flex-col">
      <dt>{name}</dt><dd className="m-0 break-all font-mono text-text-secondary">{value}</dd>
    </div>)}</dl>
  </details>;
}

/** A fixed reference by name with a link to its fixed revision when the workbench can open it. */
export function FixedRefLine({ value, projectId, titles }: { value: EvaluationFixedRef; projectId: string; titles?: Record<string, string> | undefined }) {
  const link = fixedRefHref(projectId, value);
  const title = titles?.[fixedTitleKey(value)];
  const name = `${fixedRefName(value, title)} · 固定版`;
  return <span className="flex min-w-0 flex-col">
    {link ? <a href={link} className={cn(linkClass, "break-words text-small")}>{name} ↗</a> : <span className="break-words text-small text-foreground">{name}</span>}
    {title && <span className={muted}>现名称只作阅读辅助，已核对固定修订与哈希</span>}
  </span>;
}

export const refRows = (label: string, refs: EvaluationFixedRef[]): Array<[string, string]> =>
  refs.map((ref, index) => [refs.length > 1 ? `${label} ${index + 1}` : label, fixedRefIdentity(ref)]);
