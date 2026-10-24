import type { ReactNode } from "react";

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

export function EvidenceText({ label, value }: { label: string; value: string }): ReactNode {
  const preview = evidencePreview(value);
  return <div className="task-evidence-text">
    <strong>{label}</strong>
    {preview === null ? <p>{value}</p> : <>
      <p>{preview}</p>
      <details className="task-evidence-disclosure"><summary>展开完整{label}</summary><p>{value}</p></details>
    </>}
  </div>;
}
