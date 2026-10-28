import { createHash } from "node:crypto";
import type { BasisSet, RuntimeRunRecord, TaskRevision } from "@evoloop/contracts";
import type { FixedDocumentSummary } from "./materials.js";
import { PreflightError } from "./preflight-report.js";
import { parseQueueHandoff } from "@evoloop/contracts/runtime-handoff";

export const lightweightInputProtocol = "evoloop-lightweight-v1";
export interface CliBootstrap { command: string; actorId: string }
const maxInputBytes = 256 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function preview(value: string, maxBytes: number) {
  let text = "", bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    text += character; bytes += size;
  }
  // A long encoded token is a material pointer, never useful as a partial first-message excerpt.
  const rawPrefix = text;
  text = text.replace(/data:[^\s;,]{1,100};base64,[A-Za-z0-9+/=]+/gi, "[encoded resource omitted]")
    .replace(/[A-Za-z0-9+/=]{256,}/g, "[long token omitted]");
  const totalBytes = Buffer.byteLength(value, "utf8");
  return { text, totalBytes, truncated: bytes < totalBytes || text !== rawPrefix };
}

/** This is the exact native Turn message; the Run inputHash still hashes run.input alone. */
export function buildLightweightInput(run: RuntimeRunRecord, revision: TaskRevision, basis: BasisSet,
  documents: FixedDocumentSummary[], cliBootstrap: CliBootstrap | null = null) {
  if (revision.id !== run.taskRevisionId || revision.taskId !== run.taskId ||
      basis.id !== run.basisSetId || basis.taskRevisionId !== run.taskRevisionId ||
      hash(run.input) !== run.inputHash ||
      documents.length !== new Set(documents.map(document => `${document.documentId}:${document.revisionId}`)).size ||
      !documents.some(document => document.documentId === revision.contentDocumentId &&
        document.revisionId === revision.contentRevisionId))
    throw new PreflightError("FIXED_SOURCE_INVALID", { kind: "task", id: run.taskId, revisionId: run.taskRevisionId });
  const queue = parseQueueHandoff(run.input);
  if (queue) {
    if (queue.taskId !== run.taskId || queue.taskRevisionId !== run.taskRevisionId ||
        queue.basisSetId !== run.basisSetId || !cliBootstrap ||
        cliBootstrap.actorId !== queue.channel.recipientActorId)
      throw new PreflightError(!cliBootstrap ? "CLI_ENTRY_UNAVAILABLE" : "FIXED_SOURCE_INVALID",
        { kind: "task", id: run.taskId, revisionId: run.taskRevisionId });
    const introduction = revision.content.replace(/^# .+\n+/, "").split(/\n\s*\n/)[0]?.trim() ?? "";
    const purposePreview = preview(introduction, 900);
    const shortPurpose = purposePreview.text ? `\n${purposePreview.text}${purposePreview.truncated ? "…（完整目标见固定接手结果）" : ""}\n` : "";
    const reasonPreview = queue.reason ? preview(queue.reason, 600) : null;
    const reason = reasonPreview?.truncated ? "详情见固定接手结果" : queue.reason ?? "查看固定接手结果";
    const change = queue.kind === "queue.claim" ? "" :
      `\n## 本轮变化\n${queue.kind === "queue.retryFailed" ? "重试" : "接续"}：${reason}。`+
      (queue.previousRun ? `来源 Run ${queue.previousRun.id}，输入 SHA-256 ${queue.previousRun.inputHash}。` : "")+
      (queue.answers.length ? `本轮有 ${queue.answers.length} 份已答问题的固定修订，请在接手结果中按需读取。` : "")+"\n";
    const input = `[evoloop-run-operation:${run.operationId}]\n# 任务：${revision.title}\n${shortPurpose}`+
      `\n## 开始\n读取本次固定目标、完整验收、变化与资料目录：\n\n`+
      `\`\`\`sh\n${cliBootstrap.command} handoff ${run.id} --project ${run.projectId} --hash ${run.inputHash}\n\`\`\`\n`+
      `先用同一入口的 session 命令核身份；正文与附件按目录中的固定修订和哈希分段读取。`+
      change+`\n## 反馈与交付\n交给 ${queue.channel.issuerActorId}。当前 Task 通道 ${queue.channel.discussionId}；用已核身份在这里提问和交结果。`+
      `原生 Turn 完成不等于 Delivery、实际使用或 Task 关闭。\n`;
    const byteLength = Buffer.byteLength(input, "utf8");
    if (byteLength > maxInputBytes) throw new PreflightError("INPUT_LIMIT",
      { kind: "task", id: run.taskId, revisionId: run.taskRevisionId }, byteLength, maxInputBytes);
    return { protocol: "evoloop-markdown-v2", input, contentHash: hash(input), byteLength };
  }
  const source = (document: FixedDocumentSummary) => ({ role: document.documentId === revision.contentDocumentId &&
    document.revisionId === revision.contentRevisionId ? "primary" : "basis", ...document });
  const inlineInput = Buffer.byteLength(run.input, "utf8") <= 16 * 1024 ? run.input : null;
  const taskPreview = preview(revision.content, 1200), acceptancePreview = preview(revision.acceptance, 1200);
  const needsCli = inlineInput === null || taskPreview.truncated || acceptancePreview.truncated ||
    documents.some(document => document.documentId !== revision.contentDocumentId ||
      document.revisionId !== revision.contentRevisionId || document.bodyBytes === null || document.assetCount > 0);
  if (!cliBootstrap && needsCli)
    throw new PreflightError("CLI_ENTRY_UNAVAILABLE", { kind: "task", id: run.taskId, revisionId: run.taskRevisionId });
  const fixed = {
    protocol: lightweightInputProtocol, projectId: run.projectId, taskId: run.taskId,
    taskRevisionId: run.taskRevisionId, basisSetId: run.basisSetId,
    runId: run.id, sessionId: run.sessionId, operationId: run.operationId,
    title: revision.title,
    taskPreview, acceptancePreview,
    runInstructionPreview: { ...preview(run.input, 4096), inputHash: run.inputHash },
    runInstructionExactInline: inlineInput,
    cliBootstrap: cliBootstrap ? { ...cliBootstrap, source: "verified-run-binding" } : null,
    runInstructionRead: {
      requiredBeforeAction: true, inputHash: run.inputHash, totalBytes: Buffer.byteLength(run.input, "utf8"),
      command: cliBootstrap ? `${cliBootstrap.command} run-input ${run.id} --project ${run.projectId} --hash ${run.inputHash} --out NEW_PRIVATE_FILE` : null,
      subcommand: `run-input ${run.id} --project ${run.projectId} --hash ${run.inputHash} --out NEW_PRIVATE_FILE`,
      path: `/api/projects/${run.projectId}/runtime/runs/${run.id}/input`,
    },
    fixedDocuments: documents.map(source),
    taskCatalogPath: `/api/projects/${run.projectId}/tasks/${run.taskId}/revisions/${run.taskRevisionId}/materials`,
  };
  const input = `[evoloop-run-operation:${run.operationId}]\n${JSON.stringify(fixed)}\n` +
    "This is a bounded handoff, not the full Task or original materials. Before acting, use runInstructionRead.command when supplied to read and verify the complete exact Run instruction with its fixed inputHash; this includes queue answers, continuation, retry and Task-channel directions even when the preview looks complete. The exact Run instruction is also included inline when short enough; verify it against inputHash. Do not guess a CLI path or search for credentials. For catalog commands, replace their illustrative 'evoloop' prefix with cliBootstrap.command. Read the fixed Task material catalog, then page through required text and fetch selected assets separately. Verify returned revision IDs and SHA-256. Read complete Task acceptance when its excerpt is truncated. Preserve the fixed basis; a newer current revision is not a substitute. Native Turn completion is not Delivery or consumer use.";
  const byteLength = Buffer.byteLength(input, "utf8");
  if (byteLength > maxInputBytes) throw new PreflightError("INPUT_LIMIT", { kind: "task", id: run.taskId, revisionId: run.taskRevisionId }, byteLength, maxInputBytes);
  return { protocol: lightweightInputProtocol, input, contentHash: hash(input), byteLength };
}
