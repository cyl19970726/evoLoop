// Code blocks (Task 5415aed3): a head line with the language the fence named, an icon button that wraps the lines of this block, and an icon button that
// copies its original text; a diff block colours its added, removed and hunk lines. No general syntax highlighter (the bundle budget). The Markdown text
// is drawn as an HTML string, so the head is plain markup with data attributes and one delegated click handler (`onCodeClick`) does the work; the
// message a person sent draws the same markup through `CodeBlock`.
import { cn } from "@evoloop/ui";
import type { MouseEvent } from "react";
import { codeBlockHtml } from "./codeBlockHtml";

/** The same block for a React text (the message a person sent): same head, copy and wrap, on the bubble's own colour. */
export function CodeBlock({ code, info = "" }: { code: string; info?: string }) {
  return <div onClick={onCodeClick} dangerouslySetInnerHTML={{ __html: codeBlockHtml(code, info) }}
    className={cn("my-1 max-w-full font-mono text-caption leading-(--leading-body) [&_pre]:overflow-x-auto [&_pre]:text-caption [&_.code-block]:my-0", codeBlockProse("current"))} data-message-code="" />;
}

const resetLater = new WeakMap<Element, number>();
/** Clicks on the head buttons of a code block (delegated from the element that holds the blocks). */
export function onCodeClick(event: MouseEvent<HTMLElement>): void {
  const target = event.target as Element | null;
  const button = target?.closest?.("button[data-code-copy], button[data-code-wrap]") as HTMLButtonElement | null;
  if (!button) return;
  const block = button.closest("[data-code-block]");
  if (!block) return;
  if (button.hasAttribute("data-code-wrap")) {
    const wrapped = block.getAttribute("data-wrap") !== "true";
    if (wrapped) block.setAttribute("data-wrap", "true"); else block.removeAttribute("data-wrap");
    button.setAttribute("aria-pressed", String(wrapped));
    return;
  }
  const text = block.querySelector("pre code")?.textContent ?? "";
  const label = button.querySelector("[data-copy-label]");
  const say = (value: string, ms: number) => {
    if (!label) return;
    label.textContent = value;
    window.clearTimeout(resetLater.get(button));
    resetLater.set(button, window.setTimeout(() => { label.textContent = "复制"; }, ms));
  };
  void (async () => {
    try { await navigator.clipboard.writeText(text); say("已复制", 1600); }
    catch { say("复制失败", 2400); }
  })();
}

/** Look of the blocks, relative to the element that holds them; `surface` is the block's ground. */
export const codeBlockProse = (surface: "muted" | "current") => cn(
  "[&_.code-block]:my-4 [&_.code-block]:overflow-hidden [&_.code-block]:rounded-lg",
  surface === "muted" ? "[&_.code-block]:bg-muted" : "[&_.code-block]:bg-current/10",
  "[&_.code-head]:flex [&_.code-head]:min-h-7 [&_.code-head]:items-center [&_.code-head]:justify-between [&_.code-head]:gap-2 [&_.code-head]:px-3 [&_.code-head]:pt-1.5 [&_.code-head]:text-caption",
  "[&_.code-lang]:min-w-0 [&_.code-lang]:truncate [&_.code-lang]:font-mono [&_.code-lang]:opacity-80",
  "[&_.code-tools]:ml-auto [&_.code-tools]:flex [&_.code-tools]:shrink-0 [&_.code-tools]:items-center [&_.code-tools]:gap-1",
  "[&_.code-tools_button]:inline-flex [&_.code-tools_button]:h-6 [&_.code-tools_button]:min-w-6 [&_.code-tools_button]:cursor-pointer [&_.code-tools_button]:items-center [&_.code-tools_button]:justify-center [&_.code-tools_button]:gap-1 [&_.code-tools_button]:rounded-md [&_.code-tools_button]:border-0 [&_.code-tools_button]:bg-transparent [&_.code-tools_button]:px-1.5 [&_.code-tools_button]:text-caption [&_.code-tools_button]:text-current [&_.code-tools_button]:opacity-80 [&_.code-tools_button]:outline-none hover:[&_.code-tools_button]:bg-current/10 hover:[&_.code-tools_button]:opacity-100 focus-visible:[&_.code-tools_button]:shadow-[var(--focus-ring)]",
  "[&_.code-tools_button[aria-pressed=true]]:bg-current/15 [&_.code-tools_button[aria-pressed=true]]:opacity-100",
  "[&_.code-block_pre]:m-0 [&_.code-block_pre]:rounded-none [&_.code-block_pre]:bg-transparent [&_.code-block_pre]:px-3 [&_.code-block_pre]:pb-3 [&_.code-block_pre]:pt-1",
  "[&_.code-block[data-wrap=true]_pre]:overflow-x-visible [&_.code-block[data-wrap=true]_pre]:whitespace-pre-wrap [&_.code-block[data-wrap=true]_pre]:[overflow-wrap:anywhere]",
  "[&_.diff-add]:text-primary [&_.diff-del]:text-destructive [&_.diff-hunk]:text-text-secondary");
