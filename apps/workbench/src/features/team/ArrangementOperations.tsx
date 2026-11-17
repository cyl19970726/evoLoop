// 编排与队列 on 统筹安排 (Task 0f8c7a15): the automatic loops and the execution queues are arrangement, so they are shown here and nowhere else;
// 运行与接入 (features/runtime) only carries the execution service, the managed agents and the runs. It reads the same runtime lists under the same
// query keys, so a page that has them cached reuses them.
import { useContext } from "react";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { runtimeClient } from "../../shared/runtimeClient";
import { PageActive } from "../../shared/ui/ContextPanel";
import { PageSection } from "../../shared/ui/PageParts";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { OrchestrationPanel } from "../orchestration";
import { ResidentQueuePanel } from "../workflow";

export function ArrangementOperations({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { projectId } = context;
  const active = useContext(PageActive);
  const poll = { refetchInterval: active ? 5000 : false as const };
  const sessionsRead = useProjectQuery(projectId, ["runtime", "sessions"], async () => {
    const items = await runtimeClient("", projectId).sessions();
    if (!Array.isArray(items)) throw new Error("智能体列表响应不完整");
    return items.filter(item => item.projectId === projectId);
  }, poll);
  const runsRead = useProjectQuery(projectId, ["runtime", "runs"], async () => {
    const items = await runtimeClient("", projectId).runs();
    if (!Array.isArray(items)) throw new Error("运行列表响应不完整");
    return items.filter(item => item.projectId === projectId);
  }, poll);
  const sessions: RuntimeSessionRecord[] = sessionsRead.data ?? [];
  const runs: RuntimeRunRecord[] = runsRead.data ?? [];
  const runsCurrent = !!runsRead.data && !runsRead.error;
  return <PageSection title="编排与队列" description="自动循环的派发与实际运行，以及执行队列的顺序与暂停。执行服务、连接和恢复在“运行与接入”。">
    <SectionBoundary label="编排"><OrchestrationPanel key={`${projectId}:${context.principal.actorId}`} projectId={projectId} refresh={refresh} verifiedRuns={runsCurrent ? runs : null} /></SectionBoundary>
    <SectionBoundary label="队列"><ResidentQueuePanel context={context} runs={runs} sessions={sessions} /></SectionBoundary>
  </PageSection>;
}
