// Git 与外部来源登记: how recorded decisions and fixed sources are named, and which entry of each slot is its head.
import type { EpistemicStatus, KnowledgeValidity } from "@evoloop/contracts/knowledge";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";

export const referenceDecisionLabel: Record<TaskExternalReferenceRecord["decision"], string> = { adopt: "采用", retain: "保留", replace: "替换" };
export const referenceKindLabel: Record<TaskExternalReferenceRecord["kind"], string> = { git: "Git 文件", wiki: "知识页", run: "受管运行" };
export const formalDecisionLabel = { adopted: "人工认定为正式依据", rejected: "人工拒绝纳入", incorporated: "人工确认已纳入该过程修订" } as const;
export const validityLabel: Record<KnowledgeValidity, string> = { valid: "有效", needs_review: "待复核", withdrawn: "已撤回" };
export const epistemicLabel: Record<EpistemicStatus, string> = {
  observation: "观察", inference: "推断", hypothesis: "假设", adopted: "已采纳判断", disputed: "有争议", superseded: "已取代",
};

export const hashPattern = /^[a-f0-9]{64}$/;
export const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** The latest decision of every slot: only that one can be reviewed again (保留 or 替换). */
export function slotHeads(history: TaskExternalReferenceRecord[]): Map<string, TaskExternalReferenceRecord> {
  const heads = new Map<string, TaskExternalReferenceRecord>();
  for (const item of history) if ((heads.get(item.slotId)?.version ?? 0) < item.version) heads.set(item.slotId, item);
  return heads;
}

/** One line for a recorded decision: what was decided, on which kind of source, in which version of its slot. */
export function referenceLine(item: Pick<TaskExternalReferenceRecord, "decision" | "kind" | "version">): string {
  return `${referenceDecisionLabel[item.decision] ?? "决定"} · ${referenceKindLabel[item.kind] ?? "外部来源"} · 这一依据位置的第 ${item.version} 版`;
}

// The two registration forms (登记 Git 固定来源, 记录正式文档与过程文档的关系): what each field takes and what is wrong
// with a value already typed. An empty field is not an error; the command says what is missing when it is sent.

/** 仓库标识: the name the server's configuration gives a repository of this project, not an address or a path. */
export function repositoryProblem(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[\w.-]+@[\w.-]+:/.test(text)) return "这里填服务端配置里的仓库标识，不是仓库网址。";
  if (text.startsWith("/") || /^[a-z]:\\/i.test(text)) return "这里填服务端配置里的仓库标识，不是本地路径。";
  if (text.length > 100) return `仓库标识最多 100 个字符，现在是 ${text.length} 个。`;
  return undefined;
}

/** 相对路径: from the repository root, inside it. */
export function pathProblem(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (text.startsWith("/")) return "填从仓库根目录算起的相对路径，开头不要 /。";
  if (text.split(/[\\/]/).includes("..")) return "路径不能用 .. 跳出仓库目录。";
  return undefined;
}

function hexProblem(value: string, lengths: readonly number[], what: string): string | undefined {
  if (!value) return undefined;
  if (/\s/.test(value)) return `${what}里有空格或换行，请去掉。`;
  if (/[A-F]/.test(value) && /^[0-9a-fA-F]+$/.test(value)) return `${what}要用小写字母 a–f。`;
  if (!/^[0-9a-f]+$/.test(value)) return `${what}只能包含 0–9 和 a–f。`;
  if (!lengths.includes(value.length)) return `${what}要 ${lengths.join(" 或 ")} 位，现在是 ${value.length} 位。`;
  return undefined;
}
/** 完整 commit: the full hash of the commit the file is fixed at (SHA-1 or SHA-256 repositories). */
export const commitProblem = (value: string) => hexProblem(value, [40, 64], "完整 commit ");
/** 原文 SHA-256: the hash of the file's bytes at that commit. */
export const hashProblem = (value: string) => hexProblem(value, [64], "SHA-256 ");

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRecordId = (value: string) => uuidPattern.test(value.trim());
/** 固定 Git 引用 typed by hand: the whole identifier as the full-identifier layer shows it. */
export function referenceIdProblem(value: string): string | undefined {
  const text = value.trim();
  if (!text || isRecordId(text)) return undefined;
  return "固定引用是 36 位的完整标识（8-4-4-4-12），请从完整标识里整段复制。";
}

/** A fixed Git source in words: its repository and path; the commit and hash stay in the full-identifier layer. */
export const gitSourceText = (ref: { repositoryId: string; path: string }) => `${ref.repositoryId} · ${ref.path}`;

/** A process document in the chooser: its title, and its status when it is not published. */
export function documentChoiceLabel(document: { title: string; status?: string | null }): string {
  const status = document.status === "archived" ? "（已归档）" : document.status === "draft" ? "（草稿）" : "";
  return `${document.title.trim() || "未命名文档"}${status}`;
}

export interface RevisionFacts { id: string; createdAt: string; author: string; reason: string; previousRevisionId: string | null }
export interface RevisionChoice { id: string; label: string }

/**
 * The revisions of one document to choose from, newest first: the current one, the adopted one when it is another, then
 * the earlier ones read so far. Each is named by when, by whom and why; its identifier stays in the source layer.
 */
export function revisionChoices(current: RevisionFacts, adopted: RevisionFacts | null, earlier: readonly RevisionFacts[],
  when: (iso: string) => string): RevisionChoice[] {
  const seen = new Set<string>();
  const choices: RevisionChoice[] = [];
  const reason = (text: string) => { const one = text.trim().replace(/\s+/g, " "); return one.length > 24 ? `${one.slice(0, 24)}…` : one; };
  for (const revision of [current, ...adopted ? [adopted] : [], ...earlier]) {
    if (seen.has(revision.id)) continue;
    seen.add(revision.id);
    const tags = [revision.id === current.id ? "当前版" : "", revision.id === adopted?.id ? "已采用" : ""].filter(Boolean).join("，");
    const parts = [when(revision.createdAt), revision.author, reason(revision.reason)].filter(Boolean).join(" · ");
    choices.push({ id: revision.id, label: tags ? `${tags} · ${parts}` : parts });
  }
  return choices;
}
