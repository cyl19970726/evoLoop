// Task, document, knowledge and message bodies share one non-executing Markdown view (architecture.md 过程文档表格与
// 完整阅读): markdown-it with raw HTML and images off and links checked against an allow-list (markdownContent.ts);
// Mermaid is drawn by the library in strict mode and shown as a static SVG inside a sandboxed iframe with its own CSP.
// Type and spacing come from readingProse, on design tokens only.
import { useEffect, useMemo, useState } from "react";
import { cn } from "@evoloop/ui";
import { maxDiagramLength, splitMarkdown } from "./markdownContent";
import { readingProse } from "./readingProse";

function Diagram({ source, id }: { source: string; id: string }) {
  const [rendered, setRendered] = useState<{ html: string; height: number } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setRendered(null); setError(false);
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", maxTextSize: maxDiagramLength,
        flowchart: { htmlLabels: false } });
      const result = await mermaid.render(`evoloop-${id.replace(/[^a-z0-9]/gi, "")}`, source);
      if (!active) return;
      const document = new DOMParser().parseFromString(result.svg, "image/svg+xml");
      const svg = document.documentElement;
      const viewBox = svg.getAttribute("viewBox")?.split(/\s+/).map(Number) ?? [];
      const intrinsicWidth = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2]! > 0 ? viewBox[2]! : null;
      const intrinsicHeight = viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3]! > 0 ? viewBox[3]! : null;
      const width = intrinsicWidth === null ? 640 : Math.min(20000, Math.max(240, intrinsicWidth));
      // The SVG is drawn at `width`, which can enlarge narrow diagrams. Size the
      // frame to that rendered height so its final arrow and node remain on page.
      const height = intrinsicWidth !== null && intrinsicHeight !== null
        ? Math.ceil(intrinsicHeight * width / intrinsicWidth + 32) : 420;
      const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'";
      setRendered({ html: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{margin:0;padding:12px;overflow:auto}svg{width:${width}px!important;height:auto;max-width:none!important}</style>${result.svg}`, height });
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [source, id]);
  return <div className="markdown-diagram my-4 max-w-full overflow-hidden rounded-lg border border-border" role="group" aria-label="静态流程图，可横向滚动">
    {rendered ? <iframe title="静态 Mermaid 图" sandbox="" referrerPolicy="no-referrer" srcDoc={rendered.html} className="block w-full border-0" style={{ height: rendered.height }} />
      : <p role="status" className="!my-0 px-3 py-2 text-small text-text-secondary">{error ? "图表无法安全渲染，请阅读下方原文。" : "正在渲染图表…"}</p>}
    <details className="border-t border-border px-3 py-2 text-small">
      <summary className="w-fit cursor-pointer text-primary hover:underline">查看图表原文</summary>
      <pre className="whitespace-pre-wrap">{source}</pre>
    </details>
  </div>;
}

/**
 * One Markdown text. `className` adjusts the type for the place it is read in (a smaller size in a side list); the
 * `markdown-body` class stays as the hook the document outline and tests find headings by.
 */
export function MarkdownBody({ source, identity, omitLeadingTitle, projectId, className }: {
  source: string; identity: string; omitLeadingTitle?: string; projectId?: string; className?: string;
}) {
  const parts = useMemo(() => splitMarkdown(source, { omitLeadingTitle, projectId }), [source, omitLeadingTitle, projectId]);
  return <div className={cn("markdown-body min-w-0 [overflow-wrap:anywhere] [&>:first-child>:first-child]:mt-0", readingProse, className)}>
    {parts.map((part, index) => part.kind === "diagram"
      ? <Diagram key={`${identity}:${index}`} source={part.value} id={`${identity}-${index}`} />
      : <div key={`${identity}:${index}`} dangerouslySetInnerHTML={{ __html: part.value }} />)}
  </div>;
}
