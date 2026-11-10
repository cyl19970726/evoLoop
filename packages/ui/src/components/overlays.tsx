import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./button";

/* Tabs: a pill segmented control. Use sparingly; a continuous flow is preferred. */
export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export const TabsList = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn("inline-flex items-center gap-0.5 rounded-full bg-field p-1", className)} {...props} />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "h-7 cursor-pointer whitespace-nowrap rounded-full border-0 bg-transparent px-3 text-label text-muted-foreground outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:shadow-[var(--focus-ring)] data-[state=active]:bg-raised data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

/* Tooltip: a short hint on hover or focus. */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<React.ComponentRef<typeof TooltipPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content ref={ref} data-ui="" sideOffset={sideOffset} className={cn("z-50 rounded-md bg-foreground px-2 py-1 text-caption text-background shadow-md animate-in fade-in-0 zoom-in-95", className)} {...props} />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = "TooltipContent";

/* Dropdown menu: secondary actions. Primary actions are never hidden here. */
export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuGroup = DropdownPrimitive.Group;

export const DropdownMenuContent = React.forwardRef<React.ComponentRef<typeof DropdownPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content ref={ref} data-ui="" sideOffset={sideOffset} className={cn("z-50 min-w-44 rounded-lg bg-raised p-1.5 text-foreground shadow-md animate-in fade-in-0 zoom-in-95", className)} {...props} />
  </DropdownPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = React.forwardRef<React.ComponentRef<typeof DropdownPrimitive.Item>, React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { danger?: boolean }>(({ className, danger, ...props }, ref) => (
  <DropdownPrimitive.Item
    ref={ref}
    className={cn("flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-small outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-selected [&_svg]:size-4", danger && "text-destructive", className)}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Label>) {
  return <DropdownPrimitive.Label className={cn("px-2.5 pb-1 pt-1.5 text-caption text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>) {
  return <DropdownPrimitive.Separator className={cn("mx-2.5 my-1 h-px bg-border", className)} {...props} />;
}

/* Hover card: name, kind, status, version and owner of an object link. */
export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

export const HoverCardContent = React.forwardRef<React.ComponentRef<typeof HoverCardPrimitive.Content>, React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>>(({ className, sideOffset = 6, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content ref={ref} data-ui="" sideOffset={sideOffset} className={cn("z-50 w-72 rounded-lg bg-raised p-4 text-small text-foreground shadow-md animate-in fade-in-0 zoom-in-95", className)} {...props} />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = "HoverCardContent";

/* Dialog: confirm a dangerous or rare operation. States the object affected and what happens after confirming. */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlayClass = "fixed inset-0 z-50 bg-[var(--scrim)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

export const DialogContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={overlayClass} />
    <DialogPrimitive.Content
      ref={ref}
      data-ui=""
      className={cn("fixed left-1/2 top-1/2 z-50 flex w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl bg-raised p-6 text-foreground shadow-[var(--shadow-overlay)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95", className)}
      {...props}
    >
      {children}
      <DialogPrimitive.Close aria-label="关闭" className="absolute right-4 top-4 inline-flex size-8 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-text-secondary outline-none hover:bg-field focus-visible:shadow-[var(--focus-ring)]">
        <X aria-hidden="true" className="size-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("m-0 pr-8 text-heading font-semibold leading-(--leading-tight)", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("m-0 text-small leading-(--leading-body) text-text-secondary", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex justify-end gap-2 pt-2", className)} {...props} />;
}

export interface ConfirmDialogProps {
  open: boolean;
  /** The question, naming the object affected: 离开当前项目？ */
  title: string;
  /** What happens after confirming, and what is kept. */
  description?: React.ReactNode | undefined;
  /** A verb for what confirming does: 离开、退出、清空. */
  confirmLabel: string;
  cancelLabel?: string | undefined;
  /** Confirming discards or ends something: the confirm button is drawn as danger. */
  danger?: boolean | undefined;
  onConfirm(): void;
  /** Cancel, Escape, the close button and a click outside all cancel. */
  onCancel(): void;
}

/**
 * Asks before a step that loses something (role alertdialog). Focus starts on the cancel button, so Enter never
 * confirms by accident; when the dialog closes, focus returns to where it was.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "取消", danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <DialogContent role="alertdialog">
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        <DialogFooter>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Sheet: narrow-screen navigation (left) and the right panel; "bottom" is the peek that rises from the bottom edge. */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;

const sheetSides = {
  left: "inset-y-0 left-0 h-full w-[min(320px,86vw)] rounded-r-xl data-[state=open]:slide-in-from-left",
  right: "inset-y-0 right-0 h-full w-[min(380px,92vw)] rounded-l-xl data-[state=open]:slide-in-from-right",
  bottom: "inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl pt-2.5 data-[state=open]:slide-in-from-bottom",
} as const;

export const SheetContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: keyof typeof sheetSides }>(({ side = "right", className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={overlayClass} />
    <DialogPrimitive.Content ref={ref} data-ui="" className={cn("fixed z-50 flex flex-col gap-3 overflow-y-auto bg-raised p-5 text-foreground shadow-[var(--shadow-overlay)] outline-none data-[state=open]:animate-in data-[state=open]:duration-[250ms]", sheetSides[side], className)} {...props}>
      {side === "bottom" && <span aria-hidden="true" className="mx-auto h-[5px] w-10 shrink-0 rounded-full bg-field" />}
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";
