import { useEffect, useState } from "react";
import type { DocumentDetail, TaskDetail, TaskRevision } from "@evoloop/contracts";
import { api, errorText, safeArtifactHref } from "../api";
import { ActionForm, Notice, option, reasonField, type MutationContext } from "./ActionForm";
import { RevisionHistory } from "./RevisionHistory";

const stateLabel: Record<TaskRevision["state"], string> = {
  proposed: "待判断", ready: "可做", active: "进行中", review: "待验收", done: "已完成",
  blocked: "阻塞", deferred: "暂缓", cancelled: "已取消",
};

export function TaskWorkflow({ context, detail, mode = "actions" }: { context: MutationContext; detail: TaskDetail; mode?: "actions" | "delivery" | "history" }) {
  const task = detail.task;
  const [linked, setLinked] = useState<DocumentDetail[]>([]);
  const [revisions, setRevisions] = useState<TaskRevision[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "actions") return;
    let active = true;
    Promise.all(detail.links.map(link => api(context.token).document(context.projectId, link.documentId)))
      .then(items => { if (active) setLinked(items); }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, task.id, task.version, mode]);
  const base = { taskId: task.id, expectedVersion: task.version };
  const deliveries = detail.deliveries ?? [];
  const latest = deliveries[deliveries.length - 1];
  const proposal = detail.proposal;
  const latestStateDecision = revisions.filter((revision, index) => index > 0 && revision.state !== revisions[index - 1]?.state).at(-1);
  if (mode === "delivery") return <section className="panel task-records"><div className="panel-head"><h2>交付与使用记录</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
    {deliveries.length === 0 && <p className="empty">还没有交付；任务状态不代替产物和使用证据。</p>}
    {[...deliveries].reverse().map(delivery => <article className="decision" key={delivery.id}>
      <h3>{delivery.id === latest?.id ? "最新交付" : "历史交付"} · 技术{delivery.technicalResult === "passed" ? "通过" : "失败"}</h3>
      <p className="break-anywhere">产物：{safeArtifactHref(delivery.artifactRef, context.projectId)
        ? <a href={safeArtifactHref(delivery.artifactRef, context.projectId)!} target={(safeArtifactHref(delivery.artifactRef, context.projectId) ?? "").startsWith("#") ? undefined : "_blank"} rel={(safeArtifactHref(delivery.artifactRef, context.projectId) ?? "").startsWith("#") ? undefined : "noopener noreferrer"}>{delivery.artifactRef}</a>
        : delivery.artifactRef} · 固定修订 {delivery.artifactRevision}</p><p className="break-anywhere">SHA-256 {delivery.contentHash}</p>
      <p><strong>技术检查证据</strong><br />{delivery.technicalEvidence}</p>
      <p className="muted">产物链接只指向位置；固定修订、哈希与实际内容仍须独立核对。</p>
      <h3>这次交付的使用观察</h3>
      {(detail.observations ?? []).filter(observation => observation.deliveryId === delivery.id).length === 0 && <p className="empty">尚无这次交付的使用观察。</p>}
      {(detail.observations ?? []).filter(observation => observation.deliveryId === delivery.id).map(observation => <div className="history" key={observation.id}><strong>{observation.observer}（{observation.observerKind}） · {observation.result}</strong><p>{observation.evidence}</p><p>记录理由：{observation.reason}</p><small>登记者 {observation.actorId} · {observation.createdAt}</small></div>)}
    </article>)}
    {(detail.closures ?? []).map(closure => <article className="decision" key={closure.id}><h3>任务验收决定</h3><p>{closure.acceptanceEvidence}</p><p>{closure.reason}</p><small>审阅者 {closure.actorId} · {closure.createdAt}</small></article>)}
  </section>;
  if (mode === "history") return <section className="panel"><div className="panel-head"><h2>任务状态与决定</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
    {latestStateDecision ? <article className="decision"><strong>最近状态决定：{stateLabel[latestStateDecision.state]}</strong><p>理由：{latestStateDecision.reason}</p><small>{latestStateDecision.actorId} · {latestStateDecision.createdAt} · 固定修订 v{latestStateDecision.version}</small><p><a href={`#/p/${context.projectId}/tasks/${task.id}?revision=${encodeURIComponent(latestStateDecision.id)}`}>打开当次固定修订与依据 →</a></p></article>
      : <p className="muted">{revisions.length ? "目前只有初始提议，尚无状态变更决定。" : "正在读取状态决定历史；读取失败时不能据当前状态推断理由。"}</p>}
    <RevisionHistory label="重新读取完整任务状态时间线" autoLoad load={async () => {
      const rows = await api(context.token).taskRevisions(context.projectId, task.id);
      setRevisions(rows.map(row => row.revision));
      return rows.map(({ revision, basis }) => ({ key: revision.id, title: `v${revision.version} · ${stateLabel[revision.state]}`,
        body: `目标：${revision.goal}\n验收：${revision.acceptance}\n固定过程依据：${basis?.members.length ?? 0} 项`,
        reason: revision.reason, actorId: revision.actorId, createdAt: revision.createdAt,
        href: `#/p/${context.projectId}/tasks/${task.id}?revision=${encodeURIComponent(revision.id)}` }));
    }} />
    {proposal && <dl><div><dt>目标消费者</dt><dd>{proposal.consumer}</dd></div><div><dt>完成要求</dt><dd>{proposal.useRequired ? "需有本次交付的实际使用记录" : "技术子任务；不据此判阶段效果"}</dd></div><div><dt>提议证据</dt><dd>{proposal.evidence}</dd></div><div><dt>停止条件</dt><dd>{proposal.stopCondition}</dd></div></dl>}
    <h3>提议判断历史</h3>{(detail.judgements ?? []).length === 0 && <p className="empty">尚无提议判断。</p>}
    {(detail.judgements ?? []).map(judgement => <article className="decision" key={judgement.id}><strong>{judgement.decision}</strong><p>{judgement.reason}</p><p>证据：{judgement.evidence}</p>{judgement.relookCondition && <p>重看条件：{judgement.relookCondition}</p>}<small>{judgement.actorId} · {judgement.createdAt}</small></article>)}
  </section>;
  return <section className="panel"><div className="panel-head"><h2>任务操作</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
    {error && <Notice error>关联依据暂不可读：{error}</Notice>}
    <details className="workflow-detail task-command-disclosure"><summary>打开任务操作</summary><p className="muted">选择当前任务的判断、交付、验收或状态操作。提交前请核对任务版本与恢复回执。</p>
    {task.state === "proposed" && <>
      <ActionForm context={context} review title="判断提议" fields={[
        { name: "decision", label: "处理方式", kind: "select", options: [option("approve", "依据充分，可接受"), option("needsEvidence", "需要补证"), option("defer", "暂缓并约定重看"), option("reject", "拒绝并保留理由")] },
        { name: "evidence", label: "判断依据", kind: "textarea" }, { name: "relookCondition", label: "补证或重看条件（非批准时必填）", kind: "textarea", optional: true }, reasonField,
      ]} build={v => ({ ...base, type: "task.judge", ...v, ...(v.relookCondition ? {} : { relookCondition: undefined }) })} />
      <ActionForm context={context} review title="接受任务并固定依据" fields={[reasonField]} build={v => ({ ...base, type: "task.accept", basis: linked.filter(d => d.adopted).map(d => ({ documentId: d.document.id, revisionId: d.adopted!.id })), ...v })} />
      {(!linked.length || linked.some(d => !d.adopted)) && <Notice>接受需要已采纳的完整文档依据。先在文档详情采纳相应修订；未采纳的材料不会自动成为执行依据。</Notice>}
      <details className="workflow-detail"><summary>补证并修订提议</summary><ActionForm context={context} title="提交修订后的提议" fields={[
        { name: "title", label: "任务名称", value: task.title }, { name: "goal", label: "工作目标", kind: "textarea", value: task.goal },
        { name: "acceptance", label: "验收", kind: "textarea", value: task.acceptance }, { name: "owner", label: "责任者", value: task.owner },
        { name: "evidence", label: "新增证据", kind: "textarea" }, { name: "consumer", label: "消费者", value: proposal?.consumer ?? task.owner },
        { name: "useRequired", label: "要求实际使用", kind: "select", value: String(proposal?.useRequired ?? true), options: [option("true", "需要"), option("false", "技术子任务")] },
        { name: "stopCondition", label: "停止条件", kind: "textarea", value: proposal?.stopCondition ?? "" }, reasonField,
      ]} build={v => ({ ...base, type: "task.revise", ...v, useRequired: v.useRequired === "true", documentIds: detail.links.map(l => l.documentId) })} /></details>
    </>}
    {task.state === "ready" && <ActionForm context={context} title="开始工作" fields={[reasonField]} build={v => ({ ...base, type: "task.start", ...v })} />}
    {(task.state === "active" || task.state === "review") && <details className="workflow-detail" open={!latest}><summary>{latest ? "提交新的交付（旧记录保留）" : "登记本次交付"}</summary><ActionForm context={context} title="登记交付" fields={[
      { name: "artifactRef", label: "产物位置", hint: "可追溯的文档、文件或 PR 地址" }, { name: "artifactRevision", label: "产物固定修订" },
      { name: "contentHash", label: "内容 SHA-256", hint: "64 位十六进制摘要，用于核对同一份产物" },
      { name: "technicalResult", label: "技术检查结果", kind: "select", options: [option("passed", "检查通过"), option("failed", "检查失败，不能关闭")] },
      { name: "technicalEvidence", label: "实际检查与结果证据", kind: "textarea" }, reasonField,
    ]} build={v => ({ ...base, type: "delivery.record", ...v })} /></details>}
    {task.state === "review" && latest && <>
      <ActionForm context={context} title="记录本次交付的使用观察" fields={[
        { name: "observer", label: "实际使用者", value: context.principal.actorId }, { name: "observerKind", label: "使用者类型", kind: "select", options: [option("agent", "Agent 使用（以当前身份记录）"), option("human", "人类使用（审阅者据证据登记）")] },
        { name: "result", label: "原路径的使用结果", kind: "select", options: [option("used", "实际使用并有可核对结果"), option("failed", "尝试使用但失败"), option("notUsed", "尚未使用")] },
        { name: "evidence", label: "使用过程、结果与反馈证据", kind: "textarea" }, reasonField,
      ]} build={v => ({ type: "observation.record", taskId: task.id, deliveryId: latest.id, ...v })} />
      <Notice>人类使用由登记者提供证据与姓名；这条登记不会自动证明长期效果。技术通过、使用成功与阶段回看分别判断。</Notice>
      <ActionForm context={context} review title="核对验收并关闭任务" fields={[
        { name: "acceptanceResult", label: "约定验收是否满足", kind: "select", options: [option("met", "已逐项核对满足"), option("unmet", "尚不满足，保留待处理")] },
        { name: "acceptanceEvidence", label: "逐项验收证据与限制", kind: "textarea" }, reasonField,
      ]} build={v => ({ ...base, type: "task.close", deliveryId: latest.id, ...v })} />
    </>}
    {(task.state === "blocked" || task.state === "deferred") && <ActionForm context={context} title="恢复工作" fields={[
      { name: "target", label: "恢复到", kind: "select", options: [option("ready", "可做，重新核对后开始"), option("active", "执行中，继续已有工作")] }, reasonField,
    ]} build={v => ({ ...base, type: "task.resume", ...v })} />}
    {["ready", "active", "review"].includes(task.state) && <details className="workflow-detail"><summary>记录阻塞、暂缓或取消</summary><ActionForm context={context} title="保存状态决定" fields={[
      { name: "action", label: "状态", kind: "select", options: [option("block", "阻塞，保留需解决事项"), option("defer", "暂缓，保留重看条件"), option("cancel", "取消，保留工作历史")] }, reasonField,
    ]} build={v => ({ ...base, type: `task.${v.action}`, reason: v.reason })} /></details>}
    </details>
  </section>;
}
