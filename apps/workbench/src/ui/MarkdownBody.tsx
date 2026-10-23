import { useEffect, useMemo, useState } from "react";
import { maxDiagramLength, splitMarkdown } from "./markdownContent";
import "./markdown.css";

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
      const width = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2]! > 0 ? Math.min(20000, Math.max(240, viewBox[2]!)) : 640;
      const height = viewBox.length === 4 && Number.isFinite(viewBox[3]) ? Math.max(240, Math.min(760, viewBox[3]! + 32)) : 420;
      const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'";
      setRendered({ html: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body{margin:0;padding:12px;overflow:auto}svg{width:${width}px!important;height:auto;max-width:none!important}</style>${result.svg}`, height });
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [source, id]);
  return <div className="markdown-diagram" aria-label="静态流程图，可横向滚动">
    {rendered ? <iframe title="静态 Mermaid 图" sandbox="" referrerPolicy="no-referrer" srcDoc={rendered.html} style={{ height: rendered.height }} />
      : error ? <p role="status">图表无法安全渲染，请阅读下方原文。</p> : <p>正在渲染图表…</p>}
    <details><summary>查看图表原文</summary><pre>{source}</pre></details>
  </div>;
}

/** Task and Document bodies share a single non-executing Markdown view. */
export function MarkdownBody({ source, identity, omitLeadingTitle, projectId }: { source: string; identity: string; omitLeadingTitle?: string; projectId?: string }) {
  const parts = useMemo(() => splitMarkdown(source, { omitLeadingTitle, projectId }), [source, omitLeadingTitle, projectId]);
  return <div className="markdown-body">{parts.map((part, index) => part.kind === "diagram"
    ? <Diagram key={`${identity}:${index}`} source={part.value} id={`${identity}-${index}`} />
    : <div key={`${identity}:${index}`} dangerouslySetInnerHTML={{ __html: part.value }} />)}</div>;
}
