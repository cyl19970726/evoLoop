// Pure wording and receipt bookkeeping for 协作回执 (Feishu projection). The coordinator and connector write their
// reasons in English for agents; the page says them in Chinese and keeps an unknown reason verbatim as diagnostics.
import type { StatusTone } from "@evoloop/ui";
import type { DeliveryAttempt, DeliveryRecord, IncomingRecord } from "@evoloop/contracts/delivery";

export const deliveryTag: Record<DeliveryRecord["state"], { label: string; tone: StatusTone; detail: string }> = {
  pending: { label: "待投影", tone: "waiting", detail: "等待协调器把任务写到飞书。" },
  claimed: { label: "已领取", tone: "progress", detail: "协调器已领取，准备写入。" },
  dispatching: { label: "写入中", tone: "progress", detail: "正在请求飞书写入。" },
  applied: { label: "已同步", tone: "done", detail: "远端回读与本地版本一致。" },
  unknown: { label: "结果未知", tone: "unknown", detail: "写入结果没有回读到，只能按稳定键对账，不能重发。" },
  conflict: { label: "远端冲突", tone: "blocked", detail: "远端记录与本地版本对不上，需要人判断。" },
  failed: { label: "写入失败", tone: "blocked", detail: "请求明确失败，可以写明依据后请求重新投影。" },
};

export const incomingTag: Record<IncomingRecord["state"], { label: string; tone: StatusTone }> = {
  pending: { label: "待审阅", tone: "waiting" },
  "review-only": { label: "仅供审阅", tone: "waiting" },
  applied: { label: "已采纳", tone: "done" },
  rejected: { label: "已拒绝", tone: "history" },
  conflict: { label: "有冲突", tone: "blocked" },
  unknown: { label: "结果未知", tone: "unknown" },
};

export const attemptActionLabel: Record<DeliveryAttempt["action"], string> = { dispatch: "写入", reconcile: "对账", retry: "重新投影", recover: "中断恢复" };

const reasons: Record<string, string> = {
  "Task revision or current projection authority changed": "任务修订或投影授权已变化。",
  "Task revision or projection authority changed before reconciliation": "对账前任务修订或投影授权已变化。",
  "Project integration grant was withdrawn": "项目的飞书集成授权已撤回。",
  "connector outcome unknown": "连接器没有返回结果。",
  "unexpected connector failure": "连接器意外失败。",
  "remote identity mismatch": "远端记录的身份与本地任务不符。",
  "remote content differs from projection intent": "远端内容与本次要写入的内容不同。",
  "binding identity mismatch": "已登记的远端绑定与本地任务不符。",
  "duplicate remote entity keys": "远端有多条记录指向同一个任务。",
  "remote record not found; absence does not prove create was not accepted": "远端没找到记录；没找到不能证明创建没有成功。",
  "binding points to another remote record": "已登记的绑定指向另一条远端记录。",
  "invalid projection intent": "要写入的内容不完整。",
  "stale or mismatched binding": "远端绑定已过期或不匹配。",
  "bound remote record missing": "已绑定的远端记录不见了。",
  "bound remote identity changed": "已绑定的远端记录身份变了。",
  "prior update outcome unresolved; no automatic replay": "上一次更新的结果还没核实，不会自动重放。",
  "local version did not advance": "本地版本没有前进。",
  "remote changed since confirmed baseline": "远端在上次确认之后被修改过。",
  "update acknowledged but readback missing": "远端接受了更新，但回读不到结果。",
  "create acknowledged but readback missing": "远端接受了创建，但回读不到结果。",
  "remote record has no confirmed local binding": "这条远端记录没有已确认的本地任务。",
  "confirmed remote record missing from complete scan": "完整扫描时没找到已确认的远端记录。",
  "self projection or no supported change": "是本端写入的结果，或没有可采纳的修改。",
  "remote identity or local baseline differs": "远端记录身份或本地基线对不上。",
  "external actor not verified": "修改人身份没有核实。",
  "already decided": "这条候选已经处理过。",
  "original Task operation still unconfirmed; do not issue a second command": "原任务操作结果还没核实，不要再发第二次。",
};

/** A reason in Chinese, with the original kept when it is not one the page knows. */
export function reasonText(raw: string | null | undefined): { text: string; original: string | null } {
  if (!raw?.trim()) return { text: "", original: null };
  const known = reasons[raw.trim()];
  return known ? { text: known, original: null } : { text: "协调器给出了一条页面不认识的原因，原文在“完整标识”里。", original: raw };
}

/** Configured, verified, and the last connection problem are three separate facts. */
export function connectionSummary(configured: boolean, verifiedAt: string | null, error: string | null): { label: string; tone: StatusTone; sentence: string } {
  if (!configured) return { label: "未配置", tone: "idle", sentence: "飞书连接还没有配置。项目里的任务、文档和使用记录照常可用。" };
  if (error) return { label: "无法核实", tone: "unknown", sentence: "这次没能核实飞书连接。先回读状态和原操作结果，再决定下一步。" };
  if (!verifiedAt) return { label: "待核实", tone: "waiting", sentence: "已配置，还没有核实过远端读取。" };
  return { label: "已核实", tone: "done", sentence: "已核实远端读取。任务、投影、通知和实际阅读仍分别核对；远端表格不会直接改写已接受的任务。" };
}

/** Applying a remote edit is allowed only for a verified editor proposing a title, with no status change. */
export function canApplyIncoming(item: IncomingRecord): boolean {
  return item.state === "pending" && !item.reviewOnly && !!item.actor?.verified && !!item.patch.title && !item.patch.status;
}

export type ReceiptKind = "reconcile" | "retry" | "poll" | "review";
export interface Receipt { projectId: string; actorId: string; kind: ReceiptKind; id: string; operationId?: string; createdAt: string }
export const receiptKindLabel: Record<ReceiptKind, string> = { reconcile: "对账", retry: "请求重新投影", poll: "回读远端变化", review: "审阅远端修改" };

/** Receipts of writes whose result is not yet known: project, actor and object IDs only, never a token. */
export const receiptStorageKey = "evoloop:collaboration:uncertain";
type Store = Pick<Storage, "getItem" | "setItem">;
export function readReceipts(store: Store | null): Receipt[] {
  try { const value = JSON.parse(store?.getItem(receiptStorageKey) ?? "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
const sameReceipt = (a: Pick<Receipt, "projectId" | "kind" | "id">, b: Pick<Receipt, "projectId" | "kind" | "id">) => a.projectId === b.projectId && a.kind === b.kind && a.id === b.id;
export function rememberReceipt(store: Store | null, receipt: Receipt): void {
  try { store?.setItem(receiptStorageKey, JSON.stringify([...readReceipts(store).filter(item => !sameReceipt(item, receipt)), receipt].slice(-100))); }
  catch { /* the in-page warning still shows */ }
}
export function clearReceipt(store: Store | null, receipt: Pick<Receipt, "projectId" | "kind" | "id">): void {
  try { store?.setItem(receiptStorageKey, JSON.stringify(readReceipts(store).filter(item => !sameReceipt(item, receipt)))); }
  catch { /* the page still rereads */ }
}
export const receiptsFor = (store: Store | null, projectId: string, actorId: string) =>
  readReceipts(store).filter(item => item.projectId === projectId && item.actorId === actorId);

/** Whether reading back by the original ID settles a receipt. */
export function receiptSettled(receipt: Receipt, read: { delivery?: DeliveryRecord | null; incoming?: IncomingRecord | null; verifiedAt?: string | null }): boolean {
  if (receipt.kind === "review") return !!read.incoming && ["applied", "rejected", "conflict"].includes(read.incoming.state);
  if (receipt.kind === "poll") return !!read.verifiedAt && Date.parse(read.verifiedAt) >= Date.parse(receipt.createdAt);
  if (!read.delivery) return false;
  return receipt.kind === "reconcile" ? ["applied", "conflict", "failed"].includes(read.delivery.state) : read.delivery.state !== "failed";
}

/** Merge pages by identity; a later page never duplicates a row. */
export function mergeById<T>(items: readonly T[], id: (item: T) => string): T[] {
  return [...new Map(items.map(item => [id(item), item])).values()];
}
