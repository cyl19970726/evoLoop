// 过程文档 with no document open: the inner rail lists the documents, the center shows the document table
// (docs/frontend/pages/documents.md). Search and filters sit in the rail while it is on screen, otherwise above
// the table, so the page never shows two search boxes.
import { useState } from "react";
import { Button } from "@evoloop/ui";
import { ActionForm, option, type MutationContext } from "../../shared/ActionForm";
import { useContextRailShown } from "../../shared/ui/ContextRail";
import { Legacy } from "../../shared/ui/PageParts";
import { DocumentFilters } from "./DocumentFilters";
import { DocumentRail } from "./DocumentRail";
import { ReadingSpaceSwitch } from "../../shared/ui/ReadingSpaceSwitch";
import { DocumentTable } from "./DocumentTable";
import { kindLabel } from "./documentPresentation";
import { useDocumentListState } from "./documentListState";
import { useDocumentList } from "./useDocumentList";
import { useRereadOnReturn } from "../../shared/ui/rereadOnReturn";
import { UploadDocument } from "./UploadDocument";

export function DocumentIndex({ context }: { context: MutationContext }) {
  const { projectId } = context;
  const scope = `${context.principal.actorId}:${projectId}`;
  const [state, update] = useDocumentListState(scope);
  const list = useDocumentList(projectId, state, update);
  useRereadOnReturn(() => void list.reread());
  const railShown = useContextRailShown();
  const [create, setCreate] = useState(false);
  const canWrite = context.principal.permissions.includes("write");
  const toolbar = railShown ? null : <div className="flex flex-col gap-2.5">
    <ReadingSpaceSwitch projectId={projectId} current="documents" className="w-40" />
    <div className="flex flex-wrap items-center gap-2">
      <DocumentFilters state={state} update={update} layout="toolbar" />
      <Button variant="ghost" size="compact" onClick={() => void list.reread()}>重新读取</Button>
    </div>
  </div>;
  return <div data-ui="" className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-6 compact:px-8 compact:py-8">
    <DocumentRail projectId={projectId} scope={scope} />
    <header className="flex flex-wrap items-start justify-between gap-3 pr-12">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-title font-semibold leading-[1.3] outline-none">过程文档</h1>
        <p className="mt-1 text-small text-text-secondary">从固定原件读工作依据，核对版本与引用它的任务。点标题读完整正文。</p>
      </div>
      <div className="flex items-center gap-2">
        {railShown && <Button variant="ghost" size="compact" onClick={() => void list.reread()}>重新读取</Button>}
        {canWrite && <Button variant="primary" size="compact" aria-expanded={create} onClick={() => setCreate(value => !value)}>保存文档</Button>}
      </div>
    </header>
    {create && <section aria-label="保存过程文档" className="flex flex-col gap-3 rounded-xl bg-raised p-4 shadow-sm compact:p-5">
      <h2 className="text-heading font-semibold text-foreground">保存过程文档</h2>
      {/* The two forms keep their old markup until the shared command form and the upload form are rebuilt. */}
      <Legacy>
        <ActionForm context={context} title="创建 Markdown 文档" fields={[{ name: "title", label: "文档名称" },
          { name: "kind", label: "类型（可选）", kind: "select", optional: true, options: Object.entries(kindLabel)
            .filter(([key]) => key !== "task" && key !== "organization_review").map(([key, label]) => option(key, label)) },
          { name: "body", label: "完整 Markdown 正文", kind: "textarea" }]}
          build={values => ({ type: "document.create", documentId: crypto.randomUUID(), title: values.title, body: values.body, kind: values.kind || null })} />
        <UploadDocument context={context} />
      </Legacy>
    </section>}
    <DocumentTable projectId={projectId} list={list} state={state} update={update} toolbar={toolbar} />
  </div>;
}

