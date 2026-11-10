// 修订与发布: the low-frequency write operations on a document. The page folds them under the text (Markdown) or
// into the reader's foot (HTML). Every form is the shared command form (ActionForm and the upload form on
// shared/command); each carries the version it was opened on, so a newer version asks the reader to compare first.
// While the current version is being read again, or could not be read, the forms say why they wait (CommandBlock).
import type { DocumentDetail } from "@evoloop/contracts";
import { Notice } from "@evoloop/ui";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { CommandBlock } from "../../shared/command";
import { mutedText } from "../../shared/ui/PageParts";
import { UploadDocument } from "./UploadDocument";

export function DocumentRevise({ context, detail, checking, failed }: {
  context: MutationContext; detail: DocumentDetail; checking: boolean; failed: boolean;
}) {
  const { document } = detail;
  const id = document.id;
  const archived = document.status === "archived";
  const formContext = { ...context, draftScope: `document:${id}`, draftBaseline: `${document.version}:${detail.current.id}:${document.adoptedRevisionId ?? ""}` };
  const waiting = checking ? "正在核对当前版本" : failed ? "当前版本没有读回，读回后才能保存" : "";
  return <CommandBlock.Provider value={waiting}>
    <div data-ui="" className="flex min-w-0 flex-col gap-3">
      {checking && <Notice tone="waiting">正在核对当前版本；保存与发布暂不可用。</Notice>}
      {!archived && detail.current.format === "markdown" && detail.current.body !== null && <ActionForm context={formContext} title="保存候选修订"
        fields={[{ name: "body", label: "完整正文", kind: "textarea", value: detail.current.body ?? "", maxLength: 65536 }, { name: "reason", label: "修订理由", kind: "textarea", maxLength: 4000 }]}
        build={values => ({ type: "document.revise", documentId: id, expectedVersion: document.version, ...values })} />}
      {!archived && <>
        <UploadDocument key={id} context={formContext} mode="revise" documentId={id} expectedVersion={document.version} />
        {detail.current.id === detail.adopted?.id
          ? <p className={mutedText}>当前版已经发布；要更新，先保存新的修订。</p>
          : <ActionForm context={formContext} review title="发布当前版" fields={[{ name: "reason", label: "发布依据", kind: "textarea", maxLength: 4000 }]}
            build={values => ({ type: "document.publish", documentId: id, expectedVersion: document.version, revisionId: detail.current.id, ...values })} />}
      </>}
      <ActionForm context={formContext} review title={archived ? "恢复文档" : "归档文档"} fields={[{ name: "reason", label: archived ? "恢复理由" : "归档理由", kind: "textarea", maxLength: 4000 }]}
        build={values => ({ type: archived ? "document.restore" : "document.archive", documentId: id, expectedVersion: document.version, ...values })} />
    </div>
  </CommandBlock.Provider>;
}

/** A task's main document is changed from its task, never from the document page. */
export const canRevise = (detail: DocumentDetail): boolean => detail.document.kind !== "task";
