import { useEffect, useState } from "react";
import type { TaskRevision } from "@evoloop/contracts";
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import { api, errorText, request } from "../api";
import { ShortId, href } from "../ui/shared";
import { taskSectionHref } from "../orchestration/navigation";
import { type DocumentOrigin as Origin, verifiedOriginRun, verifiedOriginTask } from "./originValidation";

interface OriginReadback {
  scope: string; refreshKey: string;
  task: TaskRevision | null; taskProblem: string | null;
  run: RuntimeRunRecord | null; runProblem: string | null;
  runObservedAt: Date | null; runReading: boolean; runStale: boolean;
}
const runStateLabel: Record<string, string> = { requested: "待派发", dispatching: "派发中", running: "运行中", completed: "运行结束", failed: "运行失败", interrupted: "已中断", unknown: "结果未知" };

export function DocumentOrigin({ token, projectId, documentId, revisionId, refreshKey, origin }: {
  token: string; projectId: string; documentId: string; revisionId: string; refreshKey: string; origin: Origin;
}) {
  const [readback, setReadback] = useState<OriginReadback | null>(null);
  const scope = JSON.stringify([token,projectId,documentId,revisionId,origin.taskId,origin.taskRevisionId,origin.runId]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setReadback(previous => previous?.scope === scope ? { ...previous, refreshKey, runReading: !!origin.runId,
      runStale: !!previous.run, runProblem: null } : { scope, refreshKey, task:null, taskProblem:null,
      run:null, runProblem:null, runObservedAt:null, runReading:!!origin.runId, runStale:false });
    void api(token).taskRevision(projectId, origin.taskId, origin.taskRevisionId).then(value => {
      if (!active) return;
      const task = verifiedOriginTask(projectId, origin, value.revision);
      setReadback(previous => previous?.scope === scope && previous.refreshKey === refreshKey ? {
        ...previous, task:task ?? previous.task,
        taskProblem:task ? null : "回读对象与登记的固定任务修订不一致",
      } : previous);
    }).catch(cause => { if (active) setReadback(previous => previous?.scope === scope && previous.refreshKey === refreshKey ? {
      ...previous, taskProblem:errorText(cause),
    } : previous); });
    if (origin.runId) void request<RuntimeRunRecord>(token,
      `/api/projects/${encodeURIComponent(projectId)}/runtime/runs/${encodeURIComponent(origin.runId)}`,15000,
      { signal:controller.signal }).then(value => {
      if (!active) return;
      const run = verifiedOriginRun(projectId, origin, value);
      setReadback(previous => previous?.scope === scope && previous.refreshKey === refreshKey ? {
        ...previous, run:run ?? previous.run, runProblem:run ? null : "回读 Run 与登记的固定任务修订不一致",
        runObservedAt:run ? new Date() : previous.runObservedAt, runReading:false, runStale:!run && !!previous.run,
      } : previous);
    }).catch(cause => { if (active) setReadback(previous => previous?.scope === scope && previous.refreshKey === refreshKey ? {
      ...previous, runProblem:errorText(cause), runReading:false, runStale:!!previous.run,
    } : previous); });
    return () => { active = false; controller.abort(); };
  },[token,projectId,documentId,revisionId,refreshKey,origin.taskId,origin.taskRevisionId,origin.runId,scope]);
  const current = readback?.scope === scope ? readback : null;
  const staleRun = !!current?.run && (current.runStale || current.refreshKey !== refreshKey);
  return <section className="doc-origin" aria-label="正式来源">
    <h2>正式来源</h2>
    <p>此文档创建时登记了下列来源，当前阅读的文档修订仍单独保留。来源记录不代表问题已修复、交付已验收或有人实际使用。</p>
    <a className="doc-origin-task" href={href(projectId,"task",origin.taskId,origin.taskRevisionId)}>
      {current?.task ? <>{current.task.title} · v{current.task.version}</> : "阅读来源任务固定修订"} <ShortId value={origin.taskRevisionId} /> →
    </a>
    {!current && <p className="muted">正在核对固定来源名称与运行归属…</p>}
    {current?.taskProblem && <p className="doc-origin-limit">来源任务名称暂不可核实：{current.taskProblem}。上方链接仍指向登记的固定修订，不以任务当前版替代。</p>}
    {origin.runId && current?.run && <details className="doc-origin-run"><summary>阅读来源 Run <ShortId value={origin.runId} /> · {runStateLabel[current.run.state] ?? current.run.state}{staleRun ? "（上次读回，当前待核对）" : ""}</summary>
      <p>此 Run 回读的任务与执行修订均与上方来源一致。运行状态不表示问题已经修复。</p>
      <p>运行 ID <code>{current.run.id}</code> · 执行任务修订 <code>{current.run.taskRevisionId}</code></p>
      <p>输入 SHA-256 <code>{current.run.inputHash}</code></p>
      <a href={taskSectionHref(projectId,origin.taskId,{tab:"runtime"})}>在所属任务的运行记录中继续核对 →</a>
    </details>}
    {origin.runId && current?.run && <p className="muted">来源 Run {staleRun ? "上次读于" : "读于"} {current.runObservedAt?.toLocaleString("zh-CN") ?? "时间未记录"}。{staleRun && (current.runReading || current.refreshKey !== refreshKey) ? "正在重新核对当前状态。" : ""}</p>}
    {origin.runId && current?.runProblem && <p className="doc-origin-limit">{current.run ? `来源 Run 本次回读失败：${current.runProblem}。上次状态仅供核对，不能视为当前状态。` : `登记的来源 Run 尚不能确认为该固定任务修订：${current.runProblem}。此处不提供未经核实的运行入口。`}</p>}
    <details className="doc-origin-ids"><summary>核对完整来源标识</summary><p>Task <code>{origin.taskId}</code> · 固定修订 <code>{origin.taskRevisionId}</code>{origin.runId && <> · 登记 Run <code>{origin.runId}</code></>}</p></details>
  </section>;
}
