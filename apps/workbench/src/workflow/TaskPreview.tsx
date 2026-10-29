import { useEffect, useState } from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { ArrowRight, X } from "lucide-react";
import { api, errorText } from "../api";
import { href } from "../ui/shared";
import { TaskCurrentWork } from "./TaskCurrentWork";
import { currentDelivery, matchingProjection } from "./taskExperience";
import { DeliveryArtifact, useDeliveryNames } from "./DeliveryPanel";

const empty: NonNullable<TaskDetail["deliveries"]> = [];
export function TaskPreview({ token, projectId, id, item, actorId, returnTo, onClose }: {
  token: string; projectId: string; id: string; item?: LeaderWorkTask; actorId: string; returnTo: string; onClose: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null), [problem, setProblem] = useState("");
  useEffect(() => {
    let active = true; setDetail(null); setProblem("");
    api(token).task(projectId, id).then(value => { if (active) setDetail(value); }).catch(cause => { if (active) setProblem(errorText(cause)); });
    return () => { active = false; };
  }, [token, projectId, id, item?.workChangeSequence]);
  const names = useDeliveryNames(token, projectId, detail?.deliveries ?? empty);
  const latest = detail && currentDelivery(detail);
  const projection = detail ? matchingProjection(detail.task, item) : undefined;
  const fullHref = `${href(projectId, "task", id)}?list=${encodeURIComponent(returnTo)}`;
  return <aside className="task-selection" aria-label="所选任务摘要">
    <div className="task-selection-top"><span>任务{detail ? ` · v${detail.task.version}` : ""}</span><button className="quiet" aria-label="关闭任务摘要" onClick={onClose}><X size={17} /></button></div>
    {problem ? <p role="alert">摘要读取失败：{problem}。<a href={fullHref}>打开任务重读</a></p> : !detail ? <p role="status">正在读取任务摘要…</p> : <>
      <h2>{detail.task.title}</h2><a className="task-selection-full" href={fullHref}>查看完整任务 <ArrowRight size={15} /></a>
      {projection ? <TaskCurrentWork item={projection} token={token} projectId={projectId} actorId={actorId} returnTo={returnTo} /> : <p>当前工作安排尚未读回；请打开完整任务核对。</p>}
      <section><h3>完成条件</h3><p>{detail.task.acceptance}</p></section>
      <section><h3>当前固定成果</h3>{latest ? <DeliveryArtifact delivery={latest} projectId={projectId} name={names[latest.id]} /> : <p>当前任务修订尚无交付，历史成果可在完整任务中查看。</p>}</section>
      <a href={`${fullHref}&tab=basis`}>依据与验收 →</a>
    </>}
  </aside>;
}
