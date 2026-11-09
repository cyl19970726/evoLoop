// 即时输入: a message that goes straight into the agent's runtime, either starting a turn (idle) or adding to the running
// one (where the runtime declares it can). The original input ID survives a page reload and a lost acknowledgement
// never starts a new send: an unknown outcome is checked by that ID only. An explicit refusal before anything was
// reserved leaves an audit receipt instead.
import { useEffect, useState } from "react";
import type { DirectInputCapability, DirectInputReceipt } from "@evoloop/contracts/direct-input";
import { Button, Notice } from "@evoloop/ui";
import { ApiError, errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { directInputClient, explicitlyUnaccepted } from "./directInputClient";

const stateLabel: Record<DirectInputReceipt["state"], string> = {
  pending: "准备发送", attempted: "发送中，等待原操作回执", accepted: "运行时已接收；不代表智能体已阅读或采用",
  rejected: "运行时已拒绝这条输入", unknown: "发送结果未知，需核对原操作",
};
type ExplicitAudit = { inputId: string; operationId: string; reason: string; observedAt: string };
const readAudit = (value: string | null): ExplicitAudit | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ExplicitAudit>;
    return typeof parsed.inputId === "string" && typeof parsed.operationId === "string" &&
      typeof parsed.reason === "string" && typeof parsed.observedAt === "string"
      ? parsed as ExplicitAudit : null;
  } catch { return null; }
};
const explicitReason = (error: unknown) => {
  const code = error instanceof ApiError && error.detail && typeof error.detail === "object"
    ? (error.detail as { code?: unknown }).code : null;
  // The audit receipt keeps the service's own words; the page shows them only in the source layer.
  const said = error instanceof Error && error.message.trim() ? error.message : errorText(error);
  return typeof code === "string" ? `${code}：${said}` : said;
};
const storage = {
  get: (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } },
  set: (key: string, value: string) => { try { sessionStorage.setItem(key, value); } catch { /* the in-memory state still guards this page */ } },
  remove: (key: string) => { try { sessionStorage.removeItem(key); } catch { /* nothing kept */ } },
};

export interface DirectInput {
  /** undefined while read, null when it could not be read. */
  capability: DirectInputCapability | null | undefined;
  /** An input whose outcome is not known yet: nothing new is sent until it is checked. */
  pending: boolean;
  busy: boolean;
  /** Sends `content` as 即时输入; resolves true once the runtime accepted it. */
  send(content: string): Promise<boolean>;
  receipt: React.ReactNode;
}

/** `active` is false for agents the runtime does not manage (external ones): nothing is read or sent. */
export function useDirectInput({ projectId, sessionId, actorId, active, onAccepted }: {
  projectId: string; sessionId: string; actorId: string; active: boolean; onAccepted(): void;
}): DirectInput {
  const client = directInputClient("", projectId, sessionId);
  const storageKey = `direct-input:${projectId}:${sessionId}:${actorId}`;
  const operationStorageKey = `${storageKey}:operation`;
  const auditStorageKey = `${storageKey}:explicit-audit`;
  const capability = useProjectQuery(projectId, ["session-direct-input", sessionId, "capability"],
    signal => client.capability(signal), { enabled: active, refetchInterval: 5000 });
  const [pendingId, setPendingId] = useState(() => active ? storage.get(storageKey) : null);
  const [receipt, setReceipt] = useState<DirectInputReceipt | null>(null);
  const [audit, setAudit] = useState<ExplicitAudit | null>(() => active ? readAudit(storage.get(auditStorageKey)) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setPendingId(active ? storage.get(storageKey) : null); setAudit(active ? readAudit(storage.get(auditStorageKey)) : null);
    setReceipt(null); setError("");
  }, [storageKey, active]);
  const finish = (value: DirectInputReceipt, inputId: string): boolean => {
    // Only the receipt of this exact input settles it; anything else leaves the outcome unknown.
    if (!value || value.inputId !== inputId || !Object.hasOwn(stateLabel, value.state)) { setError("原输入回执与这条输入不符，结果未知；请核对后继续。"); return false; }
    setReceipt(value); setError("");
    if (value.state === "accepted" || value.state === "rejected") {
      storage.remove(storageKey); storage.remove(operationStorageKey); storage.remove(auditStorageKey);
      setAudit(null); setPendingId(null);
      if (value.state === "accepted") { onAccepted(); return true; }
    }
    return false;
  };
  useEffect(() => {
    if (!pendingId || !active) return;
    let live = true;
    void client.read(pendingId).then(value => { if (live) finish(value, pendingId); })
      .catch(cause => { if (live) setError(`原输入回执暂不可读取：${errorText(cause)}`); });
    return () => { live = false; };
  }, [projectId, sessionId, pendingId, active]);
  const current = capability.isError ? null : capability.data;
  async function send(content: string): Promise<boolean> {
    if (!current?.available || !current.mode || busy || pendingId || !content.trim()) return false;
    const inputId = crypto.randomUUID(), operationId = crypto.randomUUID();
    storage.set(storageKey, inputId); storage.set(operationStorageKey, operationId); storage.remove(auditStorageKey);
    setAudit(null); setPendingId(inputId); setReceipt(null); setError(""); setBusy(true);
    try {
      return finish(await client.submit({ inputId, operationId, content: content.trim(),
        expectedTurnId: current.mode === "steer" ? current.expectedTurnId : null }), inputId);
    } catch (cause) {
      // Read the original intent even after a clear HTTP error: the server may have reserved it.
      try { return finish(await client.read(inputId), inputId); }
      catch (readError) {
        if (explicitlyUnaccepted(cause) && readError instanceof ApiError && readError.status === 404) {
          const rejected = { inputId, operationId, reason: explicitReason(cause), observedAt: new Date().toISOString() };
          storage.remove(storageKey); storage.remove(operationStorageKey); storage.set(auditStorageKey, JSON.stringify(rejected));
          setPendingId(null); setAudit(rejected); setError("");
        } else setError("发送结果未知；保留原输入 ID，请核对后继续。");
        return false;
      }
    } finally { setBusy(false); }
  }
  async function reconcile() {
    if (!pendingId || busy) return;
    setBusy(true); setError("");
    try { finish(await client.reconcile(pendingId), pendingId); }
    catch (cause) { setError(`核对发送结果未完成：${errorText(cause)}`); }
    finally { setBusy(false); }
  }
  const unknown = !!pendingId;
  const view = <>
    {(pendingId || receipt) && <div className="session-direct-receipt" role={pendingId && error ? "alert" : "status"}>
      <Notice tone={pendingId ? "waiting" : receipt?.state === "rejected" ? "error" : "info"}
        title={receipt ? stateLabel[receipt.state] : error || "正在读取原输入回执"}
        action={pendingId ? <Button size="compact" disabled={busy} onClick={() => void reconcile()}>核对结果（不会重发）</Button> : undefined}>
        {pendingId && <p>只按原输入核对，不会重发。核对前不能发送新消息，草稿仍保留在输入框里。</p>}
        {receipt?.reason && <p>{receipt.state === "rejected" ? "运行时说明了拒绝原因，原文见完整标识。" : "运行时附了说明，原文见完整标识。"}</p>}
        {receipt && pendingId && error && <p>{error}</p>}
        <FullIdentifiers rows={[
          { label: "输入 ID", value: receipt?.inputId ?? pendingId },
          { label: "原轮次 ID", value: receipt?.actualTurnId },
          { label: "运行时说明原文", value: receipt?.reason, text: true },
        ]} />
      </Notice>
    </div>}
    {audit && <div className="flex flex-col gap-1 text-caption text-muted-foreground">
      <span>上一条即时输入被明确拒绝，没有送出；可以修改后重新发送。</span>
      <FullIdentifiers className="session-direct-audit" summary="明确未接收 · 查看审计回执" rows={[
        { label: "输入 ID", value: audit.inputId }, { label: "操作 ID", value: audit.operationId },
        { label: "拒绝原因原文", value: audit.reason, text: true }, { label: "记录于", value: new Date(audit.observedAt).toLocaleString("zh-CN"), text: true },
      ]} />
    </div>}
    {error && !pendingId && <p className="text-caption text-destructive" role="alert">{error}</p>}
  </>;
  return { capability: active ? capability.isPending ? undefined : current ?? null : null, pending: unknown, busy, send, receipt: view };
}
