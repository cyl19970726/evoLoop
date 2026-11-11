// A link to a document revision from the task page: it opens in the right column beside the task (layout.md 右栏),
// and like any link opens in a new tab with Cmd/Ctrl. Without a right column it navigates.
import React from "react";
import { cn } from "@evoloop/ui";
import { useContextPanel } from "../../shared/ui/ContextPanel";
import { href } from "../../shared/ui/shared";
import { PeekBoundary, TaskDocumentPeek } from "./TaskDocumentPeek";

export function DocumentLink({ projectId, documentId, revisionId, taskId, relation, title, children, className }: {
  projectId: string; documentId: string; revisionId: string | null; taskId: string; relation: string; title: string; children: React.ReactNode; className?: string;
}) {
  const panel = useContextPanel();
  const link = href(projectId, "document", documentId, revisionId ?? undefined);
  return <a href={link} className={cn("text-primary hover:underline [overflow-wrap:anywhere]", className)} onClick={event => {
    if (!panel || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    panel.openInPanel({ id: `document:${documentId}@${revisionId ?? "current"}`, title, ownerTaskId: taskId, href: link,
      render: () => <PeekBoundary><TaskDocumentPeek projectId={projectId} documentId={documentId} revisionId={revisionId} relation={relation} /></PeekBoundary> });
  }}>{children}</a>;
}
