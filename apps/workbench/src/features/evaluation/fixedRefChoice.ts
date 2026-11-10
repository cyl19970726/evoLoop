// Choosing fixed sources for an evaluation definition by name. The form keeps each source field as the lines the
// definition is built from (`类型 | 标识 | 固定修订 | SHA-256`, formatFixedRefs), so the command is the same one typed
// lines gave before (definitionFromForm). The person picks a document or Wiki page and one of its versions; the
// revision and hash come from what the page read back, and the lines themselves only appear under 完整标识.
import type { Document, DocumentRevision, EvaluationFixedRef } from "@evoloop/contracts";
import type { KnowledgeRevision } from "@evoloop/contracts/knowledge";
import { formatFixedRefs, parseFixedRefLines } from "./presentation";

const sha256 = /^[a-f0-9]{64}$/;
export type ChoosableKind = EvaluationFixedRef["kind"];

/** A document revision as a fixed reference; null when the revision is not this document's or has no usable hash. */
export function documentFixedRef(projectId: string, document: Pick<Document, "id" | "projectId">, revision: Pick<DocumentRevision, "id" | "documentId" | "projectId" | "contentHash">): EvaluationFixedRef | null {
  if (document.projectId !== projectId || revision.projectId !== projectId || revision.documentId !== document.id || !sha256.test(revision.contentHash)) return null;
  return { kind: "document", id: document.id, revision: revision.id, contentHash: revision.contentHash };
}

/** A Wiki page revision as a fixed reference; null when it is another page's or another revision, or has no usable hash. */
export function wikiFixedRef(projectId: string, knowledgeId: string, revision: string, page: Pick<KnowledgeRevision, "projectId" | "knowledgeId" | "revision" | "contentHash">): EvaluationFixedRef | null {
  if (page.projectId !== projectId || page.knowledgeId !== knowledgeId || page.revision !== revision || !sha256.test(page.contentHash)) return null;
  return { kind: "wiki", id: page.knowledgeId, revision: page.revision, contentHash: page.contentHash };
}

export type RefRow = { ref: EvaluationFixedRef; line: string; problem?: undefined } | { ref?: undefined; line: string; problem: string };

/** The field's lines, each read on its own, so one unreadable line does not hide the others. */
export function refRows(value: string, allowed: readonly ChoosableKind[]): RefRow[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    try { return { ref: parseFixedRefLines(line, allowed)[0]!, line }; }
    catch (cause) { return { line, problem: cause instanceof Error ? cause.message : "无法识别这一项" }; }
  });
}

const sameRef = (a: EvaluationFixedRef, b: EvaluationFixedRef) => a.kind === b.kind && a.id === b.id && a.revision === b.revision && a.contentHash === b.contentHash;

/** The field with one more source; a field that takes one source (the protocol) has it replaced. A repeat is not added twice. */
export function withRef(value: string, ref: EvaluationFixedRef, single = false): string {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (single) return formatFixedRefs([ref]);
  const kept = refRows(value, [ref.kind]).some(row => row.ref && sameRef(row.ref, ref));
  return kept ? lines.join("\n") : [...lines, formatFixedRefs([ref])].join("\n");
}

/** The field without its `index`th line. */
export function withoutRef(value: string, index: number): string {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter((_, at) => at !== index).join("\n");
}

/** A typed line (按完整标识添加, e.g. a Git source), checked as the definition will check it. */
export function typedRef(line: string, allowed: readonly ChoosableKind[]): EvaluationFixedRef {
  const refs = parseFixedRefLines(line, allowed);
  if (refs.length !== 1) throw new Error("一次添加一项。");
  return refs[0]!;
}

/** How a document version is named: the current one, the adopted one, or an earlier one by its date. */
export function documentVersionLabel(document: Pick<Document, "currentRevisionId" | "adoptedRevisionId">, revisionId: string, when: string): string {
  if (revisionId === document.currentRevisionId) return `当前版本 · ${when}`;
  if (revisionId === document.adoptedRevisionId) return `已采用版本 · ${when}`;
  return `较早版本 · ${when}`;
}
