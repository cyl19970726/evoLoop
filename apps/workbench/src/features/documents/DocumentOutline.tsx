// 页内目录: the headings of the rendered Markdown body, read from the page so code blocks and diagrams stay out.
import { useEffect, useState, type RefObject } from "react";
import { Button } from "@evoloop/ui";
import { useContextPanel } from "../../shared/ui/ContextPanel";
import { outlineSelector as selector } from "../../shared/ui/markdownContent";

export function DocumentOutline({ body, revision }: { body: RefObject<HTMLElement | null>; revision: string }) {
  const panel = useContextPanel();
  const [headings, setHeadings] = useState<Array<{ text: string; level: 2 | 3 }>>([]);
  useEffect(() => {
    const read = () => setHeadings([...(body.current?.querySelectorAll<HTMLElement>(selector) ?? [])]
      .map(heading => ({ text: heading.textContent?.trim() ?? "", level: heading.dataset.sourceLevel === "3" ? 3 : 2 })));
    read();
    // The body can switch between rendered text and the original; follow what is on screen.
    const observer = body.current ? new MutationObserver(read) : null;
    if (body.current) observer?.observe(body.current, { childList: true, subtree: true });
    return () => observer?.disconnect();
  }, [body, revision]);
  if (!headings.length) return <p className="text-caption text-muted-foreground">正文没有二、三级标题。</p>;
  const go = (index: number) => {
    const heading = body.current?.querySelectorAll<HTMLElement>(selector)[index];
    if (!heading) return;
    heading.tabIndex = -1;
    heading.scrollIntoView({ block: "start", behavior: "auto" });
    heading.focus({ preventScroll: true });
    // Below 1100px the column is a drawer over the text: close it so the heading is visible.
    if (window.matchMedia("(max-width: 1099px)").matches) panel?.setOpen(false);
  };
  return <nav aria-label="页内目录"><ol className="flex flex-col gap-0.5">
    {headings.map((heading, index) => <li key={index}>
      <Button variant="row" onClick={() => go(index)}
        className={heading.level === 3 ? "py-1 pl-5 pr-2 text-label" : "py-1 pl-2 pr-2 text-label"}>
        {heading.text}</Button>
    </li>)}
  </ol></nav>;
}
