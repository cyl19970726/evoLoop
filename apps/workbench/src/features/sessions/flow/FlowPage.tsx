// 统筹安排 › 动态, on real data (DEC-045 F1, second segment): the work board snapshot, the event window and the stream, drawn by FlowView.
// The Leader's Session comes from the page that hosts it (the agent directory); everything else is read here. Loaded as its own chunk.
import { useMemo } from "react";
import { Button, ErrorState, LoadingState } from "@evoloop/ui";
import type { SchedEvent } from "@evoloop/contracts/work-board";
import { FlowView } from "./FlowView";
import { openInfoOf } from "./flowOpen";
import { learnContext } from "./flowModel";
import { useFlowData } from "./useFlowData";

/** The real objects an event opens. A Task, a delivery, a run, an arrangement and an observation are all read on their Task; a message, on its Session. */
export function openTargetsOf(projectId: string, event: SchedEvent): Array<{ label: string; href: string }> { return openInfoOf(projectId, event).targets; }

export function FlowPage({ token, projectId, leaderSessionId, active = true }: { token: string; projectId: string; leaderSessionId: string | null; active?: boolean }) {
  // Subscribed only while this component is mounted: leaving the tab or the page unmounts it and the stream is closed.
  const data = useFlowData(token, projectId, active);
  const context = useMemo(() => learnContext({ sessionIds: new Set((data.board?.sessions ?? []).map(s => s.sessionId)), leaderSessionId }, data.events), [data.board, data.events, leaderSessionId]);
  if (!data.board) {
    return data.connection === "failed"
      ? <ErrorState title="动态读不到" happened={data.error || "读取调度板快照或事件失败"} next="服务可能正在重启；这里会自动重试，也可以手动重试。" action={<Button onClick={data.reload}>重试</Button>} />
      : <LoadingState label="正在读取调度板快照与事件" lines={4} />;
  }
  return <FlowView board={data.board} events={data.events} context={context} source="live"
    connection={{ state: data.connection, error: data.error, lastSeq: data.lastSeq, reconnects: data.reconnects }}
    windowNote={`近 ${data.windowHours} 小时${data.truncated ? "（窗口内事件太多，最早的一部分没有读）" : ""}`}
    windowHours={data.windowHours} openInfo={event => openInfoOf(projectId, event)} />;
}
