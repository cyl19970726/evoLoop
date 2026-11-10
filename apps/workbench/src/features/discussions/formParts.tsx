// Small parts the discussion pages share. Sending a discussion write goes through the shared command form
// (shared/command: useCommand and CommandFrame); what is particular to discussions is the baseline each form fixes
// (discussionBaseline.ts).
import type { ReactNode } from "react";
import type { Permission } from "@evoloop/contracts";
import { Select } from "@evoloop/ui";
import type { MutationContext } from "../../shared/command";

export function canWrite(context: MutationContext, permission: Permission): boolean {
  return context.principal.permissions.includes(permission);
}

export const muted = "text-caption text-muted-foreground";

/** A labelled native select that can hold option groups. */
export function SelectField({ label, hint, error, value, onChange, children, disabled }: {
  label: string; hint?: string; error?: string | undefined; value: string; onChange(value: string): void; children: ReactNode; disabled?: boolean;
}) {
  return <label className="flex flex-col gap-1.5">
    <span className="text-label font-semibold text-foreground">{label}</span>
    <Select value={value} disabled={disabled} aria-invalid={error ? true : undefined} onChange={event => onChange(event.target.value)} className="w-full">{children}</Select>
    {hint && <span className={muted}>{hint}</span>}
    {error && <span className="text-caption text-destructive">{error}</span>}
  </label>;
}
