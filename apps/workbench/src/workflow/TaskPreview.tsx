import { useEffect, useState } from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { ArrowRight, CheckCircle2, Clock3, TriangleAlert, X } from "lucide-react";
import { api, errorText } from "../api";
import { href } from "../ui/shared";
import { TaskCurrentWork } from "./TaskCurrentWork";
import { currentDelivery, matchingProjection, matchingTaskDetail } from "./taskExperience";
import { DeliveryArtifact, useDeliveryNames } from "./DeliveryPanel";
import { observationResultLabel, observationsForDelivery, observerKindLabel } from "./observationPresentation";

const empty: NonNullable<TaskDetail["deliveries"]> = [];
export function TaskPreview({ token, projectId, id, item, actorId, returnTo, onClose }: {
  token: string; projectId: string; id: string; item?: LeaderWorkTask; actorId: string; returnTo: string; onClose: () => void;
}) {
  const [read, setRead] = useState<{ projectId: string; taskId: string; detail: TaskDetail | null; problem: string } | null>(null);
  const selectedRead = read?.projectId === projectId && read.taskId === id ? read : null;
  const detail = matchingTaskDetail(selectedRead?.detail ?? null, projectId, id);
  const problem = selectedRead?.problem ?? "";
  useEffect(() => {
    let active = true; setRead(null);
    api(token).task(projectId, id).then(value => {
      if (!matchingTaskDetail(value, projectId, id)) throw new Error("任务摘要响应与所选项目、任务不符");
      if (active) setRead({ projectId, taskId: id, detail: value, problem: "" });
    }).catch(cause => { if (active) setRead({ projectId, taskId: id, detail: null, problem: errorText(cause) }); });
    return () => { active = false; };
  }, [token, projectId, id, item?.workChangeSequence]);
  const names = useDeliveryNames(token, projectId, detail?.deliveries ?? empty);
  const latest = detail && currentDelivery(detail);
  const latestObservations = latest ? observationsForDelivery(detail.observations ?? [], latest.id) : [];
  const projection = detail ? matchingProjection(detail.task, item) : undefined;
  const fullHref = `${href(projectId, "task", id)}?list=${encodeURIComponent(returnTo)}`;
  return <aside className="task-selection" aria-label="所选任务摘要">
    <div className="task-selection-top"><span>当前所选{detail ? ` · 任务 v${detail.task.version}` : ""}</span><button className="quiet" aria-label="关闭任务摘要" onClick={onClose}><X size={17} /></button></div>
    {problem ? <p role="alert">摘要读取失败：{problem}。<a href={fullHref}>打开任务重读</a></p> : !detail ? <p role="status">正在读取任务摘要…</p> : <>
      <header className="task-selection-header">
        <h2>{detail.task.title}</h2>
        <a className="task-selection-full primary" href={fullHref}>查看完整任务 <ArrowRight size={15} /></a>
      </header>
      <div className="task-selection-body">
        <div className="task-selection-primary">
          {projection ? <TaskCurrentWork item={projection} token={token} projectId={projectId} actorId={actorId} returnTo={returnTo} /> : <p>当前工作安排尚未读回；请打开完整任务核对。</p>}
          <details className="task-reader-acceptance"><summary>完成条件</summary><p>{detail.task.acceptance}</p></details>
          <a className="task-reader-basis" href={`${fullHref}&tab=basis`}>来源与修订 →</a>
        </div>
        <section className="task-reader-evidence"><h3>当前固定成果</h3>{latest ? <>
          <DeliveryArtifact delivery={latest} projectId={projectId} name={names[latest.id]} />
          <div className="task-outcome-list">
            <div className={`task-outcome-row ${latest.technicalResult === "passed" ? "is-passed" : "is-failed"}`}>
              {latest.technicalResult === "passed" ? <CheckCircle2 size={18} aria-hidden="true" /> : <TriangleAlert size={18} aria-hidden="true" />}
              <span><strong>技术检查{latest.technicalResult === "passed" ? "通过" : "失败"}</strong><small>登记于本次固定交付</small></span>
            </div>
            {latestObservations.length ? latestObservations.map(observation => <div className={`task-outcome-row ${observation.result === "used" ? "is-passed" : observation.result === "failed" ? "is-failed" : "is-neutral"}`} key={observation.id}>
              {observation.result === "used" ? <CheckCircle2 size={18} aria-hidden="true" /> : observation.result === "failed" ? <TriangleAlert size={18} aria-hidden="true" /> : <Clock3 size={18} aria-hidden="true" />}
              <span><strong>{observerKindLabel[observation.observerKind]} · {observationResultLabel[observation.result]}</strong><small>{observation.observer}</small></span>
            </div>) : <div className="task-outcome-row is-neutral"><Clock3 size={18} aria-hidden="true" /><span><strong>尚无本次使用观察</strong><small>历史交付的使用记录不沿用</small></span></div>}
          </div>
        </> : <p>当前任务修订尚无交付，历史成果可在完整任务中查看。</p>}</section>
      </div>
    </>}
  </aside>;
}
