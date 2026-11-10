import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Check, Minus } from "lucide-react";
import { cn } from "../lib/cn";

// Checkbox and radio: 16px marks, checked in the accent colour. Put the mark inside a <label> with its text (or point a
// label at its id) so the text names it and a click on the text toggles it; Space toggles, Enter does nothing, as with
// the browser's own controls. Inside a <form> Radix adds a hidden input, so form submission still carries the value.
const mark =
  "peer inline-flex size-4 shrink-0 cursor-pointer items-center justify-center border-0 bg-raised p-0 text-primary-foreground shadow-[inset_0_0_0_1.5px_var(--border-strong)] outline-none transition-[background-color,box-shadow] duration-150 focus-visible:shadow-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:shadow-none data-[state=indeterminate]:bg-primary data-[state=indeterminate]:shadow-none";

export type CheckboxProps = React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>;

/** A checkbox (role checkbox, aria-checked). `onCheckedChange` receives true, false or "indeterminate". */
export const Checkbox = React.forwardRef<React.ComponentRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root ref={ref} className={cn(mark, "rounded-sm", className)} {...props}>
    <CheckboxPrimitive.Indicator className="flex items-center justify-center">
      {props.checked === "indeterminate" ? <Minus aria-hidden="true" className="size-3" strokeWidth={3} /> : <Check aria-hidden="true" className="size-3" strokeWidth={3} />}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";

export type RadioGroupProps = React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>;

/** One choice out of several (role radiogroup). Arrow keys move and choose, Tab leaves the group, as with native radios. */
export const RadioGroup = React.forwardRef<React.ComponentRef<typeof RadioGroupPrimitive.Root>, RadioGroupProps>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn("flex flex-col gap-1.5", className)} {...props} />
));
RadioGroup.displayName = "RadioGroup";

export type RadioGroupItemProps = React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>;

/** One option of a RadioGroup (role radio, aria-checked); `value` is what the group's `onValueChange` receives. */
export const RadioGroupItem = React.forwardRef<React.ComponentRef<typeof RadioGroupPrimitive.Item>, RadioGroupItemProps>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item ref={ref} className={cn(mark, "rounded-full", className)} {...props}>
    <RadioGroupPrimitive.Indicator className="block size-1.5 rounded-full bg-primary-foreground" />
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = "RadioGroupItem";
