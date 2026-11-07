import { useEffect, useState, type ReactNode } from "react";
import type { DirectInputCapability, DirectInputReceipt } from "@evoloop/contracts/direct-input";
import { ApiError, errorText } from "../api";
import { directInputClient, explicitlyUnaccepted } from "./directInputClient";

const stateLabel: Record<DirectInputReceipt["state"], string> = {
  pending: "准备发送", attempted: "发送中，等待原操作回执", accepted: "原生已接收；不代表 Agent 已阅读或采用",
  rejected: "已拒绝", unknown: "结果未知，请按原输入核对",
};

/** The original input ID survives a page reload. A lost acknowledgement never starts a new send. */
export function DirectInputEntry({ token, projectId, sessionId, actorId, fallback, onApplied }: {
  token: string; projectId: string; sessionId: string; actorId: string; fallback: ReactNode; onApplied(): void;
}) {
  const client = directInputClient(token, projectId, sessionId);
  const storageKey = `direct-input:${projectId}:${sessionId}:${actorId}`;
  const operationStorageKey = `${storageKey}:operation`;
  const [capability, setCapability] = useState<DirectInputCapability | null>(null);
  const [content, setContent] = useState("");
  const [pendingId, setPendingId] = useState(() => sessionStorage.getItem(storageKey));
  const [receipt, setReceipt] = useState<DirectInputReceipt | null>(null);
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
      sessionStorage.removeItem(storageKey); sessionStorage.removeItem(operationStorageKey); setPendingId(null);
      if (value.state === "accepted") { setContent(""); onApplied(); }
    }
  };
  const send = async () => {
    if (!capability?.available || !capability.mode || busy || pendingId || !content.trim()) return;
    const inputId = crypto.randomUUID(), operationId = crypto.randomUUID();
    sessionStorage.setItem(storageKey, inputId);
    sessionStorage.setItem(operationStorageKey, operationId);
    setPendingId(inputId); setReceipt(null); setError(""); setBusy(true);
    try { finish(await client.submit({ inputId, operationId, content: content.trim(),
      expectedTurnId: capability.mode === "steer" ? capability.expectedTurnId : null })); }
    catch (cause) {
      // Read the original intent even after a clear HTTP error: the server may have reserved it.
      try { finish(await client.read(inputId)); }
      catch (readError) {
        if (explicitlyUnaccepted(cause) && readError instanceof ApiError && readError.status === 404) {
          sessionStorage.removeItem(storageKey); sessionStorage.removeItem(operationStorageKey); setPendingId(null);
          setError(`未接收：${errorText(cause)}`);
        } else setError("发送结果未知；保留原输入 ID，请核对后继续。");
      }
    } finally { setBusy(false); }
  };
  const reconcile = async () => {
    if (!pendingId || busy) return;
    setBusy(true); setError("");
    try { finish(await client.reconcile(pendingId)); }
    catch (cause) { setError(`原输入核对未完成：${errorText(cause)}`); }
    finally { setBusy(false); }
  };
  const direct = capability?.available === true && !!capability.mode;
  return <>
    {(pendingId || receipt) && <div className="session-direct-receipt" role="status"><strong>{receipt ? stateLabel[receipt.state] : "正在读取原输入回执"}</strong>
      <small>输入 ID：{receipt?.inputId ?? pendingId}</small>{receipt?.actualTurnId && <small>原 Turn：{receipt.actualTurnId}</small>}
      {receipt?.reason && <span>{receipt.reason}</span>}
      {pendingId && <button type="button" disabled={busy} onClick={() => void reconcile()}>按原输入核对</button>}</div>}
    {error && <p className="session-direct-error" role="alert">{error}</p>}
    {direct ? <form className="session-direct-form" onSubmit={event => { event.preventDefault(); void send(); }}>
      <label htmlFor="session-direct-content">即时发送到原 Session</label>
      <textarea id="session-direct-content" value={content} onChange={event => setContent(event.target.value)}
        maxLength={16000} placeholder={capability.mode === "steer" ? "补充到当前 Turn…" : "开始原 Session 的一轮对话…"}
        onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
      <button type="submit" disabled={busy || !!pendingId || !content.trim()}>{busy ? "发送中…" : capability.mode === "steer" ? "补充当前 Turn" : "开始一轮对话"}</button>
      <small>{capability.mode === "steer" ? `目标 Turn：${capability.expectedTurnId}` : "原 Thread 空闲直启；按原额度计一轮。"}</small>
    </form> : !pendingId ? fallback : null}
  </>;
}
