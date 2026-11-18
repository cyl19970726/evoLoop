import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

/**
 * Buttons are pills. One primary (brand, solid terracotta) button per screen; the secondary is the soft brand fill; a selected row or tab is accent-soft (DEC-051). Links stay accent.
 * Three variants are not pills: `link` is an action written as a link inside text, `row` is a row or card that picks
 * what the page shows (aria-pressed or aria-current marks the chosen one), `tab` is one tab in a strip (aria-selected).
 * They take the `inline` size unless another is given: no height, padding or type size of their own.
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border-0 font-medium outline-none transition-[background-color,box-shadow] duration-150 focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-brand text-on-brand hover:bg-brand-hover active:bg-brand-pressed",
        secondary: "bg-brand-soft text-on-brand-soft hover:bg-brand-soft-hover active:bg-brand-soft-pressed",
        ghost: "bg-transparent text-text-secondary hover:bg-field hover:text-foreground",
        danger: "bg-danger-soft text-destructive hover:bg-selected",
        link: "rounded-sm bg-transparent font-normal text-primary underline-offset-4 hover:underline disabled:text-muted-foreground disabled:opacity-100",
        row: "selected-edge w-full justify-start whitespace-normal rounded-md bg-transparent text-left font-normal text-text-secondary hover:bg-selected hover:text-foreground aria-pressed:bg-accent aria-pressed:hover:bg-accent aria-pressed:font-medium aria-pressed:text-accent-strong aria-[current=true]:bg-accent aria-[current=true]:hover:bg-accent aria-[current=true]:font-medium aria-[current=true]:text-accent-strong",
        tab: "rounded-md bg-transparent px-2.5 py-1 text-small font-normal text-text-secondary hover:bg-selected aria-selected:bg-accent aria-selected:hover:bg-accent aria-selected:text-accent-strong aria-selected:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_55%,transparent)] aria-selected:focus-visible:shadow-[var(--focus-ring)]",
      },
      size: {
        default: "h-9 px-4 text-small [&_svg]:size-4",
        compact: "h-(--control-height-compact) px-3 text-label [&_svg]:size-3.5",
        icon: "size-9 p-0 [&_svg]:size-[18px]",
        "icon-compact": "size-8 p-0 [&_svg]:size-4",
        inline: "",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

type Variant = VariantProps<typeof buttonVariants>["variant"];
const inlineVariants: ReadonlyArray<Variant> = ["link", "row", "tab"];

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element (for example a link) with button styling. */
  asChild?: boolean | undefined;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, type, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  const resolvedSize = size ?? (inlineVariants.includes(variant) ? "inline" : undefined);
  return <Comp ref={ref} type={asChild ? undefined : type ?? "button"} className={cn(buttonVariants({ variant, size: resolvedSize }), className)} {...props} />;
});
Button.displayName = "Button";

export interface IconButtonProps extends Omit<ButtonProps, "size" | "aria-label" | "children"> {
  /** Readable name, used for aria-label and the hover hint. Required: an icon alone is not a name. */
  label: string;
  icon: React.ReactNode;
  compact?: boolean | undefined;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(({ label, icon, compact, variant = "ghost", title, ...props }, ref) => (
  <Button ref={ref} variant={variant} size={compact ? "icon-compact" : "icon"} aria-label={label} title={title ?? label} {...props}>
    {icon}
  </Button>
));
IconButton.displayName = "IconButton";
