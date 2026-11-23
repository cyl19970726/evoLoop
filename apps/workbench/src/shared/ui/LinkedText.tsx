// Plain text with the candidates that name one object of the project as links (Task a910ee96); the rest stays as written.
import React, { type ReactNode } from "react";
import { refHits, refTarget, useRefAnswers } from "../refLinks";

/** The text with each candidate that names one object of the project as a link (Task a910ee96); the rest as written. */
export function LinkedText({ value, projectId, className = "text-primary" }: { value: string; projectId: string | undefined; className?: string }): ReactNode {
  const hits = React.useMemo(() => projectId ? refHits(value) : [], [value, projectId]);
  const answerOf = useRefAnswers(projectId, [...new Set(hits.map(hit => hit.key))], hits.length > 0);
  if (!projectId || !hits.length) return value;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const hit of hits) {
    const target = refTarget(projectId, hit.key, answerOf(hit.key));
    if (!target) continue;
    if (hit.index > offset) nodes.push(value.slice(offset, hit.index));
    nodes.push(<a key={hit.index} href={target.href} title={target.description} aria-description={target.description} className={`${className} underline underline-offset-2`}>{hit.text}</a>);
    offset = hit.index + hit.text.length;
  }
  if (!nodes.length) return value;
  if (offset < value.length) nodes.push(value.slice(offset));
  return <>{nodes}</>;
}

