import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

/**
 * Buttons are pills. One primary (ink) button per screen; links and selection use the accent colour instead.
 * Three variants are not pills: `link` is an action written as a link inside text, `row` is a row or card that picks
 * what the page shows (aria-pressed or aria-current marks the chosen one), `tab` is one tab in a strip (aria-selected).
 * They take the `inline` size unless another is given: no height, padding or type size of their own.
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border-0 font-medium outline-none transition-[background-color,opacity,box-shadow] duration-150 focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-foreground text-background hover:opacity-90",
        secondary: "bg-field text-foreground hover:bg-selected",
        ghost: "bg-transparent text-text-secondary hover:bg-field hover:text-foreground",
        danger: "bg-danger-soft text-destructive hover:bg-selected",
        link: "rounded-sm bg-transparent font-normal text-primary underline-offset-4 hover:underline disabled:text-muted-foreground disabled:opacity-100",
        row: "w-full justify-start whitespace-normal rounded-md bg-transparent text-left font-normal text-text-secondary hover:bg-selected hover:text-foreground aria-pressed:bg-selected aria-pressed:font-medium aria-pressed:text-foreground aria-[current=true]:bg-selected aria-[current=true]:font-medium aria-[current=true]:text-foreground",
        tab: "rounded-md bg-transparent px-2.5 py-1 text-small font-normal text-text-secondary hover:bg-selected aria-selected:bg-selected aria-selected:text-foreground",
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
