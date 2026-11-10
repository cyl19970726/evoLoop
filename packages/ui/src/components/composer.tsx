import * as React from "react";
import { ArrowUp, FileText, ListChecks, Plus, Slash, Sparkles, Square, X } from "lucide-react";
import { cn } from "../lib/cn";

/* The agent page composer. Enter sends; while a turn runs the message is queued (or added to the turn where the
   runtime supports it — the caller decides, says so with `sendMode` and in `meta`). Cmd/Ctrl+Enter queues for the
   next turn when the caller handles `onQueue`. Typing / opens skills and commands; typing @ picks another agent to
   send this message to as well. */

export interface ComposerCommand {
  id: string;
  /** Chinese name shown first. */
  name: string;
  description?: string | undefined;
  /** The original name (skill name or /command), shown small on the right. */
  slug: string;
  kind: "skill" | "command";
}

export interface ComposerAgent {
  id: string;
  name: string;
  /** For example 空闲, 运行中 · 验收任务页截图. */
  state: string;
  avatar?: React.ReactNode | undefined;
  /** Idle agents receive at once; busy ones queue. */
  delivery: "now" | "queued";
  /** System agents (统筹) are listed after a divider. */
  system?: boolean | undefined;
}

export interface ComposerAttachment {
  id: string;
  label: string;
  kind: "task" | "document" | "skill";
}

export type ComposerMenu = { kind: "command"; query: string; start: number } | { kind: "mention"; query: string; start: number } | null;

/** Which menu the text before the caret asks for: "/" at the very start, or "@" after a space or at the start. */
export function composerMenu(value: string, caret: number = value.length): ComposerMenu {
  const before = value.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "command", query: slash[1] ?? "", start: 0 };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "mention", query: at[2] ?? "", start: before.length - (at[2]?.length ?? 0) - 1 };
  return null;
}

/** Case-insensitive match on any of the given fields. */
export function matchQuery(query: string, ...fields: (string | undefined)[]) {
  const q = query.trim().toLowerCase();
  return q === "" || fields.some(field => field?.toLowerCase().includes(q));
}

/** What Enter does with the text: start or send (`send`), add to the running turn (`steer`), or wait for the next turn (`queue`). */
export type ComposerSendMode = "send" | "steer" | "queue";
const sendLabels: Record<ComposerSendMode, string> = { send: "发送", steer: "补充到这一轮", queue: "发送，排到下一轮" };

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Sends the current text (Enter or the send button); the caller clears `value` once the message is saved. */
  onSend: (value: string) => void;
  /** Cmd/Ctrl+Enter: queue the text for the next turn. Without it Cmd/Ctrl+Enter does nothing; see `onQueueUnavailable`. */
  onQueue?: ((value: string) => void) | undefined;
  /** Cmd/Ctrl+Enter was pressed while nothing can be queued: the caller says why. */
  onQueueUnavailable?: (() => void) | undefined;
  /** Names what Enter does; defaults to `queue` while running and `send` otherwise. */
  sendMode?: ComposerSendMode | undefined;
  /** A send is in flight: keys and the send button wait, the text stays editable. */
  busy?: boolean | undefined;
  /** Accessible name of the text box. */
  label?: string | undefined;
  maxLength?: number | undefined;
  /** Stops the current turn. The stop button shows while `running` and the box is empty. */
  onStop?: (() => void) | undefined;
  running?: boolean | undefined;
  placeholder?: string | undefined;
  /** Chips above the text: referenced tasks and documents, and a chosen skill. */
  attachments?: ComposerAttachment[] | undefined;
  onRemoveAttachment?: ((id: string) => void) | undefined;
  /** The + button: attach a task, document or file. */
  onAttach?: (() => void) | undefined;
  commands?: ComposerCommand[] | undefined;
  onPickCommand?: ((command: ComposerCommand) => void) | undefined;
  agents?: ComposerAgent[] | undefined;
  onPickAgent?: ((agent: ComposerAgent) => void) | undefined;
  /** One line under the box: model, context use, queue, keys. */
  meta?: React.ReactNode | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** Which skills the menu lists, for the heading, for example 功能开发可用. */
  skillScope?: string | undefined;
}

type MenuItem = { type: "command"; item: ComposerCommand } | { type: "agent"; item: ComposerAgent };

export function Composer({
  value, onChange, onSend, onQueue, onQueueUnavailable, sendMode, busy, label = "消息", maxLength, onStop, running, placeholder = "发消息，/ 调用技能，@ 转给其他智能体",
  attachments = [], onRemoveAttachment, onAttach, commands = [], onPickCommand, agents = [], onPickAgent, meta, disabled, className, skillScope,
}: ComposerProps) {
  const mode: ComposerSendMode = sendMode ?? (running ? "queue" : "send");
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = React.useState<number | null>(null);
  const [active, setActive] = React.useState(0);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const listId = React.useId();

  const menu = dismissed === value ? null : composerMenu(value, caret ?? value.length);
  const items: MenuItem[] = menu?.kind === "command"
    ? commands.filter(command => matchQuery(menu.query, command.name, command.slug, command.description)).map(item => ({ type: "command" as const, item }))
    : menu?.kind === "mention"
      ? agents.filter(agent => matchQuery(menu.query, agent.name)).map(item => ({ type: "agent" as const, item }))
      : [];
  const open = menu !== null && items.length > 0;
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  React.useEffect(() => { setActive(0); }, [menu?.kind, menu?.query]);
  React.useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  function pick(entry: MenuItem) {
    if (!menu) return;
    if (entry.type === "command") {
      onChange(value.slice(menu.query.length + 1).replace(/^\s+/, ""));
      onPickCommand?.(entry.item);
    } else {
      const end = caret ?? value.length;
      const next = `${value.slice(0, menu.start)}@${entry.item.name} ${value.slice(end)}`;
      onChange(next);
      onPickAgent?.(entry.item);
      const position = menu.start + entry.item.name.length + 2;
      requestAnimationFrame(() => { textarea.current?.setSelectionRange(position, position); setCaret(position); });
    }
    textarea.current?.focus();
  }

  function send() {
    if (!value.trim() || disabled || busy) return;
    onSend(value);
  }

  function queue() {
    if (!value.trim() || disabled || busy || !onQueue) return;
    onQueue(value);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Confirming an IME candidate is not sending; Safari reports it as keyCode 229 rather than isComposing.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (open) {
      if (event.key === "ArrowDown") { event.preventDefault(); setActive((activeIndex + 1) % items.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setActive((activeIndex - 1 + items.length) % items.length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); const entry = items[activeIndex]; if (entry) pick(entry); return; }
      if (event.key === "Escape") { event.preventDefault(); setDismissed(value); return; }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (onQueue) queue(); else if (value.trim()) onQueueUnavailable?.();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); return; }
    if (event.key === "Escape" && running && onStop && !value) { event.preventDefault(); onStop(); }
  }

  const skills = items.filter(entry => entry.type === "command" && entry.item.kind === "skill");
  const commandItems = items.filter(entry => entry.type === "command" && entry.item.kind === "command");
  const businessAgents = items.filter(entry => entry.type === "agent" && !entry.item.system);
  const systemAgents = items.filter(entry => entry.type === "agent" && entry.item.system);
  const optionId = (index: number) => `${listId}-option-${index}`;
  const showStop = running && !value.trim() && onStop;

  function renderGroup(title: string | null, group: MenuItem[]) {
    if (group.length === 0) return null;
    return (
      <>
        {title && <li role="presentation" className="px-2.5 pb-1 pt-2 text-caption text-muted-foreground">{title}</li>}
        {group.map(entry => {
          const index = items.indexOf(entry);
          const selected = index === activeIndex;
          return (
            <li
              key={`${entry.type}-${entry.item.id}`}
              id={optionId(index)}
              role="option"
              aria-selected={selected}
              onMouseDown={event => { event.preventDefault(); pick(entry); }}
              onMouseEnter={() => setActive(index)}
              className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2", selected && "bg-selected")}
            >
              {entry.type === "command" ? (
                <>
                  <span aria-hidden="true" className={cn("flex size-7 shrink-0 items-center justify-center rounded-sm", entry.item.kind === "skill" && selected ? "bg-accent text-primary" : "bg-muted text-text-secondary")}>
                    {entry.item.kind === "skill" ? <Sparkles className="size-3.5" /> : <Slash className="size-3.5" />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-foreground">{entry.item.name}</span>
                    {entry.item.description && <span className="truncate text-caption text-muted-foreground">{entry.item.description}</span>}
                  </span>
                  <span className="shrink-0 font-mono text-caption text-muted-foreground">{entry.item.slug}</span>
                </>
              ) : (
                <>
                  {entry.item.avatar}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-foreground">{entry.item.name}</span>
                    <span className="truncate text-caption text-muted-foreground">{entry.item.state}</span>
                  </span>
                  {!entry.item.system && <span className={cn("shrink-0 text-caption", entry.item.delivery === "now" ? "text-primary" : "text-muted-foreground")}>{entry.item.delivery === "now" ? "立即送达" : "排队"}</span>}
                </>
              )}
            </li>
          );
        })}
      </>
    );
  }

  return (
    <div className={cn("relative flex flex-col gap-2", className)}>
      {open && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-2 rounded-lg bg-raised p-1.5 text-small shadow-md">
          <ul id={listId} role="listbox" aria-label={menu?.kind === "command" ? "技能与命令" : "选择智能体"} className="m-0 flex max-h-80 list-none flex-col overflow-y-auto p-0">
            {menu?.kind === "command" ? (
              <>
                {renderGroup(skillScope ? `技能 · ${skillScope}` : "技能", skills)}
                {skills.length > 0 && commandItems.length > 0 && <li role="presentation" className="mx-2.5 my-1 h-px bg-border" />}
                {renderGroup("命令", commandItems)}
              </>
            ) : (
              <>
                {renderGroup("转给智能体", businessAgents)}
                {businessAgents.length > 0 && systemAgents.length > 0 && <li role="presentation" className="mx-2.5 my-1 h-px bg-border" />}
                {renderGroup(null, systemAgents)}
              </>
            )}
          </ul>
          <p className="m-0 px-2.5 pb-1 pt-1.5 text-caption text-muted-foreground">↑↓ 选择 · 回车确认 · Esc 关闭{menu?.kind === "mention" ? " · 可以 @ 多个" : ""}</p>
        </div>
      )}

      <div className={cn("flex flex-col gap-2 rounded-xl bg-raised px-2.5 py-2 shadow-lg transition-shadow duration-150", open && "shadow-[var(--focus-ring),var(--shadow-panel)]", disabled && "opacity-60")}>
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pt-0.5">
            {attachments.map(attachment => (
              <span key={attachment.id} className="inline-flex items-center gap-1.5 rounded-full bg-muted py-0.5 pl-2.5 pr-1.5 text-caption text-text-secondary">
                {attachment.kind === "task" ? <ListChecks aria-hidden="true" className="size-3" /> : attachment.kind === "document" ? <FileText aria-hidden="true" className="size-3" /> : <Sparkles aria-hidden="true" className="size-3 text-primary" />}
                {attachment.label}
                {onRemoveAttachment && (
                  <button type="button" aria-label={`移除 ${attachment.label}`} onClick={() => onRemoveAttachment(attachment.id)} className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground hover:bg-field hover:text-foreground">
                    <X aria-hidden="true" className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2.5">
          {onAttach && (
            <button type="button" aria-label="添加任务、文档或文件" onClick={onAttach} disabled={disabled} className="inline-flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-muted text-text-secondary outline-none hover:bg-field focus-visible:shadow-[var(--focus-ring)]">
              <Plus aria-hidden="true" className="size-4" />
            </button>
          )}
          <textarea
            ref={textarea}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={label}
            maxLength={maxLength}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open ? optionId(activeIndex) : undefined}
            onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart); setDismissed(null); }}
            onSelect={event => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onBlur={() => setDismissed(value)}
            onFocus={() => setDismissed(null)}
            className="max-h-40 min-h-[34px] min-w-0 flex-1 resize-none border-0 bg-transparent px-0.5 py-1.5 text-body leading-(--leading-tight) text-foreground outline-none placeholder:text-muted-foreground"
          />
          {showStop ? (
            <button type="button" aria-label="停止这一轮" title="停止这一轮（Esc）" onClick={onStop} className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-foreground text-background outline-none hover:opacity-90 focus-visible:shadow-[var(--focus-ring)]">
              <Square aria-hidden="true" className="size-3.5 fill-current" strokeWidth={0} />
            </button>
          ) : (
            <button type="button" aria-label={sendLabels[mode]} title={sendLabels[mode]} onClick={send} disabled={!value.trim() || disabled || busy} className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-foreground text-background outline-none hover:opacity-90 focus-visible:shadow-[var(--focus-ring)] disabled:cursor-default disabled:bg-field disabled:text-muted-foreground disabled:opacity-100">
              <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      {meta && <div className="flex flex-wrap justify-center gap-x-3.5 gap-y-1 text-caption text-muted-foreground">{meta}</div>}
    </div>
  );
}
