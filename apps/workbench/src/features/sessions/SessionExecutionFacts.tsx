// 执行与消息状态 (right column): the native report on the current round, the time of its latest event, and the saved
// ordinary message it started from. Neither source settles the other; a failed or missing read says so.
import { useEffect, useRef } from "react";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { useProjectQuery } from "../../shared/query";
import { sessionClient } from "../../shared/sessionClient";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { FactList, PanelSection, mutedText } from "../../shared/ui/PageParts";
import { date } from "../../shared/ui/shared";
import type { NativeProgressView } from "./NativeSessionPanel";
import { executionSourceNote, messageStateLabel, nativeExecutionLabel } from "./executionStatusPresentation";

const states = new Set(["queued", "processing", "replied", "completed_without_reply", "failed", "unknown", "cancelled", "manual_pending"]);
class Mismatch extends Error {}

export function SessionExecutionFacts({ projectId, sessionId, progress, currentRead, refreshKey }: {
  /** Kept for callers; reads use the signed-in identity. */
  token?: string;
  projectId: string; sessionId: string; progress: NativeProgressView | null;
  currentRead: boolean; refreshKey: string;
}) {
  const messageId = progress?.turn?.source?.kind === "message" ? progress.turn.source.id : null;
  const processingId = progress?.turn?.source?.kind === "message" ? progress.turn.source.processingId : null;
  const read = useProjectQuery(projectId, ["session-messages", messageId, processingId, sessionId], async signal => {
    const value = await sessionClient("", projectId).message(messageId!, signal);
    const message = value.message;
    const processing = value.processing;
    if (message.id !== messageId || message.projectId !== projectId || !states.has(message.state) ||
      !Number.isFinite(Date.parse(message.updatedAt)) || message.target.kind !== "owned" ||
      message.target.sessionId !== sessionId || processing && (processing.messageId !== messageId ||
        processing.projectId !== projectId || processing.sessionId !== sessionId || processing.id !== processingId) ||
      processingId && !processing) throw new Mismatch("消息来源与当前智能体不符");
    return message as SessionMessageRecord;
  }, { enabled: !!messageId && currentRead });
  // Each workspace reread asks again once the workspace itself is read back; the answer on screen stays until then.
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (!messageId || !currentRead || lastRefresh.current === refreshKey) return;
    lastRefresh.current = refreshKey;
    void read.refetch();
  }, [refreshKey, currentRead]);
  const message = currentRead && !read.isError ? read.data ?? null : null;
  const failure = read.error instanceof Mismatch ? `${read.error.message}，状态未知` : "消息记录暂不可读取，状态未知";
  const messageSummary = !messageId ? "这一轮没有关联普通消息" : !currentRead ? "当前读取未确认，消息状态待核对"
    : read.isError ? `${failure}${read.data ? `；上次读回：${messageStateLabel(read.data.state)}` : ""}`
      : message ? `${messageStateLabel(message.state)} · 更新于 ${date(message.updatedAt)}` : "正在读取原消息状态…";
  return <PanelSection title="执行与消息状态">
    <FactList rows={[
      ["原生执行状态", nativeExecutionLabel(progress, currentRead)],
      ["最近原生活动", progress ? `${date(progress.lastEventAt)} · ${currentRead && progress.freshness === "live" ? "记录于" : "上次记录于"} ${date(progress.observedAt)}` : "未读到活动时间"],
      ["保存的普通消息", messageSummary],
    ]} />
    <p className={mutedText}>{executionSourceNote(progress, currentRead, message?.state ?? null)}</p>
    <FullIdentifiers rows={[{ label: "原消息", value: messageId }, { label: "消息处理记录", value: processingId }]} />
  </PanelSection>;
}
