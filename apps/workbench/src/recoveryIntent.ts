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

async function sha256(body: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function rememberRecoveryIntent(actorId: string, value: unknown): void {
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) return; // Non-core endpoints have their own recovery contracts.
  const body = JSON.stringify(parsed.data);
  pending.set(parsed.data.operationId, { actorId, projectId: parsed.data.projectId,
    type: parsed.data.type, body, digest: sha256(body) });
}

export async function recoveryIntent(receipt: OperationReceipt): Promise<Command | null> {
  const saved = pending.get(receipt.operationId);
  if (!saved || saved.actorId !== receipt.actorId || saved.projectId !== receipt.projectId
    || saved.type !== receipt.commandType) return null;
  try {
    if (await sha256(saved.body) !== await saved.digest) return null;
    const parsed = commandSchema.safeParse(JSON.parse(saved.body));
    return parsed.success && parsed.data.operationId === receipt.operationId
      && parsed.data.projectId === receipt.projectId && parsed.data.type === receipt.commandType ? parsed.data : null;
  } catch { return null; }
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
  if (operation.id !== receipt.operationId || operation.projectId !== receipt.projectId
    || operation.actorId !== receipt.actorId || operation.commandType !== receipt.commandType
    || operation.result.operationId !== receipt.operationId)
    throw new Error("操作记录与本地回执不匹配，不能重试");
  return operation.result;
}
