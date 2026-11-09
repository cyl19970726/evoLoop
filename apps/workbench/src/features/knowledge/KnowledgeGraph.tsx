// The related-pages graph around the current version: a navigation aid only. Layout and distance say nothing about
// correctness; every node opens the full page, and every edge is also listed as text in the relations blocks.
import type { KnowledgeGraph as Graph } from "@evoloop/contracts/knowledge";
import { cn } from "@evoloop/ui";
import { knowledgeHref } from "./knowledgeRoute";
import { graphStatusText, validityLabel, label } from "./knowledgePresentation";

const nodeKey = (id: string, revision: string) => `${id}\0${revision}`;

export function KnowledgeGraph({ projectId, graph, focusId }: { projectId: string; graph: Graph; focusId: string }) {
  const others = graph.nodes.filter(node => node.knowledgeId !== focusId);
  const ordered = [...graph.nodes.filter(node => node.knowledgeId === focusId), ...others];
  const positions = new Map(ordered.map((node, index) => [nodeKey(node.knowledgeId, node.revision),
    index === 0 ? { x: 300, y: 150 } : { x: 300 + 205 * Math.cos(2 * Math.PI * (index - 1) / Math.max(1, ordered.length - 1)),
      y: 150 + 110 * Math.sin(2 * Math.PI * (index - 1) / Math.max(1, ordered.length - 1)) }]));
  return <div className="flex flex-col gap-2">
    <p className="text-caption text-muted-foreground">{graphStatusText(graph.status)}。图只帮助找线索，位置和远近不代表对错。</p>
    <svg aria-hidden="true" viewBox="0 0 600 300" className="h-auto w-full rounded-lg bg-muted">
      {graph.edges.map(edge => {
        const a = positions.get(nodeKey(edge.fromKnowledgeId, edge.fromRevision)), b = positions.get(nodeKey(edge.toKnowledgeId, edge.toRevision));
        return a && b ? <line key={edge.edgeId} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth="2"
          className={edge.state === "active" ? (edge.type === "contradicts" ? "stroke-destructive" : "stroke-primary") : "stroke-warning"} /> : null;
      })}
      {ordered.map(node => {
        const point = positions.get(nodeKey(node.knowledgeId, node.revision))!;
        return <g key={nodeKey(node.knowledgeId, node.revision)}>
          <circle cx={point.x} cy={point.y} r="30" className={cn(node.validity === "valid" ? "fill-accent" : "fill-warning-soft", "stroke-border")} />
          <text x={point.x} y={point.y + 4} textAnchor="middle" fontSize="11" className="fill-foreground">{node.title.slice(0, 8)}</text>
        </g>;
      })}
    </svg>
    <ul aria-label="关系图中的知识页" className="flex flex-col gap-0.5">
      {ordered.map(node => <li key={nodeKey(node.knowledgeId, node.revision)}>
        <a href={knowledgeHref(projectId, { knowledgeId: node.knowledgeId, revision: node.revision })}
          className="block rounded-md px-2 py-1 text-label text-primary outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)] [overflow-wrap:anywhere]">
          {node.title}<span className="text-muted-foreground"> · {label(validityLabel, node.validity)}{node.knowledgeId === focusId ? " · 此页" : ""}</span></a>
      </li>)}
    </ul>
    {graph.status !== "complete" && <p className="text-caption text-warning">关系没有读全，不能据此断言没有其他关联。</p>}
  </div>;
}
