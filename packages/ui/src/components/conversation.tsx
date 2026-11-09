import * as React from "react";
import { Check, ChevronRight, CornerDownRight, LoaderCircle, X } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { CollapsibleRow } from "./list";

/* The conversation flow of an agent page. Tasks and documents reuse these rows for their progress timelines. */

/** An agent mentioned inside a message, shown as an inline mark. */
export function Mention({ name, className }: { name: string; className?: string | undefined }) {
  return <span className={cn("rounded-md bg-[color-mix(in_srgb,var(--accent)_26%,transparent)] px-1.5 py-px font-medium", className)}>@{name}</span>;
}

export interface MessageBubbleProps {
  children: React.ReactNode;
  /** Shown under the bubble, for example 已转给架构 · 已送达. */
  footer?: React.ReactNode | undefined;
  className?: string | undefined;
}

/** What a person sent: a dark bubble on the right. */
export function MessageBubble({ children, footer, className }: MessageBubbleProps) {
  return (
    <div className={cn("flex max-w-[86%] flex-col items-end gap-1.5 self-end", className)}>
      <div className="max-w-full whitespace-pre-wrap break-words rounded-[20px_20px_6px_20px] bg-user-bubble px-4 py-[11px] text-small leading-[1.65] text-on-user-bubble">{children}</div>
      {footer && <div className="flex items-center gap-1.5 text-caption text-muted-foreground">{footer}</div>}
    </div>
  );
}

/** What an agent wrote: plain prose, no bubble. Pass rendered Markdown as children. */
export function AgentMessage({ children, className }: { children: React.ReactNode; className?: string | undefined }) {
  return <div className={cn("text-[15px] leading-[1.8] text-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_p+p]:mt-3", className)}>{children}</div>;
}

export interface ToolStep {
  text: string;
  /** Right-aligned detail such as a duration or +12 −3. */
  meta?: string | undefined;
  failed?: boolean | undefined;
  /** Still running: a spinner instead of a check. */
  running?: boolean | undefined;
  /** Commands and paths read better in monospace. */
  code?: boolean | undefined;
  /** Stable key, for steps that change while shown. */
  id?: string | undefined;
  /** Stays in sight under the summary while the list is folded: a failure, the step running now. */
  pinned?: boolean | undefined;
  /** A small control at the end of the row, such as 查看详情. */
  action?: React.ReactNode | undefined;
  /** Shown under the row when set, for example the step's input and output opened by its action. */
  detail?: React.ReactNode | undefined;
  /** Attributes for the row itself, such as data hooks the page uses to keep the reading position. */
  rowProps?: (React.HTMLAttributes<HTMLLIElement> & Record<`data-${string}`, string | undefined>) | undefined;
}

export interface ToolSummaryProps {
  /** For example 执行了 5 个指令、读了 3 个文件. */
  summary: React.ReactNode;
  steps: ToolStep[];
  defaultOpen?: boolean | undefined;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Replaces the failure count after the summary, for example ，正在进行，1 次失败. */
  status?: React.ReactNode | undefined;
  className?: string | undefined;
  triggerClassName?: string | undefined;
  listClassName?: string | undefined;
}

function StepRow({ step }: { step: ToolStep }) {
  const { className, ...rowProps } = step.rowProps ?? {};
  return (
    <li {...rowProps} className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cn("flex w-4 shrink-0 justify-center", step.failed ? "text-destructive" : "text-muted-foreground")}>
          {step.failed ? <X className="size-3.5" /> : step.running ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Check className="size-3.5" />}
        </span>
        {step.failed ? <span className="sr-only">失败：</span> : step.running ? <span className="sr-only">进行中：</span> : null}
        <span className={cn("min-w-0 flex-1 truncate", step.code && "font-mono text-caption", step.failed && "text-destructive")}>{step.text}</span>
        {step.meta && <span className="shrink-0 text-caption text-muted-foreground tabular-nums">{step.meta}</span>}
        {step.action}
      </div>
      {step.detail}
    </li>
  );
}

const stepList = "m-0 flex list-none flex-col gap-[7px] rounded-md bg-muted px-3.5 py-2.5 text-label text-text-secondary";

/** Tool calls folded into one muted line; failures are counted in the summary and marked in the steps. Pinned steps
 *  stay in sight while the list is folded. */
export function ToolSummary({ summary, steps, defaultOpen, open, onOpenChange, status, className, triggerClassName, listClassName }: ToolSummaryProps) {
  const failed = steps.filter(step => step.failed).length;
  const pinned = steps.filter(step => step.pinned);
  const key = (step: ToolStep, index: number) => step.id ?? String(index);
  return (
    <CollapsibleRow
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className={className}
      triggerClassName={triggerClassName}
      summary={<span>{summary}{status ?? (failed > 0 && <span className="text-destructive">，{failed} 次失败</span>)}</span>}
      folded={pinned.length > 0 && <ol className={cn(stepList, "ml-[18px]", listClassName)}>{pinned.map((step, index) => <StepRow key={key(step, index)} step={step} />)}</ol>}
    >
      <ol className={cn(stepList, listClassName)}>
        {steps.map((step, index) => <StepRow key={key(step, index)} step={step} />)}
      </ol>
    </CollapsibleRow>
  );
}

export interface NestedActivityProps {
  /** Avatar of the sub-agent, about 18px. */
  avatar?: React.ReactNode | undefined;
  /** For example 子智能体 · 代码审查 · 执行了 2 个指令. */
  summary: string;
  children: React.ReactNode;
  defaultOpen?: boolean | undefined;
  className?: string | undefined;
}

/** Work a sub-agent did, indented under the line that started it. */
export function NestedActivity({ avatar, summary, children, defaultOpen, className }: NestedActivityProps) {
  return (
    <CollapsibleRow defaultOpen={defaultOpen} className={className} summary={<span className="inline-flex items-center gap-2">{avatar}{summary}</span>}>
      <div className="flex flex-col gap-3 border-l-2 border-border py-1 pl-4">{children}</div>
    </CollapsibleRow>
  );
}

export interface LiveStatusLineProps {
  avatar?: React.ReactNode | undefined;
  /** What is happening now, for example 正在运行单元测试. */
  text: string;
  /** For example 1 分 04 秒. */
  elapsed?: string | undefined;
  /** After the text, for example a link to the task this turn works on. */
  children?: React.ReactNode | undefined;
  className?: string | undefined;
}

/** One line at the end of the flow saying what is running right now. The ticking time is not announced. */
export function LiveStatusLine({ avatar, text, elapsed, children, className }: LiveStatusLineProps) {
  return (
    <div role="status" aria-live="polite" className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-secondary", className)}>
      {avatar}
      <span className="relative flex size-2 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
      {elapsed && <span aria-hidden="true" className="text-muted-foreground tabular-nums">· {elapsed}</span>}
      {children && <span className="min-w-0">· {children}</span>}
    </div>
  );
}

export interface QuestionOption {
  key: string;
  label: string;
}

export interface QuestionCardProps {
  question: string;
  options: QuestionOption[];
  /** Who may answer and until when, for example 只有项目负责人能回答 · 今天 18:00 前有效. */
  note?: string | undefined;
  /** Set once answered; the card then folds into one line. */
  answer?: string | undefined;
  /** Called with the chosen option's label, or the text written under 其他. */
  onSubmit?: ((answer: string) => void) | undefined;
  className?: string | undefined;
}

/** A question an agent stopped to ask, inside the flow. Choosing and submitting sends the answer as a reply. */
export function QuestionCard({ question, options, note, answer, onSubmit, className }: QuestionCardProps) {
  const [choice, setChoice] = React.useState<string | null>(null);
  const [other, setOther] = React.useState("");
  const groupId = React.useId();
  if (answer !== undefined) {
    return (
      <p className={cn("m-0 flex items-center gap-1.5 text-label text-muted-foreground", className)}>
        <CornerDownRight aria-hidden="true" className="size-3.5" />已回答：{answer}
      </p>
    );
  }
  const otherKey = "__other";
  const value = choice === otherKey ? other.trim() : options.find(option => option.key === choice)?.label ?? "";
  return (
    <section aria-labelledby={`${groupId}-q`} className={cn("flex flex-col gap-2 rounded-xl bg-raised p-4 shadow-md", className)}>
      <p id={`${groupId}-q`} className="m-0 px-0.5 pb-1 font-semibold text-foreground">{question}</p>
      <div role="radiogroup" aria-labelledby={`${groupId}-q`} className="flex flex-col gap-1.5">
        {[...options, { key: otherKey, label: "其他" }].map((option, index) => {
          const selected = choice === option.key;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setChoice(option.key)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 px-3 py-2.5 text-left text-small outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
                selected ? "bg-accent text-foreground" : "bg-muted text-text-secondary hover:bg-field",
              )}
            >
              <span aria-hidden="true" className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-[7px] text-caption font-semibold", selected ? "bg-primary text-primary-foreground" : "bg-field text-text-secondary")}>
                {option.key === otherKey ? String.fromCharCode(65 + index) : option.key}
              </span>
              {option.label}
            </button>
          );
        })}
      </div>
      {choice === otherKey && (
        <textarea
          aria-label="其他回答"
          value={other}
          onChange={event => setOther(event.target.value)}
          placeholder="直接写你的回答"
          className="min-h-16 w-full rounded-md border-0 bg-field px-3 py-2.5 text-small text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-[var(--focus-ring)]"
        />
      )}
      <div className="flex items-center gap-2 pt-1">
        {note && <span className="text-caption text-muted-foreground">{note}</span>}
        <Button variant="primary" className="ml-auto" disabled={!value} onClick={() => value && onSubmit?.(value)}>提交</Button>
      </div>
    </section>
  );
}

export type TodoStatus = "done" | "active" | "todo";

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

/** The agent's checklist, pinned above the composer. Folds into one line once everything is done. */
export function TodoList({ items, note, className }: { items: TodoItem[]; note?: React.ReactNode | undefined; className?: string | undefined }) {
  const done = items.filter(item => item.status === "done").length;
  const list = (
    <ol className="m-0 flex list-none flex-col gap-[7px] p-0">
      {items.map((item, index) => (
        <li key={index} className={cn("flex items-center gap-2.5", item.status === "done" ? "text-muted-foreground" : item.status === "active" ? "text-foreground" : "text-text-secondary")}>
          <span
            aria-hidden="true"
            className={cn(
              "flex size-[15px] shrink-0 items-center justify-center rounded-full",
              item.status === "done" && "bg-text-secondary text-background",
              item.status === "active" && "shadow-[inset_0_0_0_1.6px_var(--accent)]",
              item.status === "todo" && "shadow-[inset_0_0_0_1.6px_var(--border-strong)]",
            )}
          >
            {item.status === "done" && <Check className="size-2.5" strokeWidth={3} />}
          </span>
          <span className={cn(item.status === "done" && "line-through")}>
            <span className="sr-only">{item.status === "done" ? "已完成：" : item.status === "active" ? "进行中：" : "待做："}</span>
            {item.text}
          </span>
        </li>
      ))}
    </ol>
  );
  return (
    <section aria-label="待办清单" className={cn("rounded-[16px] bg-muted px-4 py-3 text-label", className)}>
      {note && <p className="m-0 mb-2 text-caption text-muted-foreground">{note}</p>}
      {done === items.length && items.length > 0
        ? <CollapsibleRow summary={`待办 ${done} / ${items.length} 已完成`}>{list}</CollapsibleRow>
        : list}
    </section>
  );
}

export interface QueuedMessage {
  id: string;
  text: string;
}

export interface QueuedMessagesProps {
  items: QueuedMessage[];
  /** For example 这一轮结束后按顺序送达. */
  note?: string | undefined;
  onEdit?: ((id: string) => void) | undefined;
  onCancel?: ((id: string) => void) | undefined;
  className?: string | undefined;
}

/** Messages waiting for the next turn; each can be edited or withdrawn until it is delivered. */
export function QueuedMessages({ items, note = "这一轮结束后按顺序送达", onEdit, onCancel, className }: QueuedMessagesProps) {
  if (items.length === 0) return null;
  return (
    <section aria-label="排队消息" className={cn("flex flex-col gap-2 rounded-[16px] bg-muted px-3.5 py-3", className)}>
      <span className="text-caption text-muted-foreground">排队中 · {note}</span>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {items.map((item, index) => (
          <li key={item.id} className="flex items-start gap-2.5 text-small">
            <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-field text-[11px] text-text-secondary">{index + 1}</span>
            <span className="min-w-0 flex-1 break-words">{item.text}</span>
            {onEdit && <button type="button" onClick={() => onEdit(item.id)} className="cursor-pointer border-0 bg-transparent p-0 text-caption text-muted-foreground hover:text-foreground">编辑</button>}
            {onCancel && <button type="button" onClick={() => onCancel(item.id)} className="cursor-pointer border-0 bg-transparent p-0 text-caption text-muted-foreground hover:text-destructive">撤回</button>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export interface TurnSummaryProps {
  /** What this turn produced, for example 改了 3 个文件. */
  produced: string;
  delivered?: string | undefined;
  /** Who moves next, for example 下一步等你验收. */
  next?: string | undefined;
  className?: string | undefined;
}

/** One line closing a turn: output, delivery, and who is next. */
export function TurnSummary({ produced, delivered, next, className }: TurnSummaryProps) {
  return (
    <p className={cn("m-0 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2.5 text-label text-text-secondary", className)}>
      <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
      <span>本轮：{produced}</span>
      {delivered && <span>· {delivered}</span>}
      {next && <span className="font-medium text-foreground">· {next}</span>}
    </p>
  );
}
