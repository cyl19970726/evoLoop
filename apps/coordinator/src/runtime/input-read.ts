import { createHash } from "node:crypto";
import type { RuntimeRunRecord } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";

/** Read the Run's exact reserved instruction in UTF-8 pages, including queue continuation context. */
export function runInputPage(run: RuntimeRunRecord, cursor = 0, limit = 4096) {
  const bytes = Buffer.from(run.input, "utf8");
  const actualHash = cursor === 0 ? createHash("sha256").update(bytes).digest("hex") : run.inputHash;
  if (actualHash !== run.inputHash)
    throw new DomainError("RUN_INPUT_INVALID", "The reserved Run input no longer matches its fixed hash");
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > bytes.length ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 8192 ||
      cursor > 0 && cursor < bytes.length && (bytes[cursor]! & 0xc0) === 0x80)
    throw new DomainError("INVALID_CURSOR", "Run input cursor or page size is invalid");
  let end = Math.min(cursor + limit, bytes.length);
  while (end > cursor && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  if (end === cursor && cursor < bytes.length) {
    end = Math.min(cursor + 4, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
  }
  return { projectId: run.projectId, runId: run.id, taskRevisionId: run.taskRevisionId,
    sessionId: run.sessionId, operationId: run.operationId, inputHash: run.inputHash,
    body: bytes.subarray(cursor, end).toString("utf8"), startByte: cursor, endByte: end,
    totalBytes: bytes.length, nextCursor: end < bytes.length ? String(end) : null,
    truncated: end < bytes.length };
}
