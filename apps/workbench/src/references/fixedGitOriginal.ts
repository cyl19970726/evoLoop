import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import type { GitSourceRef, SourceUnavailableReason } from "@evoloop/contracts/sources";

export type FixedGitRead =
  | { status: "available"; referenceId: string; ref: GitSourceRef; base64: string; observedAt: string }
  | { status: "unavailable"; referenceId: string; ref: GitSourceRef; reason: SourceUnavailableReason; observedAt: string };

export interface VerifiedGitOriginal { ref: GitSourceRef; observedAt: string; bytes: Uint8Array<ArrayBuffer>; text: string | null }

const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const reasonLabel: Record<SourceUnavailableReason,string> = {
  repository: "登记的仓库当前不可读取", commit: "固定 commit 当前不可读取", path: "固定路径当前不可读取",
  permission: "当前身份无权读取原件", hash_mismatch: "Git 原文与登记的 SHA-256 不一致",
};

/** Readback identity must match the decision, not a later Git HEAD or another slot's reference. */
export async function verifyFixedGitRead(record: TaskExternalReferenceRecord, read: FixedGitRead): Promise<VerifiedGitOriginal> {
  if (record.kind !== "git" || read.referenceId !== record.referenceId ||
    read.ref.projectId !== record.projectId || read.ref.commit !== record.revision ||
    read.ref.contentHash !== record.contentHash)
    throw new Error("返回的固定 Git 身份与该任务采用记录不一致；原文未展示。");
  if (read.status === "unavailable") throw new Error(`${reasonLabel[read.reason] ?? "固定原件当前不可读取"}；原文未展示。`);
  if (!canonicalBase64.test(read.base64)) throw new Error("Git 原文字节不是规范 Base64；原文未展示。");
  let binary: string;
  try { binary = atob(read.base64); }
  catch { throw new Error("Git 原文字节无法解码；原文未展示。"); }
  if (btoa(binary) !== read.base64) throw new Error("Git 原文字节不是规范 Base64；原文未展示。");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2,"0")).join("");
  if (hash !== record.contentHash) throw new Error("实读 Git 原文字节与采用记录的 SHA-256 不一致；原文未展示。");
  let text: string | null;
  try { text = new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
  catch { text = null; }
  return { ref: read.ref, observedAt: read.observedAt, bytes, text };
}
