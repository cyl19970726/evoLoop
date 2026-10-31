import { useEffect, useState } from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { ArrowRight } from "lucide-react";
import { api, errorText } from "../api";
import { href } from "../ui/shared";
import { acceptancePoints } from "./acceptancePresentation";
import { DeliveryArtifact, useDeliveryNames } from "./DeliveryPanel";
import { leaderPhaseLabel } from "./leaderWorkLoad";
import { observationResultLabel, observationsForDelivery, observerKindLabel } from "./observationPresentation";
import { currentDelivery, matchingProjection, matchingTaskDetail } from "./taskExperience";
import { taskGoal, taskType } from "./taskWorkspacePresentation";

const empty: NonNullable<TaskDetail["deliveries"]> = [];

export function TaskPreview({ token, projectId, id, item, returnTo, sessionName, roleName, outsideFilter = false }: {
  token: string; projectId: string; id: string; item?: LeaderWorkTask; actorId: string; returnTo: string;
  sessionName?: string | null; roleName?: string | null; outsideFilter?: boolean;
}) {
  const [read, setRead] = useState<{ projectId: string; taskId: string; detail: TaskDetail | null; problem: string } | null>(null);
  const selectedRead = read?.projectId === projectId && read.taskId === id ? read : null;
  const detail = matchingTaskDetail(selectedRead?.detail ?? null, projectId, id);
  const problem = selectedRead?.problem ?? "";
  useEffect(() => {
    let active = true;
    setRead(null);
    api(token).task(projectId, id).then(value => {
      if (!matchingTaskDetail(value, projectId, id)) throw new Error("任务摘要响应与所选项目、任务不符");
      if (active) setRead({ projectId, taskId: id, detail: value, problem: "" });
    }).catch(cause => {
      if (active) setRead({ projectId, taskId: id, detail: null, problem: errorText(cause) });
    });
    return () => { active = false; };
  }, [token, projectId, id, item?.workChangeSequence]);

  const names = useDeliveryNames(token, projectId, detail?.deliveries ?? empty);
  const latest = detail && currentDelivery(detail);
  const latestObservations = latest ? observationsForDelivery(detail.observations ?? [], latest.id) : [];
  const projection = detail ? matchingProjection(detail.task, item) : undefined;
  const acceptance = detail ? acceptancePoints(detail.task.acceptance) : null;
  const visibleAcceptance = acceptance?.slice(0, 2) ?? [];
  const hiddenAcceptance = acceptance?.slice(2) ?? [];
  const fullHref = `${href(projectId, "task", id)}?list=${encodeURIComponent(returnTo)}`;
  const responsibility = projection?.assignment
    ? `${projection.assignment.targetKind === "owned" ? "受管 Session" : "外部 HostLink"} · ${sessionName || "名称待核对"}`
    : projection?.responsible.kind === "role"
      ? `负责职责 · ${roleName || "名称待核对"}`
      : projection?.responsible.label ?? "承接尚未读回";

  return <aside className="task-selection task-summary" aria-label="所选任务摘要">
    <div className="task-selection-top">
      <span>{outsideFilter ? "保留所选任务 · 不在当前筛选结果中" : "所选任务"}</span>
      <a className="task-selection-full primary" href={fullHref}>查看完整任务 <ArrowRight size={15} /></a>
    </div>
    {problem ? <p role="alert">摘要读取失败：{problem}。<a href={fullHref}>打开任务重读</a></p> : !detail ? <p role="status">正在读取任务摘要…</p> : <>
      <header className="task-selection-header">
        <p className="summary-type">{taskType(detail.task.kind)}{projection ? ` · ${leaderPhaseLabel[projection.phase]}` : ""}</p>
        <h2>{detail.task.title}</h2>
        <p className="task-summary-goal">{taskGoal(projection, detail.task)}</p>
      </header>

      <section className="task-summary-current" aria-label="当前进展与下一责任">
        <div><span>当前进展</span><strong>{projection ? leaderPhaseLabel[projection.phase] : "工作安排尚未读回"}</strong></div>
        <div><span>下一责任</span><strong>{projection?.nextAction ?? "打开完整任务核对当前工作安排"}</strong><small>{responsibility}</small></div>
      </section>

      <section className="task-summary-section task-summary-acceptance">
        <h3>完成条件</h3>
        {visibleAcceptance.length ? <ol className="task-acceptance-points">{visibleAcceptance.map((point, index) => <li key={index}>{point}</li>)}</ol>
          : acceptance === null ? <p>{detail.task.acceptance}</p> : <p>没有可分段展示的完成条件。</p>}
        {hiddenAcceptance.length > 0 && <details><summary>其余 {hiddenAcceptance.length} 条完成条件</summary><ol start={3}>{hiddenAcceptance.map((point, index) => <li key={index}>{point}</li>)}</ol></details>}
      </section>

      <section className="task-summary-section task-summary-result">
        <h3>固定成果</h3>
        {latest ? <>
          <DeliveryArtifact delivery={latest} projectId={projectId} name={names[latest.id]} />
          <p><strong>技术检查{latest.technicalResult === "passed" ? "通过" : "失败"}</strong><small>登记于本次固定交付</small></p>
          <p><strong>实际使用范围</strong><small>{latestObservations.length
            ? latestObservations.map(observation => `${observerKindLabel[observation.observerKind]} · ${observationResultLabel[observation.result]} · ${observation.observer}`).join("；")
            : "尚无本次交付的使用观察；历史记录不沿用"}</small></p>
        </> : <p className="task-summary-empty">当前任务修订尚无固定交付。执行状态不能代替成果。</p>}
      </section>

      <div className="task-summary-evidence-links">
        <a href={`${fullHref}&tab=basis`}>来源与修订 <ArrowRight size={14} /></a>
        <a href={`${fullHref}&tab=delivery`}>交付与使用 <ArrowRight size={14} /></a>
      </div>
    </>}
  </aside>;
}
