// The limits of a read, in Chinese, with the service's original wording folded under 原文 (readingScopePresentation).
import { describeLimitations } from "./readingScopePresentation";

export function SourceLimitations({ items, className }: { items: readonly string[]; className?: string }) {
  const { lines, originals } = describeLimitations(items);
  if (!lines.length) return null;
  return <div className={className}>
    <ul className="list-disc pl-5">{lines.map(line => <li key={line}>{line}。</li>)}</ul>
    {originals.length > 0 && <details className="mt-1">
      <summary className="w-fit cursor-pointer hover:text-foreground">原文</summary>
      <ul className="mt-1 flex flex-col gap-0.5 font-mono [overflow-wrap:anywhere]">{originals.map(original => <li key={original} lang="en">{original}</li>)}</ul>
    </details>}
  </div>;
}
