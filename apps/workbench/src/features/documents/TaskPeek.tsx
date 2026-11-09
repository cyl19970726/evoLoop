// A task that references the open document, opened beside it in the right column. It reads the task's current
// state; the full task opens in the center from the column's "在中间打开".
import type { DocumentTaskReference } from "@evoloop/contracts";
import { ErrorState, LoadingState, StatusTag } from "@evoloop/ui";
import { api } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { href } from "../../shared/routes";
import { taskStateLabel, taskStateTone, referenceText } from "./documentPresentation";
import { OwnerName } from "./OwnerName";
import { readProblem } from "./useDocumentList";

export function TaskPeek({ projectId, reference, documentTitle }: { projectId: string; reference: DocumentTaskReference; documentTitle: string }) {
  const task = useProjectQuery(projectId, ["task", reference.id, "peek"], () => api().task(projectId, reference.id));
  const current = task.data?.task;
  const state = current?.state ?? reference.state;
  return <article data-ui="" className="flex flex-col gap-3">
    <header className="flex flex-col gap-1.5">
      <h3 className="text-body font-semibold leading-[1.4] [overflow-wrap:anywhere]">{current?.title ?? reference.title}</h3>
      <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        <StatusTag tone={taskStateTone[state]} label={taskStateLabel[state]} />
        <span>责任者 <OwnerName projectId={projectId} owner={current?.owner ?? reference.owner} /></span>
      </div>
    </header>
    <p className="rounded-md bg-muted px-3 py-2 text-label text-text-secondary">
      这项任务把《{documentTitle}》作为{referenceText(reference.relations)}。</p>
    {task.isPending && <LoadingState lines={3} label="正在读取任务" />}
    {task.isError && <ErrorState title="任务没有读回" happened={readProblem(task.error, "这项任务")} next="可以在中间打开任务再看。" />}
    {current && <div className="flex flex-col gap-2 text-label">
      <p><span className="block text-caption text-muted-foreground">完成条件</span><span className="mt-0.5 block whitespace-pre-wrap [overflow-wrap:anywhere]">{current.acceptance || "未写明"}</span></p>
      <p><span className="block text-caption text-muted-foreground">当前版本</span><span className="mt-0.5 block">第 {current.version} 版</span></p>
    </div>}
    <a href={href(projectId, "task", reference.id)} className="text-label font-medium text-primary hover:underline">打开完整任务 →</a>
  </article>;
}
