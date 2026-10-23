import { useEffect, useState } from "react";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import { errorText, request } from "../api";
import { type FixedGitRead, type VerifiedGitOriginal, verifyFixedGitRead } from "./fixedGitOriginal";
import "./fixed-git-original.css";

export function GitOriginalContent({ original }: { original: VerifiedGitOriginal }) {
  return original.text === null
    ? <p>原件不是有效 UTF-8 文本。已核对完整字节的 SHA-256，请下载核对二进制原件。</p>
    : <pre className="fixed-git-original-text">{original.text}</pre>;
}

export function FixedGitOriginalReader({ token, record }: { token: string; record: TaskExternalReferenceRecord }) {
  const [original, setOriginal] = useState<VerifiedGitOriginal | null>(null);
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setOriginal(null); setProblem(""); setLoading(true);
    void request<FixedGitRead>(token,
      `/api/projects/${encodeURIComponent(record.projectId)}/references/git/${encodeURIComponent(record.referenceId)}`,30000)
      .then(read => verifyFixedGitRead(record,read))
      .then(value => { if (active) setOriginal(value); })
      .catch(cause => { if (active) setProblem(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  },[token,record.projectId,record.id,record.referenceId,record.revision,record.contentHash]);
  function download() {
    if (!original) return;
    const filename = original.ref.path.split("/").at(-1) || "git-original";
    const url = URL.createObjectURL(new Blob([original.bytes],{type:"application/octet-stream"}));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url),60000);
  }
  return <section className="fixed-git-original" aria-label="固定 Git 原文">
    <h4>固定 Git 原文 · 只读核对</h4>
    <p>这里读取登记时的 commit 与路径，不跟随仓库当前分支。本次读取仅核对原文，不新增正式文档采用结论，也不表示任务已验收或报告已被使用。</p>
    {loading && <p>正在读取并校验固定原件完整字节…</p>}
    {problem && <p role="alert" className="fixed-git-problem">固定原文不可核实：{problem}。请保留当次采用记录，不以仓库当前版替代。</p>}
    {original && <>
      <dl className="fixed-git-identity">
        <div><dt>仓库</dt><dd><code>{original.ref.repositoryId}</code></dd></div>
        <div><dt>路径</dt><dd><code>{original.ref.path}</code></dd></div>
        <div><dt>固定 commit</dt><dd><code>{original.ref.commit}</code></dd></div>
        <div><dt>实读 SHA-256</dt><dd><code>{original.ref.contentHash}</code></dd></div>
        <div><dt>引用 ID</dt><dd><code>{record.referenceId}</code></dd></div>
        <div><dt>读取时间</dt><dd>{original.observedAt}</dd></div>
      </dl>
      <button type="button" onClick={download}>下载已校验原件（完整字节）</button>
      <GitOriginalContent original={original} />
    </>}
  </section>;
}
