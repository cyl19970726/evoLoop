import { createHash } from "node:crypto";
import type { EvaluationFixedRef, Principal } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";
import type { KnowledgeRepository } from "@evoloop/contracts/knowledge";
import type { DocumentSource } from "@evoloop/contracts/sources";
import type { ReadDocumentOriginal } from "./materials.js";
import { fixedDocumentMaterial } from "./materials.js";
import type { FixedEvaluationMaterial } from "./evaluation-materials.js";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface EvaluationSourceOptions {
  workflow: Pick<WorkflowService, "getDocumentPayloadRevision" | "getGitSourceRef">;
  gitForPrincipal(principal: Principal): DocumentSource | Promise<DocumentSource>;
  knowledgeForPrincipal(principal: Principal, projectId: string): KnowledgeRepository | Promise<KnowledgeRepository>;
  readDocumentOriginal?: ReadDocumentOriginal;
}

/** Read only a declared fixed source, rechecking current project authority and its immutable revision hash. */
export async function readEvaluationMaterial(principal: Principal, projectId: string,
  source: EvaluationFixedRef, options: EvaluationSourceOptions): Promise<FixedEvaluationMaterial> {
  if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
    throw new Error("Project read authority is unavailable for evaluation material");
  if (source.kind === "document") {
    const revision = await options.workflow.getDocumentPayloadRevision(principal, projectId, source.id, source.revision);
    if (revision.projectId !== projectId || revision.documentId !== source.id || revision.id !== source.revision ||
        revision.contentHash !== source.contentHash)
      throw new Error("Fixed evaluation Document scope or revision hash changed");
    const content = await fixedDocumentMaterial(principal, revision, options.readDocumentOriginal);
    return { content, contentHash: revision.contentHash };
  }
  if (source.kind === "git") {
    const registered = await options.workflow.getGitSourceRef(principal, projectId, source.id);
    if (!registered || registered.id !== source.id || registered.state !== "reachable" ||
        registered.ref.projectId !== projectId || registered.ref.commit !== source.revision ||
        registered.ref.contentHash !== source.contentHash)
      throw new Error("Fixed evaluation Git source is unavailable or mismatched");
    const result = await (await options.gitForPrincipal(principal)).read(registered.ref);
    if (result.status !== "available" || result.ref.commit !== source.revision ||
        result.ref.contentHash !== source.contentHash || sha256(result.bytes) !== source.contentHash)
      throw new Error("Fixed evaluation Git bytes are unavailable or hash mismatched");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.bytes); }
    catch { throw new Error("Fixed evaluation Git source is not UTF-8 text"); }
    return { content, contentHash: source.contentHash };
  }
  if (source.kind === "wiki") {
    const repository = await options.knowledgeForPrincipal(principal, projectId);
    const [page, current] = await Promise.all([
      repository.get(projectId, source.id, source.revision), repository.get(projectId, source.id),
    ]);
    if (!page || !current || page.projectId !== projectId || current.projectId !== projectId ||
        page.knowledgeId !== source.id || current.knowledgeId !== source.id || page.revision !== source.revision ||
        page.contentHash !== source.contentHash || sha256(page.body) !== source.contentHash ||
        page.validity !== "valid" || page.observedValidity !== "valid" ||
        current.validity !== "valid" || current.observedValidity !== "valid")
      throw new Error("Fixed evaluation Wiki source is unavailable, withdrawn, or hash mismatched");
    return { content: page.body, contentHash: source.contentHash };
  }
  throw new Error(`Evaluation input source kind ${source.kind} is not supported`);
}
