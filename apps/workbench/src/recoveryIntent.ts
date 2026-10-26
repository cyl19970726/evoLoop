import { commandSchema, type Command, type CommandResult, type Operation } from "@evoloop/contracts";
import { ApiError } from "./api";
import type { OperationReceipt } from "./recovery";

export function operationNotFound(value: unknown): value is ApiError {
  return value instanceof ApiError && value.status === 404 && !!value.detail
    && typeof value.detail === "object" && "code" in value.detail
    && value.detail.code === "OPERATION_NOT_FOUND";
}

// The original command can include private body text. It stays in the authenticated
// page's memory and disappears on reload or logout; sessionStorage holds metadata only.
const pending = new Map<string, { actorId: string; projectId: string; type: string; body: string; digest: Promise<string> }>();

// Mirrors core's canonicalJson for its SHA-256 operation digest.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("原命令包含无法核验的内容");
  return encoded;
}

async function sha256(body: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function rememberRecoveryIntent(actorId: string, value: unknown): void {
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) return; // Non-core endpoints have their own recovery contracts.
  const body = JSON.stringify(parsed.data);
  pending.set(parsed.data.operationId, { actorId, projectId: parsed.data.projectId,
    type: parsed.data.type, body, digest: sha256(canonicalJson({ actorId, command: parsed.data })) });
}

export async function recoveryIntent(receipt: OperationReceipt): Promise<Command | null> {
  const saved = pending.get(receipt.operationId);
  if (!saved || saved.actorId !== receipt.actorId || saved.projectId !== receipt.projectId
    || saved.type !== receipt.commandType) return null;
  try {
    const parsed = commandSchema.safeParse(JSON.parse(saved.body));
    return parsed.success && parsed.data.operationId === receipt.operationId
      && parsed.data.projectId === receipt.projectId && parsed.data.type === receipt.commandType
      && await sha256(canonicalJson({ actorId: receipt.actorId, command: parsed.data })) === await saved.digest
      ? parsed.data : null;
  } catch { return null; }
}

export async function verifyRecoveryOperation(receipt: OperationReceipt, operation: Operation): Promise<"match" | "unavailable" | "mismatch"> {
  if (operation.id !== receipt.operationId || operation.projectId !== receipt.projectId
    || operation.actorId !== receipt.actorId || operation.commandType !== receipt.commandType
    || operation.result.operationId !== receipt.operationId) return "mismatch";
  const command = await recoveryIntent(receipt);
  if (!command) return "unavailable";
  const hash = await sha256(canonicalJson({ actorId: receipt.actorId, command }));
  return operation.commandHash === hash ? "match" : "mismatch";
}

export function forgetRecoveryIntent(operationId: string): void { pending.delete(operationId); }
export function clearRecoveryIntents(): void { pending.clear(); }

export async function replayRecoveryIntent(receipt: OperationReceipt, read: () => Promise<Operation>,
  send: (command: Command) => Promise<CommandResult>): Promise<CommandResult> {
  let operation: Operation;
  try {
    operation = await read();
  } catch (cause) {
    if (!operationNotFound(cause)) throw cause;
    const command = await recoveryIntent(receipt);
    if (!command) throw new Error("原命令已不在当前页面内存中，不能安全重试");
    return send(command);
  }
  const verdict = await verifyRecoveryOperation(receipt, operation);
  if (verdict !== "match") throw new Error(verdict === "unavailable"
    ? "当前页面没有完整原命令，不能核验已存在操作的正文" : "操作记录与原命令摘要不匹配，不能确认或重试");
  return operation.result;
}
