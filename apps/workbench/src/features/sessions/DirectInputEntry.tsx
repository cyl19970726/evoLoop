import { useEffect, useState, type ReactNode } from "react";
import type { DirectInputCapability, DirectInputReceipt } from "@evoloop/contracts/direct-input";
import { ApiError, errorText } from "../../shared/api";
import { directInputClient, explicitlyUnaccepted } from "./directInputClient";

const stateLabel: Record<DirectInputReceipt["state"], string> = {
  pending: "准备发送", attempted: "发送中，等待原操作回执", accepted: "原生已接收；不代表 Agent 已阅读或采用",
  rejected: "已拒绝", unknown: "发送结果未知，需核对原操作",
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
  // The audit receipt keeps the service's own words (errorText would say them in Chinese for the body).
  const said = error instanceof Error && error.message.trim() ? error.message : errorText(error);
  return typeof code === "string" ? `${code}：${said}` : said;
};

/** The original input ID survives a page reload. A lost acknowledgement never starts a new send. */
export function DirectInputEntry({ token, projectId, sessionId, actorId, fallback, onApplied }: {
  token: string; projectId: string; sessionId: string; actorId: string; fallback: ReactNode; onApplied(): void;
}) {
  const client = directInputClient(token, projectId, sessionId);
  const storageKey = `direct-input:${projectId}:${sessionId}:${actorId}`;
  const operationStorageKey = `${storageKey}:operation`;
  const auditStorageKey = `${storageKey}:explicit-audit`;
  const [capability, setCapability] = useState<DirectInputCapability | null>(null);
  const [content, setContent] = useState("");
  const [pendingId, setPendingId] = useState(() => sessionStorage.getItem(storageKey));
  const [receipt, setReceipt] = useState<DirectInputReceipt | null>(null);
  const [audit, setAudit] = useState<ExplicitAudit | null>(() => readAudit(sessionStorage.getItem(auditStorageKey)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const read = () => { void client.capability(controller.signal).then(value => setCapability(old =>
      old !== null && old.available === value.available && old.mode === value.mode &&
      old.expectedTurnId === value.expectedTurnId && old.reasonCode === value.reasonCode ? old : value
    )).catch(() => setCapability(null)); };
    read();
    const timer = window.setInterval(read, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [token, projectId, sessionId]);
  useEffect(() => {
    if (!pendingId) return;
    let live = true;
    void client.read(pendingId).then(value => { if (live) finish(value); })
      .catch(cause => { if (live) setError(`原输入回执暂不可读取：${errorText(cause)}`); });
    return () => { live = false; };
  }, [token, projectId, sessionId, pendingId]);
  const finish = (value: DirectInputReceipt) => {
    setReceipt(value); setError("");
    if (value.state === "accepted" || value.state === "rejected") {
      sessionStorage.removeItem(storageKey); sessionStorage.removeItem(operationStorageKey);
      sessionStorage.removeItem(auditStorageKey); setAudit(null); setPendingId(null);
      if (value.state === "accepted") { setContent(""); onApplied(); }
    }
  };
  const send = async () => {
    if (!capability?.available || !capability.mode || busy || pendingId || !content.trim()) return;
    const inputId = crypto.randomUUID(), operationId = crypto.randomUUID();
    sessionStorage.setItem(storageKey, inputId);
    sessionStorage.setItem(operationStorageKey, operationId);
    sessionStorage.removeItem(auditStorageKey);
    setAudit(null); setPendingId(inputId); setReceipt(null); setError(""); setBusy(true);
    try { finish(await client.submit({ inputId, operationId, content: content.trim(),
      expectedTurnId: capability.mode === "steer" ? capability.expectedTurnId : null })); }
    catch (cause) {
      // Read the original intent even after a clear HTTP error: the server may have reserved it.
      try { finish(await client.read(inputId)); }
      catch (readError) {
        if (explicitlyUnaccepted(cause) && readError instanceof ApiError && readError.status === 404) {
          const rejected = { inputId, operationId, reason: explicitReason(cause), observedAt: new Date().toISOString() };
          sessionStorage.removeItem(storageKey); sessionStorage.removeItem(operationStorageKey);
          sessionStorage.setItem(auditStorageKey, JSON.stringify(rejected));
          setPendingId(null); setAudit(rejected); setError("");
        } else setError("发送结果未知；保留原输入 ID，请核对后继续。");
      }
    } finally { setBusy(false); }
  };
  const reconcile = async () => {
    if (!pendingId || busy) return;
    setBusy(true); setError("");
    try { finish(await client.reconcile(pendingId)); }
    catch (cause) { setError(`核对发送结果未完成：${errorText(cause)}`); }
    finally { setBusy(false); }
  };
  const direct = capability?.available === true && !!capability.mode;
  const form = direct && <form className="session-direct-form" onSubmit={event => { event.preventDefault(); void send(); }}>
    <label htmlFor="session-direct-content">即时发送到原 Session</label>
    <textarea id="session-direct-content" value={content} onChange={event => setContent(event.target.value)}
      maxLength={16000} placeholder={capability.mode === "steer" ? "补充到当前 Turn…" : "开始原 Session 的一轮对话…"}
      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
    <button type="submit" disabled={busy || !!pendingId || !content.trim()}>{busy ? "发送中…" : capability.mode === "steer" ? "补充当前 Turn" : "开始一轮对话"}</button>
    <small>{capability.mode === "steer" ? `目标 Turn：${capability.expectedTurnId}` : "原 Thread 空闲直启；按原额度计一轮。"}</small>
  </form>;
  return <>
    {(pendingId || receipt) && <div className="session-direct-receipt" role={pendingId && error ? "alert" : "status"}><strong>{receipt ? stateLabel[receipt.state] : error || "正在读取原输入回执"}</strong>
      <small className="session-direct-input-id">输入 ID：{receipt?.inputId ?? pendingId}</small>{receipt?.actualTurnId && <small className="session-direct-turn-id">原 Turn：{receipt.actualTurnId}</small>}
      {receipt?.reason && <span>{receipt.reason}</span>}
      {pendingId && <small className="session-direct-no-resend-note">只读取原 inputId，不会重发。</small>}
      {pendingId && <button type="button" disabled={busy} onClick={() => void reconcile()}>核对结果（不会重发）</button>}</div>}
    {audit && <details className="session-direct-audit"><summary>明确未接收 · 查看审计回执</summary>
      <small className="session-direct-input-id">输入 ID：{audit.inputId}</small><small className="session-direct-operation-id">操作 ID：{audit.operationId}</small>
      <span>{audit.reason}</span><small>仅审计；不会恢复为未知草稿，可修正后重新发送。</small></details>}
    {error && !pendingId && <p className="session-direct-error" role="alert">{error}</p>}
    {pendingId && form ? <details className="session-direct-pending-draft"><summary>查看输入草稿</summary>{form}</details>
      : form || (!pendingId ? fallback : null)}
  </>;
}
