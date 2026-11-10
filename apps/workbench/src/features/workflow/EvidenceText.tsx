// Evidence and reasons as written: short text in full; long text as a preview with the complete original one
// click away (never cut without a way to read the rest).
import React, { type ReactNode } from "react";

export function evidencePreview(value: string): string | null {
  const points = Array.from(value);
  if (points.length <= 240 && value.split("\n").length <= 8) return null;
  const prefix = points.slice(0, 160);
  let lines = 1;
  let end = prefix.length;
  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] === "\n" && ++lines > 4) { end = index; break; }
  }
  return prefix.slice(0, end).join("") + "…";
}

const text = "whitespace-pre-wrap text-label leading-(--leading-body) text-foreground [overflow-wrap:anywhere]";

export function EvidenceText({ label, value }: { label: string; value: string }): ReactNode {
  const preview = evidencePreview(value);
  return <div className="flex min-w-0 flex-col gap-1">
    <p className="text-caption font-medium text-muted-foreground">{label}</p>
    {preview === null ? <p className={text}>{value}</p> : <React.Fragment>
      <p className={text}>{preview}</p>
      <details className="group">
        <summary className="w-fit cursor-pointer text-caption text-primary hover:underline">展开完整{label}</summary>
        <p className={`mt-1 ${text}`}>{value}</p>
      </details>
    </React.Fragment>}
  </div>;
}
