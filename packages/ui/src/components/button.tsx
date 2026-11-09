import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

/** Buttons are pills. One primary (ink) button per screen; links and selection use the accent colour instead. */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border-0 font-medium outline-none transition-[background-color,opacity,box-shadow] duration-150 focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-foreground text-background hover:opacity-90",
        secondary: "bg-field text-foreground hover:bg-selected",
        ghost: "bg-transparent text-text-secondary hover:bg-field hover:text-foreground",
        danger: "bg-danger-soft text-destructive hover:bg-selected",
      },
      size: {
        default: "h-9 px-4 text-small [&_svg]:size-4",
        compact: "h-[30px] px-3 text-label [&_svg]:size-3.5",
        icon: "size-9 p-0 [&_svg]:size-[18px]",
        "icon-compact": "size-8 p-0 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element (for example a link) with button styling. */
  asChild?: boolean | undefined;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, type, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} type={asChild ? undefined : type ?? "button"} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
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
