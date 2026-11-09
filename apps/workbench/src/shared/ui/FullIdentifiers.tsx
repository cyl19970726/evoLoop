// The source layer of an item: raw identifiers, and the original wording of server text the page only summarises
// (docs/frontend/principles.md, “原始标识放在来源层”). Closed by default; identifiers can be selected and copied.
import { cn } from "@evoloop/ui";

export interface IdentifierRow {
  label: string;
  value: string | null | undefined;
  /** Original server wording rather than an identifier: shown as text, not code. */
  text?: boolean;
}

export function FullIdentifiers({ rows, summary = "来源与完整标识", className }: {
  rows: IdentifierRow[]; summary?: string; className?: string;
}) {
  const shown = rows.filter(row => row.value);
  if (!shown.length) return null;
  return <details className={cn("text-caption text-muted-foreground", className)}>
    <summary className="w-fit cursor-pointer hover:text-foreground">{summary}</summary>
    <dl className="mt-1 flex flex-col gap-0.5">{shown.map(row => <div key={`${row.label}:${row.value}`} className="flex flex-wrap gap-x-1.5">
      <dt>{row.label}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{row.text ? row.value : <code className="select-all font-mono">{row.value}</code>}</dd>
    </div>)}</dl>
  </details>;
}
