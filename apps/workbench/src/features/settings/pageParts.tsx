// Shared layout for the account and project pages reached from the settings menu.
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@evoloop/ui";

export function SettingsPage({ title, description, action, className, children }: {
  title: string; description: string; action?: ReactNode; className?: string; children: ReactNode;
}) {
  return <div data-ui="" className={cn("mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-5 compact:px-8 compact:py-7", className)}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>{title}</h1>
        <p className="mt-1 text-small text-text-secondary">{description}</p>
      </div>
      {action}
    </header>
    {children}
  </div>;
}

export function SettingsSection({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return <section id={id} aria-label={title} className="flex flex-col gap-3">
    <h2 className="text-label font-semibold text-foreground">{title}</h2>
    {children}
  </section>;
}

/** Label / value rows inside one raised card; values wrap instead of overflowing. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="rounded-xl bg-raised px-4 shadow-sm">
    {rows.map(([label, value]) => <div key={label} className="grid gap-1 border-t border-border py-3 first:border-t-0 compact:grid-cols-[160px_minmax(0,1fr)] compact:gap-4">
      <dt className="text-small text-text-secondary">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-small text-foreground">{value}</dd>
    </div>)}
  </dl>;
}

export interface LinkItem { href: string; title: string; detail: string; icon?: ReactNode; external?: boolean }

export function LinkList({ items, label }: { items: LinkItem[]; label: string }) {
  return <ul aria-label={label} className="flex flex-col overflow-hidden rounded-xl bg-raised shadow-sm">
    {items.map(item => <li key={item.href} className="border-t border-border first:border-t-0">
      <a href={item.href} {...item.external ? { target: "_blank", rel: "noreferrer" } : {}}
        className="flex items-center gap-3 px-4 py-3 text-foreground outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]">
        {item.icon && <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-field text-text-secondary [&_svg]:size-4">{item.icon}</span>}
        <span className="flex min-w-0 flex-1 flex-col">
          <strong className="text-small font-semibold">{item.title}</strong>
          <span className="text-caption text-muted-foreground">{item.detail}</span>
        </span>
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      </a>
    </li>)}
  </ul>;
}
