import { useEffect, useState } from "react";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { date } from "../ui/shared";
import { sessionClient } from "./client";
import type { NativeProgressView } from "./NativeSessionPanel";
import { executionSourceNote, messageStateLabel, nativeExecutionLabel } from "./executionStatusPresentation";

type MessageRead = { key: string; message: SessionMessageRecord | null; error: string | null };
const states = new Set(["queued", "processing", "replied", "completed_without_reply", "failed", "unknown", "cancelled", "manual_pending"]);

export function SessionExecutionFacts({ token, projectId, sessionId, progress, currentRead, refreshKey }: {
  token: string; projectId: string; sessionId: string; progress: NativeProgressView | null;
  currentRead: boolean; refreshKey: string;
}) {
  const messageId = progress?.turn?.source?.kind === "message" ? progress.turn.source.id : null;
  const processingId = progress?.turn?.source?.kind === "message" ? progress.turn.source.processingId : null;
  const readKey = `${messageId}:${processingId}:${refreshKey}`;
  const [read, setRead] = useState<MessageRead | null>(null);
  useEffect(() => {
    if (!messageId || !currentRead) return;
    const controller = new AbortController();
    setRead(null);
    void sessionClient(token, projectId).message(messageId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const message = value.message;
      const processing = value.processing;
      if (message.id !== messageId || message.projectId !== projectId || !states.has(message.state) ||
        !Number.isFinite(Date.parse(message.updatedAt)) || message.target.kind !== "owned" ||
        message.target.sessionId !== sessionId || processing && (processing.messageId !== messageId ||
          processing.projectId !== projectId || processing.sessionId !== sessionId || processing.id !== processingId) ||
        processingId && !processing) {
        setRead({ key: readKey, message: null, error: "消息来源与当前 Session 不符" });
        return;
      }
      setRead({ key: readKey, message, error: null });
    }).catch(() => { if (!controller.signal.aborted) setRead({ key: readKey, message: null, error: "消息记录暂不可读取" }); });
    return () => controller.abort();
  }, [token, projectId, sessionId, messageId, processingId, currentRead, readKey]);
  const message = read?.key === readKey ? read.message : null;
  const messageState = currentRead && message ? message.state : null;
  const messageSummary = !messageId ? "当前 Turn 未绑定普通消息" : !currentRead ? "当前读取未确认，消息状态待核对"
    : message ? `${messageStateLabel(message.state)} · 更新于 ${date(message.updatedAt)}`
      : read?.key === readKey && read.error ? `${read.error}，状态未知` : "正在读取原消息状态…";
  return <section className="session-execution-facts" aria-label="执行与消息状态">
    <h2>执行与消息状态</h2>
    <dl><div><dt>原生执行状态</dt><dd>{nativeExecutionLabel(progress, currentRead)}</dd></div>
      <div><dt>最近原生活动</dt><dd>{progress ? `${date(progress.lastEventAt)} · ${currentRead && progress.freshness === "live" ? "记录于" : "上次记录于"} ${date(progress.observedAt)}` : "未读到活动时间"}</dd></div>
      <div><dt>持久普通消息</dt><dd>{messageSummary}</dd></div></dl>
    <p>{executionSourceNote(progress, currentRead, messageState)}{messageId && <> 原消息 <code>{messageId}</code>。</>}</p>
  </section>;
}
