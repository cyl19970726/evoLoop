// @evoloop/ui: the workbench design system. Components here know nothing about evoLoop business objects;
// mapping Task, Run or Delivery states onto these props happens in the workbench's shared layer.
export { cn } from "./lib/cn";
export { Button, IconButton, buttonVariants, type ButtonProps, type IconButtonProps } from "./components/button";
export { Field, Input, Select, Textarea, type FieldProps, type SelectProps } from "./components/field";
export { Checkbox, RadioGroup, RadioGroupItem, type CheckboxProps, type RadioGroupProps, type RadioGroupItemProps } from "./components/choice";
export { StatusTag, Badge, CountDot, Notice, type StatusTone, type StatusTagProps, type NoticeTone, type NoticeProps } from "./components/status";
export { EmptyState, LoadingState, RefreshingIndicator, ErrorState, UnknownState, type EmptyStateProps, type LoadingStateProps, type ErrorStateProps, type UnknownStateProps } from "./components/states";
export { ListRow, CollapsibleRow, type ListRowProps, type CollapsibleRowProps } from "./components/list";
export {
  Tabs, TabsList, TabsTrigger, TabsContent,
  TooltipProvider, Tooltip, TooltipTrigger, TooltipContent,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator,
  HoverCard, HoverCardTrigger, HoverCardContent,
  Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription, DialogFooter, ConfirmDialog, type ConfirmDialogProps,
  Sheet, SheetTrigger, SheetClose, SheetContent, SheetTitle, SheetDescription,
} from "./components/overlays";
export {
  AgentAvatar, AgentMark, PersonAvatar, agentMarkColors, avatarLook, avatarRoleBackgrounds, systemLooks,
  type AgentAvatarProps, type AgentMarkColor, type AgentMarkProps, type AvatarLook, type PersonAvatarProps,
} from "./components/avatar";
export { Logo, type LogoProps } from "./components/logo";
export {
  Mention, MessageBubble, AgentMessage, ToolSummary, NestedActivity, LiveStatusLine, QuestionCard, TodoList, QueuedMessages, TurnSummary,
  type MessageBubbleProps, type ToolStep, type ToolSummaryProps, type NestedActivityProps, type LiveStatusLineProps, type QuestionOption,
  type QuestionCardProps, type TodoItem, type TodoStatus, type QueuedMessage, type QueuedMessagesProps, type TurnSummaryProps,
} from "./components/conversation";
export {
  Composer, composerMenu, matchQuery, type ComposerSendMode,
  type ComposerProps, type ComposerCommand, type ComposerAgent, type ComposerAttachment, type ComposerMenu,
} from "./components/composer";
