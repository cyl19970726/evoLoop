import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";

const control =
  "w-full rounded-md border-0 bg-field px-3 text-small text-foreground outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50 aria-[invalid=true]:shadow-[inset_0_0_0_1.5px_var(--danger)]";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(control, "h-9", className)} {...props} />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(control, "min-h-20 py-2.5 leading-[1.55]", className)} {...props} />
));
Textarea.displayName = "Textarea";

/** A native select with the same look as Input; the browser's own list keeps it usable on every device. */
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** 32px tall with label-size text, for toolbars and rails. */
  compact?: boolean | undefined;
}
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(({ className, compact, ...props }, ref) => (
  <span className={cn("relative inline-flex min-w-0", className)}>
    <select ref={ref} className={cn(control, "cursor-pointer appearance-none pr-8", compact ? "h-8 text-label" : "h-9")} {...props} />
    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
  </span>
));
Select.displayName = "Select";

export interface FieldProps {
  label: string;
  /** Explains what to enter. */
  hint?: string | undefined;
  /** States what is wrong and how to fix it. */
  error?: string | undefined;
  /** Renders the control; receives the ids that link it to the label, hint and error. */
  children: (control: { id: string; "aria-describedby"?: string | undefined; "aria-invalid"?: boolean | undefined }) => React.ReactNode;
  className?: string | undefined;
}

/** Label above, hint and error below; the control is wired to all three for screen readers. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = React.useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-label font-semibold text-foreground">{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && <p id={hintId} className="m-0 text-caption text-muted-foreground">{hint}</p>}
      {error && <p id={errorId} className="m-0 text-caption text-destructive">{error}</p>}
    </div>
  );
}
