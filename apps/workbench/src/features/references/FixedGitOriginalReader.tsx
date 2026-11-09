// The fixed Git original a task decision adopted, read by its registered commit and path (never the branch's current
// version) and shown only after its full bytes match the recorded SHA-256. Reading it adds no decision.
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import { Button, ErrorState, LoadingState } from "@evoloop/ui";
import { errorText, request } from "../../shared/api";
import { fixedContent, useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { FactList, mutedText } from "../../shared/ui/PageParts";
import { date } from "../../shared/ui/shared";
import { type FixedGitRead, type VerifiedGitOriginal, verifyFixedGitRead } from "./fixedGitOriginal";

function download(original: VerifiedGitOriginal) {
  const filename = original.ref.path.split("/").at(-1) || "git-original";
  const url = URL.createObjectURL(new Blob([original.bytes], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function FixedGitOriginalReader({ record }: { record: TaskExternalReferenceRecord }) {
  // A fixed original never changes once registered: it is read once (fixedContent) per decision and hash.
  const read = useProjectQuery(record.projectId, [fixedContent, "git-original", record.id, record.referenceId, record.revision, record.contentHash], async signal => {
    const value = await request<FixedGitRead>("", `/api/projects/${encodeURIComponent(record.projectId)}/references/git/${encodeURIComponent(record.referenceId)}`, 30000, { signal });
    return verifyFixedGitRead(record, value);
  });
  const original = read.data;
  return <section aria-label="固定 Git 原文" className="flex min-w-0 flex-col gap-3 rounded-lg bg-muted p-4 [overflow-wrap:anywhere]">
    <h4 className="text-label font-semibold text-foreground">固定 Git 原文 · 只读核对</h4>
    <p className={mutedText}>按登记时的 commit 与路径读取，不跟随仓库当前分支。读取只为核对原文，不新增采用结论，也不表示任务已验收或原文已被使用。</p>
    {!original && (read.error ? <ErrorState title="固定原文不可核实" happened={errorText(read.error)}
      next="请保留当次采用记录，不以仓库当前版代替；可以重新读取。" action={<Button size="compact" onClick={() => void read.refetch()}>重新读取</Button>} />
      : <LoadingState lines={3} label="正在读取并校验固定原件的完整字节" />)}
    {original && <>
      <FactList columns rows={[["路径", original.ref.path], ["读取时间", date(original.observedAt)],
        ["校验", "完整字节与登记的 SHA-256 一致"]]} />
      <FullIdentifiers rows={[{ label: "仓库", value: original.ref.repositoryId }, { label: "固定 commit", value: original.ref.commit },
        { label: "实读 SHA-256", value: original.ref.contentHash }, { label: "引用", value: record.referenceId }]} />
      <Button size="compact" className="w-fit" onClick={() => download(original)}>下载已校验原件（完整字节）</Button>
      {original.text === null ? <p className="text-label text-text-secondary">原件不是有效的 UTF-8 文本。完整字节已核对 SHA-256，请下载后核对二进制原件。</p>
        : <pre className="max-h-[75vh] max-w-full overflow-auto whitespace-pre rounded-lg bg-raised p-4 font-mono text-caption leading-(--leading-body) text-foreground [tab-size:2]">{original.text}</pre>}
    </>}
  </section>;
}
