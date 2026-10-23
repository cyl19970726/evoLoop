import { useEffect, useState } from "react";
import type { TaskRevision } from "@evoloop/contracts";
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import { api, errorText, request } from "../api";
import { ShortId, href } from "../ui/shared";
import { taskSectionHref } from "../orchestration/navigation";
import { type DocumentOrigin as Origin, verifiedOriginRun, verifiedOriginTask } from "./originValidation";

interface OriginReadback {
  task: TaskRevision | null; taskProblem: string | null;
  run: RuntimeRunRecord | null; runProblem: string | null;
}
const runStateLabel: Record<string, string> = { requested: "待派发", dispatching: "派发中", running: "运行中", completed: "运行结束", failed: "运行失败", interrupted: "已中断", unknown: "结果未知" };

export function DocumentOrigin({ token, projectId, origin }: { token: string; projectId: string; origin: Origin }) {
  const [readback, setReadback] = useState<OriginReadback | null>(null);
  useEffect(() => {
    let active = true;
    setReadback(null);
    const task = api(token).taskRevision(projectId, origin.taskId, origin.taskRevisionId);
    const run = origin.runId ? request<RuntimeRunRecord>(token,
      `/api/projects/${encodeURIComponent(projectId)}/runtime/runs/${encodeURIComponent(origin.runId)}`,15000) : Promise.resolve(null);
    void Promise.allSettled([task,run]).then(([taskResult,runResult]) => {
      if (!active) return;
      const verifiedTask = taskResult.status === "fulfilled" ? verifiedOriginTask(projectId,origin,taskResult.value.revision) : null;
      const verifiedRun = runResult.status === "fulfilled" && runResult.value ? verifiedOriginRun(projectId,origin,runResult.value) : null;
      setReadback({task:verifiedTask,
        taskProblem:taskResult.status === "rejected" ? errorText(taskResult.reason) : verifiedTask ? null : "回读对象与登记的固定任务修订不一致",
        run:verifiedRun,
        runProblem:!origin.runId ? null : runResult.status === "rejected" ? errorText(runResult.reason) : verifiedRun ? null : "回读 Run 与登记的固定任务修订不一致"});
    });
    return () => { active = false; };
  },[token,projectId,origin.taskId,origin.taskRevisionId,origin.runId]);
  return <section className="doc-origin" aria-label="正式来源">
    <h2>正式来源</h2>
    <p>此文档创建时登记了下列来源，当前阅读的文档修订仍单独保留。来源记录不代表问题已修复、交付已验收或有人实际使用。</p>
    <a className="doc-origin-task" href={href(projectId,"task",origin.taskId,origin.taskRevisionId)}>
      {readback?.task ? <>{readback.task.title} · v{readback.task.version}</> : "阅读来源任务固定修订"} <ShortId value={origin.taskRevisionId} /> →
    </a>
    {!readback && <p className="muted">正在核对固定来源名称与运行归属…</p>}
    {readback?.taskProblem && <p className="doc-origin-limit">来源任务名称暂不可核实：{readback.taskProblem}。上方链接仍指向登记的固定修订，不以任务当前版替代。</p>}
    {origin.runId && readback?.run && <details className="doc-origin-run"><summary>阅读来源 Run <ShortId value={origin.runId} /> · {runStateLabel[readback.run.state] ?? readback.run.state}</summary>
      <p>此 Run 回读的任务与执行修订均与上方来源一致。运行状态不表示问题已经修复。</p>
      <p>运行 ID <code>{readback.run.id}</code> · 执行任务修订 <code>{readback.run.taskRevisionId}</code></p>
      <p>输入 SHA-256 <code>{readback.run.inputHash}</code></p>
      <a href={taskSectionHref(projectId,origin.taskId,{tab:"runtime"})}>在所属任务的运行记录中继续核对 →</a>
    </details>}
    {origin.runId && readback?.runProblem && <p className="doc-origin-limit">登记的来源 Run 尚不能确认为该固定任务修订：{readback.runProblem}。此处不提供未经核实的运行入口。</p>}
    <details className="doc-origin-ids"><summary>核对完整来源标识</summary><p>Task <code>{origin.taskId}</code> · 固定修订 <code>{origin.taskRevisionId}</code>{origin.runId && <> · 登记 Run <code>{origin.runId}</code></>}</p></details>
  </section>;
}
