// The two sources a formal decision names (记录正式文档与过程文档的关系), chosen by name instead of typed as identifiers:
// the fixed Git source registered just before (or one pasted from a task's full identifiers, read back to say what it
// is), and a process document with one of its revisions. The identifiers themselves go to the full-identifier layer.
import { useQueryClient } from "@tanstack/react-query";
import type { Document, Page } from "@evoloop/contracts";
import { Button, Field, Input, Notice, Select } from "@evoloop/ui";
import { ApiError, api, errorText, request } from "../../shared/api";
import { useDocumentRevisions } from "../../shared/useDocumentRevisions";
import { useProjectList } from "../../shared/projectList";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { RevisionListStatus } from "../../shared/ui/RevisionListStatus";
import { date } from "../../shared/ui/shared";
import type { FixedGitRead } from "./fixedGitOriginal";
import { documentChoiceLabel, gitSourceText, isRecordId, referenceIdProblem, revisionChoices } from "./referencePresentation";

const wide = "w-full";
const note = "text-label text-text-secondary [overflow-wrap:anywhere]";

/** The Git source this panel registered last, as the server confirmed it. */
export interface RegisteredGit { referenceId: string; repositoryId: string; path: string; commit: string; contentHash: string }

/** 固定 Git 来源: the one just registered, in words; otherwise its identifier typed by hand and read back. */
export function GitReferenceChoice({ projectId, enabled, value, onChange, registered, editing, onEditing }: {
  projectId: string; enabled: boolean; value: string; onChange(value: string): void; registered: RegisteredGit | null;
  editing: boolean; onEditing(editing: boolean): void;
}) {
  const id = value.trim();
  const fromRegistration = !!registered && id === registered.referenceId;
  const read = useProjectQuery(projectId, ["references", "git", id, "ref"], async signal => {
    const answer = await request<FixedGitRead>("", `/api/projects/${encodeURIComponent(projectId)}/references/git/${encodeURIComponent(id)}`, 30000, { signal });
    if (answer.referenceId !== id || answer.ref?.projectId !== projectId) throw new Error("固定引用响应与所填标识不符");
    return { ref: answer.ref, available: answer.status === "available" };
  }, { enabled: enabled && !fromRegistration && isRecordId(id) });
  const readText = fromRegistration ? `刚登记的固定来源：${gitSourceText(registered!)}` : !isRecordId(id) ? ""
    : read.data ? `已登记的固定来源：${gitSourceText(read.data.ref)}${read.data.available ? "" : "（原文当前读不到，提交时服务端会再核验）"}`
    : read.isError ? read.error instanceof ApiError && read.error.status === 404 ? "本项目里没有这条固定 Git 引用。" : `暂时读不到这条固定 Git 引用（${errorText(read.error)}），无法判断它指向哪里。`
    : "正在读取这条固定 Git 引用…";
  if (id && !editing) return <div className="flex flex-col gap-1.5">
    <span className="text-label font-semibold text-foreground">固定 Git 来源</span>
    <p className={note}>{readText}</p>
    <Button size="compact" variant="ghost" className="w-fit" onClick={() => onEditing(true)}>改用另一条固定引用</Button>
  </div>;
  return <div className="flex flex-col gap-1.5">
    <Field label="固定 Git 引用" hint="在上面登记 Git 固定来源后会自动填入；也可以粘贴任务“已登记的依据”完整标识里的“固定引用”。" error={referenceIdProblem(value)}>
      {props => <Input {...props} value={value} autoComplete="off" onChange={event => { onEditing(true); onChange(event.target.value); }} />}</Field>
    {readText && <p className={note}>{readText}</p>}
  </div>;
}

/**
 * 过程文档 and 过程文档修订: the project's documents by title, then the chosen one's revisions from its revision list (no
 * text is read), named by number, state, when, who and why; earlier pages on request.
 */
export function ProcessRevisionChoice({ projectId, enabled, documentId, revisionId, onDocument, onRevision }: {
  projectId: string; enabled: boolean; documentId: string; revisionId: string; onDocument(id: string): void; onRevision(id: string): void;
}) {
  const client = useQueryClient();
  const documents = useProjectList(projectId, ["references", "documents"], async (cursor, signal) => {
    const page: Page<Document> = await api().documents(projectId, cursor, undefined, undefined, signal);
    if (!Array.isArray(page?.items) || page.items.some(item => item.projectId !== projectId)) throw new Error("文档列表与当前项目不符");
    return page;
  }, (item: Document) => item.id, { enabled });
  const revisions = useDocumentRevisions(projectId, documentId, { enabled: enabled && isRecordId(documentId) });
  const model = revisions.model?.head.id === documentId ? revisions.model : null;
  const choices = model ? revisionChoices(model.items, model.head.status, date) : [];
  const listed = documents.items ?? [];
  // A document chosen before the list was read (or after it changed) still shows by its read-back title.
  const options = documentId && model && !listed.some(item => item.id === documentId) ? [model.head, ...listed] : listed;
  return <>
    <Field label="过程文档" error={documents.failed ? `文档列表暂不可读取：${errorText(documents.error)}` : undefined}>
      {props => <Select {...props} className={wide} value={documentId} disabled={!documents.items}
        onChange={event => { onDocument(event.target.value); onRevision(""); }}>
        <option value="">{documents.reading ? "正在读取文档列表…" : documents.failed ? "文档列表没有读回" : "选择一份过程文档"}</option>
        {options.map(item => <option key={item.id} value={item.id}>{documentChoiceLabel(item)}</option>)}
      </Select>}</Field>
    {documents.failed && <Button size="compact" variant="ghost" className="w-fit"
      onClick={() => void client.refetchQueries({ queryKey: queryKeys.project(projectId, "references", "documents") })}>重新读取文档列表</Button>}
    {documents.items?.length === 0 && !documents.more && <p className={note}>这个项目还没有过程文档。</p>}
    {documents.stale && <Notice tone="waiting" title="上次读回，当前待核对">文档列表重新读取失败：{errorText(documents.error)}。</Notice>}
    {(documents.more || documents.pageFailed) && <Button size="compact" variant="ghost" className="w-fit" disabled={documents.loadingMore}
      onClick={documents.loadMore}>{documents.loadingMore ? "正在读取更多文档…" : documents.pageFailed ? "后面的文档没有读到，重新读取" : "列出更多文档"}</Button>}
    {documentId && <>
      <Field label="过程文档修订">
        {props => <Select {...props} className={wide} value={revisionId} disabled={!model} onChange={event => onRevision(event.target.value)}>
          <option value="">{model ? "选择一个修订" : revisions.failed ? "修订没有读回" : "正在读取修订…"}</option>
          {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </Select>}</Field>
      <RevisionListStatus list={revisions} />
    </>}
  </>;
}
