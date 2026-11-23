// The relation bar under a document's title (docs/frontend/pages/documents.md 关系条): 任务 · 阶段 · 来源 · 交付 · 依据, always these five.
// It reads nothing the page does not already read, except the owning task (the stage) and the task whose delivery this is (the
// acceptance word): at most two more requests, each failing on its own item ("读取失败") while the others stand.
import React from "react";
import type { DocumentDetail } from "@evoloop/contracts";
import { api } from "../../shared/api";
import { agentDisplayName } from "../../shared/agentNamePresentation";
import { readAgent } from "../../shared/agentRead";
import { useProjectQuery } from "../../shared/query";
import type { ReturnFrom } from "../../shared/returnLink";
import { withReturn } from "../../shared/returnLink";
import { taskSectionHref } from "../../shared/taskNavigation";
import { useContextPanel } from "../../shared/ui/ContextPanel";
import { RelationBar, cut, link, readFailed, unregistered } from "../../shared/ui/RelationBar";
import { stageHref } from "../../shared/ui/shared";
import { sessionHref } from "../sessions";
import { useOriginRun } from "./DocumentOrigin";
import { documentDelivery, taskItem } from "./documentRelationsModel";
import { taskLinkFrom } from "./taskLinks";
import { useReferencingTasks } from "./useReferencingTasks";

/** The right column's 引用它的任务 block: the bar's counts link to it. */
export const referencingTasksId = "document-referencing-tasks";

export function DocumentRelations({ projectId, detail, from }: { projectId: string; detail: DocumentDetail; from: ReturnFrom | null }) {
  const { document } = detail;
  const panel = useContextPanel();
  const references = useReferencingTasks(projectId, document.id);
  const tasks = references.data?.tasks;
  const primaryId = document.primaryTaskId ?? null;
  // The owning task's stage: one read of the work index's own judgment (not a second derivation of stage membership).
  const primary = useProjectQuery(projectId, ["document", document.id, "relation-primary", primaryId], () => api().leaderTask(projectId, primaryId!), { enabled: !!primaryId });
  const asDelivery = tasks?.find(task => task.relations.includes("delivery"));
  const delivery = useProjectQuery(projectId, ["document", document.id, "relation-delivery", asDelivery?.id], () => api().task(projectId, asDelivery!.id), { enabled: !!asDelivery });
  const origin = document.origin?.runId ? document.origin : null;
  const run = useOriginRun(projectId, document.id, origin);
  const key = run.data ? `owned:${run.data.sessionId}` : null;
  const agent = useProjectQuery(projectId, ["session-names", key], signal => readAgent(projectId, key!, signal), { enabled: !!key });

  const showReferences = (event: React.MouseEvent) => {
    event.preventDefault();
    panel?.setOpen(true);
    window.setTimeout(() => {
      const block = window.document.getElementById(referencingTasksId) as HTMLDetailsElement | null;
      if (!block) return;
      block.open = true;
      block.scrollIntoView({ block: "nearest" });
      block.querySelector("summary")?.focus();
    }, 0);
  };
  const toReferences = (text: string) => <a className={link} href={`#${referencingTasksId}`} onClick={showReferences}>{text}</a>;
  const deliveryTab = (taskId: string) => withReturn(taskSectionHref(projectId, taskId, { tab: "delivery" }), from);

  const listed = references.isError && !tasks ? readFailed : null;
  const kind = taskItem(primaryId, tasks ?? []);
  const task = primaryId
    ? <a className={link} href={taskLinkFrom(projectId, primaryId, from)}>{primary.data ? cut(primary.data.title) : tasks?.find(item => item.id === primaryId) ? cut(tasks.find(item => item.id === primaryId)!.title) : "所属任务"}</a>
    : listed ?? (!tasks ? "正在读取…" : kind.kind === "only" ? <a className={link} href={taskLinkFrom(projectId, kind.task.id, from)}>{cut(kind.task.title)}</a>
      : kind.kind === "many" ? toReferences(`被 ${kind.count} 项任务引用`) : unregistered);

  const own = primary.data;
  const stage = !primaryId ? unregistered
    : primary.isError && !own ? readFailed
      : !own ? "正在读取…"
        : own.stageOwnership?.state === "stage" && own.stage ? <a className={link} href={stageHref(projectId, own.stage.stageId)}>{own.stage.shortName}</a>
          : own.stageOwnership?.state === "none" ? "不属于阶段" : unregistered;

  const source = !origin ? unregistered
    : run.isError && !run.data ? readFailed
      : !run.data ? "正在读取…"
        : <><a className={link} href={sessionHref(projectId, key!, from)}>{agent.data ? agentDisplayName(agent.data) : agent.isError ? "智能体（名称暂不可读）" : "智能体（读取名称…）"}</a>写入</>;

  const delivered = asDelivery ? documentDelivery(delivery.data ?? { deliveries: [], observations: [] }, projectId, document.id) : null;
  const handed = listed ?? (!tasks ? "正在读取…" : !asDelivery ? "未作为交付提交"
    : <><a className={link} href={deliveryTab(asDelivery.id)}>{cut(asDelivery.title, 16)}的交付</a>
      {" · "}{delivery.isError ? readFailed : delivered ? delivered.word : "读取中…"}</>);

  const basis = tasks?.filter(item => item.relations.includes("basis")).length;
  const basisItem = listed ?? (basis === undefined ? "正在读取…" : basis > 0 ? toReferences(`被 ${basis} 项任务固定为依据`) : "没有任务固定它为依据");

  return <RelationBar kind="document" label="这份文档连着什么" items={[
    { id: "task", label: "任务", value: task }, { id: "stage", label: "阶段", value: stage }, { id: "source", label: "来源", value: source },
    { id: "delivery", label: "交付", value: handed }, { id: "basis", label: "依据", value: basisItem },
  ]} />;
}
