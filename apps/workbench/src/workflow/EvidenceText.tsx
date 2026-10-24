import type { ReactNode } from "react";

export function evidencePreview(value: string): string | null {
  const points = Array.from(value);
  if (points.length <= 240 && value.split("\n").length <= 8) return null;
  return points.slice(0, 160).join("") + "…";
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
