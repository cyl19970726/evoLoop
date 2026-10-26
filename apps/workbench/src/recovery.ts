import type { Operation } from "@evoloop/contracts";
export interface OperationReceipt {
  actorId: string;
  projectId: string;
  taskId: string;
  operationId: string;
  commandType: Operation["commandType"];
  createdAt: string;
  /** SHA-256 of the core's canonical actor+command intent; never the command body. */
  commandHash?: string;
}

const storageKey = "evoloop.unconfirmed-operations.v1";

function onlyRecoveryFields(item: OperationReceipt): OperationReceipt {
  return {
    actorId: item.actorId, projectId: item.projectId, taskId: item.taskId,
    operationId: item.operationId, commandType: item.commandType, createdAt: item.createdAt,
    ...(item.commandHash && /^[0-9a-f]{64}$/i.test(item.commandHash) ? { commandHash: item.commandHash } : {}),
  };
}

function isReceipt(value: unknown): value is OperationReceipt {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OperationReceipt>;
  return typeof item.actorId === "string" && item.actorId.length > 0
    && typeof item.projectId === "string" && typeof item.taskId === "string"
    && typeof item.operationId === "string" && typeof item.commandType === "string" && /^[a-z]+(?:\.[a-zA-Z]+)+$/.test(item.commandType)
    && typeof item.createdAt === "string";
}

export function parseReceipts(raw: string | null): OperationReceipt[] {
  if (!raw) return [];
  try {
    const values: unknown = JSON.parse(raw);
    return Array.isArray(values) ? values.filter(isReceipt).filter((r, i, all) => all.findIndex(v => v.operationId === r.operationId) === i).map(onlyRecoveryFields) : [];
  } catch { return []; }
}

export function addReceipt(current: OperationReceipt[], receipt: OperationReceipt): OperationReceipt[] {
  return current.some(item => item.operationId === receipt.operationId) ? current : [...current, receipt];
}

export function removeReceipt(current: OperationReceipt[], operationId: string): OperationReceipt[] {
  return current.filter(item => item.operationId !== operationId);
}

export function visibleReceipts(current: OperationReceipt[], actorId: string, projectIds: string[]): OperationReceipt[] {
  return current.filter(item => item.actorId === actorId && projectIds.includes(item.projectId));
}

export function hasProjectReceipt(current: OperationReceipt[], projectId: string): boolean {
  return current.some(item => item.projectId === projectId);
}

export function readReceipts(): OperationReceipt[] {
  try { return parseReceipts(window.sessionStorage.getItem(storageKey)); }
  catch { return []; }
}

export function writeReceipts(receipts: OperationReceipt[]): boolean {
  try { window.sessionStorage.setItem(storageKey, JSON.stringify(receipts.map(onlyRecoveryFields))); return true; }
  catch { return false; }
}
