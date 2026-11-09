// 来源 in the right column: the task revision (and run) registered when the document was created. Each is read
// back and shown only when it matches the registered fixed revision. A reread keeps the last answer and says it is
// being checked; a failed reread keeps it marked as the last read, never as the current state.
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import { api, request } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { href } from "../../shared/routes";
import { taskSectionHref } from "../../shared/taskNavigation";
import { type DocumentOrigin as Origin, verifiedOriginRun, verifiedOriginTask } from "./originValidation";
import { runStateLabel } from "./documentPresentation";
import { readProblem } from "./useDocumentList";

export function DocumentOrigin({ projectId, documentId, origin }: { projectId: string; documentId: string; origin: Origin }) {
  const task = useProjectQuery(projectId, ["document", documentId, "origin-task", origin.taskId, origin.taskRevisionId], async () => {
    const value = await api().taskRevision(projectId, origin.taskId, origin.taskRevisionId);
    const verified = verifiedOriginTask(projectId, origin, value.revision);
    if (!verified) throw new Error("读回的任务与登记的固定修订不一致");
    return verified;
  });
  const run = useProjectQuery(projectId, ["document", documentId, "origin-run", origin.runId, origin.taskId, origin.taskRevisionId], async signal => {
    const value = await request<RuntimeRunRecord>("", `/api/projects/${encodeURIComponent(projectId)}/runtime/runs/${encodeURIComponent(origin.runId!)}`, 15000, { signal });
    const verified = verifiedOriginRun(projectId, origin, value);
    if (!verified) throw new Error("读回的运行与登记的固定任务修订不一致");
    return verified;
  }, { enabled: !!origin.runId });
  const runData = run.data;
  const staleRun = !!runData && (run.isFetching || run.isError);
  return <div className="flex flex-col gap-2 text-label text-text-secondary">
    <p>创建这份文档时登记的来源。来源记录不代表问题已修复、交付已验收或有人用过。</p>
    <a href={href(projectId, "task", origin.taskId, origin.taskRevisionId)} className="font-medium text-primary [overflow-wrap:anywhere] hover:underline">
      {task.data ? `${task.data.title} · 第 ${task.data.version} 版` : "来源任务的固定版本"} →</a>
    {task.isPending && <p className="text-caption text-muted-foreground">正在核对来源任务…</p>}
    {task.isError && <p className="text-caption text-warning">来源任务名称暂不能核实：{readProblem(task.error, "来源任务")}。链接仍指向登记的固定版本，不用任务当前版代替。</p>}
    {origin.runId && <details className="group rounded-md bg-muted px-3 py-2" data-origin-run="">
      <summary className="cursor-pointer text-label text-foreground">
        来源运行 <code title={origin.runId} className="font-mono text-caption">{origin.runId.slice(0, 8)}</code>
        {runData ? ` · ${runStateLabel[runData.state] ?? runData.state}` : run.isPending ? " · 正在核对" : " · 未能核实"}
        {staleRun ? "（上次读回，当前待核对）" : ""}
      </summary>
      {runData && <div className="mt-2 flex flex-col gap-1 text-caption">
        <p>这次运行读回的任务和执行版本与上面的来源一致。运行状态不表示问题已经修复。</p>
        <p className="[overflow-wrap:anywhere]">运行 ID <code className="font-mono">{runData.id}</code></p>
        <p className="[overflow-wrap:anywhere]">执行的任务版本 <code className="font-mono">{runData.taskRevisionId}</code></p>
        <p className="[overflow-wrap:anywhere]">输入 SHA-256 <code className="font-mono">{runData.inputHash}</code></p>
        <a className="text-primary hover:underline" href={`${taskSectionHref(projectId, origin.taskId, { tab: "runtime" })}&run=${encodeURIComponent(runData.id)}`}>在所属任务核对这次运行 →</a>
      </div>}
    </details>}
    {origin.runId && runData && <p className="text-caption text-muted-foreground">
      来源运行{staleRun ? "上次读于" : "读于"} {new Date(run.dataUpdatedAt).toLocaleString("zh-CN")}。{run.isFetching ? "正在重新核对当前状态。" : ""}</p>}
    {origin.runId && run.isError && !run.isFetching && <p role="alert" className="text-caption text-warning">{runData
      ? `来源运行本次回读失败：${readProblem(run.error, "来源运行")}。上次状态只供核对，不能视为当前状态。`
      : `登记的来源运行还不能确认属于这个固定任务版本：${readProblem(run.error, "来源运行")}。这里不提供未经核实的运行入口。`}</p>}
    <details className="text-caption">
      <summary className="cursor-pointer text-muted-foreground">核对完整来源标识</summary>
      <p className="mt-1 [overflow-wrap:anywhere]">任务 <code className="font-mono">{origin.taskId}</code></p>
      <p className="[overflow-wrap:anywhere]">固定版本 <code className="font-mono">{origin.taskRevisionId}</code></p>
      {origin.runId && <p className="[overflow-wrap:anywhere]">登记的运行 <code className="font-mono">{origin.runId}</code></p>}
    </details>
  </div>;
}
