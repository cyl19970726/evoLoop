// Publish and retract go to the outside knowledge service. Before sending, the operation ID is kept in this tab's
// session storage, so a lost answer can be reconciled by the same ID instead of being sent again under a new one.
export interface ExternalReceipt { projectId: string; actorId: string; operationId: string; kind: "publish" | "retract"; targetId: string; createdAt: string }

const receiptKey = "evoloop.external-knowledge-operations.v1";

export function readReceipts(store: Pick<Storage, "getItem"> | null = typeof sessionStorage === "undefined" ? null : sessionStorage): ExternalReceipt[] {
  try {
    const values: unknown = JSON.parse(store?.getItem(receiptKey) ?? "[]");
    return Array.isArray(values) ? values.filter((value): value is ExternalReceipt => !!value && typeof value === "object" &&
      typeof value.projectId === "string" && typeof value.actorId === "string" &&
      typeof value.operationId === "string" && (value.kind === "publish" || value.kind === "retract") &&
      typeof value.targetId === "string" && typeof value.createdAt === "string") : [];
  } catch { return []; }
}

export function saveReceipts(values: ExternalReceipt[], store: Pick<Storage, "setItem"> | null = typeof sessionStorage === "undefined" ? null : sessionStorage): boolean {
  try { if (!store) return false; store.setItem(receiptKey, JSON.stringify(values)); return true; } catch { return false; }
}
