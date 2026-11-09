// 修订与发布: the low-frequency write operations on a document. The page folds them under the text (Markdown) or
// into the reader's foot (HTML). The forms are the shared command form (ActionForm on shared/command, new markup even
// inside this data-legacy block); they carry the version they were opened on, so a newer version asks the reader to
// compare first. The upload form is still the old one.
import { useState } from "react";
import type { DocumentDetail } from "@evoloop/contracts";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { Alert } from "../../shared/ui/shared";
import { UploadDocument } from "./UploadDocument";

export function DocumentRevise({ context, detail, checking, failed }: {
  context: MutationContext; detail: DocumentDetail; checking: boolean; failed: boolean;
}) {
  const { document } = detail;
  const id = document.id;
  // The upload form carries the version it was opened on; a newer version found later asks to compare first.
  const [uploadBaseline, setUploadBaseline] = useState(document.version);
  const [uploadGeneration, setUploadGeneration] = useState(0);
  const archived = document.status === "archived";
  const formContext = { ...context, blocked: context.blocked || checking || failed,
    draftScope: `document:${id}`, draftBaseline: `${document.version}:${detail.current.id}:${document.adoptedRevisionId ?? ""}` };
  const uploadStale = uploadBaseline !== document.version;
  return <div data-legacy="" className="doc-revise">
    {checking && <Alert>正在核对当前版本；保存与发布暂不可用。</Alert>}
    {!archived && detail.current.format === "markdown" && detail.current.body !== null && <ActionForm context={formContext} title="保存候选修订"
      fields={[{ name: "body", label: "完整正文", kind: "textarea", value: detail.current.body ?? "" }, { name: "reason", label: "修订理由", kind: "textarea" }]}
      build={values => ({ type: "document.revise", documentId: id, expectedVersion: document.version, ...values })} />}
    {!archived && <>
      {uploadStale && <Alert kind="error">上传表单仍按打开时的第 {uploadBaseline} 版填写，当前已是第 {document.version} 版。请先核对新版本，再重新选择文件。
        <button onClick={() => {
          if (!window.confirm("重新选择文件会清空当前上传表单，确定继续？")) return;
          setUploadBaseline(document.version); setUploadGeneration(value => value + 1);
        }}>按当前版重新开始上传</button></Alert>}
      <UploadDocument key={`${id}:${uploadGeneration}`} context={{ ...formContext, blocked: formContext.blocked || uploadStale }} mode="revise"
        documentId={id} expectedVersion={uploadBaseline} />
      {detail.current.id === detail.adopted?.id
        ? <p className="muted">当前版已经发布；要更新，先保存新的修订。</p>
        : <ActionForm context={formContext} review title="发布当前版" fields={[{ name: "reason", label: "发布依据", kind: "textarea" }]}
          build={values => ({ type: "document.publish", documentId: id, expectedVersion: document.version, revisionId: detail.current.id, ...values })} />}
    </>}
    <ActionForm context={formContext} review title={archived ? "恢复文档" : "归档文档"} fields={[{ name: "reason", label: archived ? "恢复理由" : "归档理由", kind: "textarea" }]}
      build={values => ({ type: archived ? "document.restore" : "document.archive", documentId: id, expectedVersion: document.version, ...values })} />
  </div>;
}

/** A task's main document is changed from its task, never from the document page. */
export const canRevise = (detail: DocumentDetail): boolean => detail.document.kind !== "task";
