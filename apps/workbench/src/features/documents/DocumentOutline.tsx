import { useEffect, useState, type RefObject } from "react";

/** Read headings from the rendered fixed body so code blocks and diagrams stay out of the outline. */
export function DocumentOutline({ body, revision, compact = false }: {
  body: RefObject<HTMLElement | null>; revision: string; compact?: boolean;
}) {
  const [outline, setOutline] = useState<{ revision: string; headings: HTMLElement[] }>({ revision: "", headings: [] });
  useEffect(() => {
    setOutline({ revision, headings: [...(body.current?.querySelectorAll<HTMLElement>(".markdown-body h2, .markdown-body h3") ?? [])] });
  }, [body, revision]);
  const headings = outline.revision === revision ? outline.headings : [];
  if (!headings.length) return null;
  return <nav className="document-outline" aria-label="文档目录">
    {!compact && <h2>目录</h2>}
    <ol>{headings.map((heading, index) => <li key={index} className={heading.tagName === "H3" ? "outline-subsection" : undefined}>
      <button type="button" onClick={() => {
        if (!body.current?.contains(heading)) return;
        heading.tabIndex = -1;
        heading.scrollIntoView({ block: "start", behavior: "auto" });
        heading.focus({ preventScroll: true });
      }}>{heading.textContent}</button>
    </li>)}</ol>
  </nav>;
}
