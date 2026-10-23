import { createHash } from "node:crypto";
import type { Principal, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import type { ReferenceUnitOfWork, TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import type { DocumentSource } from "@evoloop/contracts/sources";
import type { KnowledgeRepository, KnowledgeRevision } from "@evoloop/contracts/knowledge";
import { DomainError } from "@evoloop/contracts/ports";
import { fixedRunMatches } from "@evoloop/core/references";

const maxMaterialBytes = 16 * 1024 * 1024;
const maxContextBytes = 256 * 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const valid = (page: KnowledgeRevision) => page.validity === "valid" && page.observedValidity === "valid";
export interface ExternalMaterialOptions {
  uow: ReferenceUnitOfWork;
  gitForPrincipal(principal: Principal): DocumentSource | Promise<DocumentSource>;
  knowledgeForPrincipal(principal: Principal, projectId: string): KnowledgeRepository | Promise<KnowledgeRepository>;
  runSessionAvailable?(projectId: string, run: RuntimeRunRecord, session: RuntimeSessionRecord): Promise<boolean>;
}
function fail(reason: string): never { throw new DomainError("BASIS_UNAVAILABLE", reason); }

/** Only explicitly frozen Task references enter a native run; every original is re-read. */
export async function readExternalMaterials(
  principal: Principal, projectId: string, taskId: string, taskRevisionId: string, options: ExternalMaterialOptions,
): Promise<string> {
  if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
    throw new DomainError("FORBIDDEN", "Project reference read permission is required");
  const snapshot = await options.uow.read(projectId, reader => reader.listTaskExternalSnapshot(taskId, taskRevisionId));
  if (snapshot.length === 0) return "";
  if (snapshot.length > 100) fail("External reference snapshot exceeds 100 slots");
  const git = await options.gitForPrincipal(principal);
  let wiki: KnowledgeRepository | null = null;
  let total = 0;
  const materials: Array<{ kind: string; slotId: string; referenceId: string; revision: string;
    contentHash: string; decision: string; reason: string; actionImpact: string; body: string }> = [];
  for (const fixed of snapshot) {
    if (fixed.projectId !== projectId || fixed.taskId !== taskId || fixed.observedCurrentValidity !== "valid")
      fail("External reference snapshot scope or review baseline is invalid");
    const body = fixed.kind === "git"
      ? await readGit(options, git, projectId, fixed)
      : fixed.kind === "wiki"
        ? await readWiki(options, principal, projectId, fixed, wiki ??= await options.knowledgeForPrincipal(principal, projectId))
        : await readRun(options, projectId, fixed);
    total += Buffer.byteLength(body, "utf8");
    if (total > maxMaterialBytes) fail("Complete external reference originals exceed 16 MiB");
    materials.push({ kind: fixed.kind, slotId: fixed.slotId, referenceId: fixed.referenceId,
      revision: fixed.revision, contentHash: fixed.contentHash, decision: fixed.decision,
      reason: fixed.reason, actionImpact: fixed.actionImpact, body });
  }
  const encoded = `Explicitly adopted external references for Task revision ${taskRevisionId}:\n${JSON.stringify(materials)}`;
  if (Buffer.byteLength(encoded, "utf8") > maxContextBytes)
    fail("Complete external reference context exceeds 256 KiB");
  return encoded;
}

async function readRun(options: ExternalMaterialOptions, projectId: string, fixed: TaskExternalReferenceRecord): Promise<string> {
  const run = await options.uow.read(projectId, reader => reader.getRuntimeRun(fixed.referenceId));
  const session = run ? await options.uow.read(projectId, reader => reader.getRuntimeSession(run.sessionId)) : null;
  if (!fixedRunMatches(projectId, run, session, fixed.referenceId, fixed.revision, fixed.contentHash) ||
      !options.runSessionAvailable || !await options.runSessionAvailable(projectId, run!, session!))
    fail("Fixed Run is no longer a readable bound terminal owned session");
  return JSON.stringify({ runId: run!.id, sourceTaskId: run!.taskId, sourceTaskRevisionId: run!.taskRevisionId,
    inputHash: run!.inputHash, state: run!.state, nativeTurnBound: true,
    evidenceRead: `read run ${run!.id} --project ${projectId} --trace`,
    note: "The inputHash identifies the frozen Run input, not the transcript. Read the scoped trace when needed; check completeness and unavailable items." });
}

async function readGit(options: ExternalMaterialOptions, git: DocumentSource, projectId: string,
  fixed: TaskExternalReferenceRecord): Promise<string> {
  const registered = await options.uow.read(projectId, reader => reader.getGitSourceRef(fixed.referenceId));
  if (!registered || registered.state !== "reachable" || registered.ref.projectId !== projectId ||
      registered.ref.commit !== fixed.revision || registered.ref.contentHash !== fixed.contentHash ||
      fixed.observedCurrentRevision !== fixed.revision || fixed.observedCurrentHash !== fixed.contentHash)
    fail("Fixed Git reference differs from its registered source or review baseline");
  const result = await git.read(registered.ref);
  if (result.status !== "available" || sha256(result.bytes) !== fixed.contentHash)
    fail("Fixed Git original is unavailable or hash mismatched");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.bytes); }
  catch { return fail("Fixed Git original is not UTF-8 text"); }
}

async function readWiki(_options: ExternalMaterialOptions, _principal: Principal, projectId: string,
  fixed: TaskExternalReferenceRecord, wiki: KnowledgeRepository): Promise<string> {
  const [page, current] = await Promise.all([
    wiki.get(projectId, fixed.referenceId, fixed.revision), wiki.get(projectId, fixed.referenceId),
  ]);
  if (!page || !current || page.projectId !== projectId || current.projectId !== projectId ||
      page.revision !== fixed.revision || page.contentHash !== fixed.contentHash ||
      !valid(page) || !valid(current) ||
      current.revision !== fixed.observedCurrentRevision || current.contentHash !== fixed.observedCurrentHash ||
      (current.revision !== fixed.revision && fixed.decision !== "retain"))
    fail("Fixed Wiki original changed, was withdrawn, or needs another review");
  const bytes = Buffer.from(page.body, "utf8");
  if (bytes.length > maxMaterialBytes || sha256(bytes) !== fixed.contentHash)
    fail("Fixed Wiki original is too large or hash mismatched");
  return page.body;
}
