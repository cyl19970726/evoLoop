// Small layout pieces the rebuilt pages share: a titled part of the center column, a part of the right column and
// label / value facts. Pure markup on @evoloop/ui tokens; pages decide what goes in them.
import type { ReactNode } from "react";
import { cn } from "@evoloop/ui";

export const mutedText = "text-caption text-muted-foreground";

/** A titled part of the center column. Parts are separated by space and a hairline, never boxed as cards. */
export function PageSection({ title, action, description, children, className, id }: {
  title: string; action?: ReactNode; description?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  return <section id={id} aria-label={title} className={cn("flex min-w-0 flex-col gap-3 border-t border-border pt-5 first:border-t-0 first:pt-0", className)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-heading font-semibold text-foreground">{title}</h2>
      {action}
    </div>
    {description && <p className="text-small text-text-secondary">{description}</p>}
    {children}
  </section>;
}

/** A part of the right column: a small heading and its facts. */
export function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section aria-label={title} className="flex min-w-0 flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-label font-semibold text-foreground">{title}</h2>
      {action}
    </div>
    {children}
  </section>;
}

/** Label above value; values wrap instead of overflowing. `columns` lays rows side by side from the compact width up. */
export function FactList({ rows, columns = false }: { rows: Array<[string, ReactNode]>; columns?: boolean }) {
  return <dl className={cn("grid min-w-0 gap-x-6 gap-y-3", columns && "compact:grid-cols-2")}>
    {rows.map(([label, value]) => <div key={label} className="flex min-w-0 flex-col gap-0.5">
      <dt className={mutedText}>{label}</dt>
      <dd className="m-0 min-w-0 whitespace-pre-wrap break-words text-small text-foreground">{value}</dd>
    </div>)}
  </dl>;
}

/** Old markup (the shared command forms, panels of other pages) kept inside a rebuilt page until it is rebuilt too. */
export function Legacy({ children, className }: { children: ReactNode; className?: string }) {
  return <div data-legacy="" className={cn("workbench-layout min-w-0", className)}>{children}</div>;
}
