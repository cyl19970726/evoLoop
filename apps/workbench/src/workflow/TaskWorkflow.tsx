import * as React from "react";
import type { DocumentDetail, RuntimeRunRecord, TaskDetail, TaskRevision, TaskRevisionState } from "@evoloop/contracts";
import { api, safeArtifactHref } from "../api";
import { runtimeClient } from "../runtime/client";
import { ActionForm, Notice, option, reasonField, type MutationContext } from "./ActionForm";
import { attributableRuns } from "./deliveryRun";
import { RevisionHistory } from "./RevisionHistory";
import { useRoleChoices } from "./useRoleChoices";

const { useEffect, useState } = React;

export const taskStateLabel: Record<TaskRevisionState, string> = {
  todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消",
  proposed: "历史·待判断", ready: "历史·可做", active: "历史·进行中", review: "历史·待验收",
  blocked: "历史·阻塞", deferred: "历史·暂缓",
};
export const taskKindLabel = { implementation: "实施", research: "调研", validation: "验证" } as const;

export function TaskWorkflow({ context, detail, documents, mode = "actions" }: { context: MutationContext; detail: TaskDetail; documents?: Record<string, DocumentDetail>; mode?: "actions" | "delivery" | "history" }) {
  const task = detail.task;
  const [roleRetry, setRoleRetry] = useState(0);
  const roleChoices = useRoleChoices(context.token, context.projectId, `${task.version}:${roleRetry}`, mode === "actions");
  const ownerOptions = roleChoices.loading || roleChoices.error
    ? [option(task.owner, "当前负责者（职责目录待核对）")]
    : roleChoices.options.some(item => item.value === task.owner) ? roleChoices.options
      : [option(task.owner, "当前负责者（未核为活跃角色）"), ...roleChoices.options];
  const [revisions, setRevisions] = useState<TaskRevision[]>([]);
  const [runs, setRuns] = useState<RuntimeRunRecord[]>([]);
  const [runReadError, setRunReadError] = useState("");
  useEffect(() => {
    if (mode !== "actions" || task.state !== "in_progress") return;
    let active = true;
    setRuns([]); setRunReadError("");
    runtimeClient(context.token, context.projectId).runs(task.id)
      .then(rows => { if (active) setRuns(attributableRuns(context.projectId, task.id, rows)); })
      .catch(() => { if (active) setRunReadError("暂时无法读取来源 Run；可登记无 Run 归属的交付，不能猜测归属。"); });
    return () => { active = false; };
  }, [context.token, context.projectId, task.id, task.version, task.state, mode]);
  const base = { taskId: task.id, expectedVersion: task.version };
  const olderSources = (detail.basis?.members ?? []).flatMap(member => {
    const document = documents?.[member.documentId]?.document;
    const checkpoint = detail.basis?.retentions?.some(item => item.documentId === member.documentId
      && item.revisionId === member.revisionId && item.observedAdoptedRevisionId === document?.adoptedRevisionId);
    const reviewedImpact = detail.impacts.some(impact => impact.documentId === member.documentId && impact.fromRevisionId === member.revisionId
      && impact.toRevisionId === document?.adoptedRevisionId && impact.state === "resolved"
      && detail.decisions.some(decision => decision.impactId === impact.id && decision.decision === "retain"));
    return document?.adoptedRevisionId && document.adoptedRevisionId !== member.revisionId && !checkpoint && !reviewedImpact
      ? [{ ...member, title: document.title, observedAdoptedRevisionId: document.adoptedRevisionId }] : [];
  });
  const deliveries = detail.deliveries ?? [];
  const latest = deliveries.at(-1);
  const acceptanceMode = detail.proposal?.acceptanceMode ?? null;
  const usedObservation = (detail.observations ?? []).filter(item => item.deliveryId === latest?.id &&
    (!detail.proposal?.consumer || item.observer === detail.proposal.consumer)).at(-1);
  const observedUse = !detail.proposal?.useRequired && !acceptanceMode || usedObservation?.result === "used" &&
    (acceptanceMode === "independent_agent" ? !!latest?.submittedByActorId &&
      usedObservation.observerKind === "agent" && usedObservation.actorId === usedObservation.observer &&
      usedObservation.actorId !== latest.submittedByActorId
      : acceptanceMode === "human_required" ? usedObservation.observerKind === "human" &&
        usedObservation.actorId === detail.proposal?.consumer : true);
  const closableDelivery = latest?.taskRevisionId === detail.revision.id && latest.technicalResult === "passed" && observedUse;
  const latestStateDecision = revisions.filter((revision, index) => index > 0 && revision.state !== revisions[index - 1]?.state).at(-1);
  if (mode === "delivery") return <section className="panel task-records"><div className="panel-head"><h2>交付与使用记录</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
    {deliveries.length === 0 && <p className="empty">还没有交付；任务状态不代替产物和使用证据。</p>}
    {[...deliveries].reverse().map(delivery => <article className="decision" key={delivery.id}>
      <h3>{delivery.id === latest?.id ? "最新交付" : "历史交付"} · 技术{delivery.technicalResult === "passed" ? "通过" : "失败"}</h3>
      <p className="break-anywhere">产物：{safeArtifactHref(delivery.artifactRef, context.projectId)
        ? <a href={safeArtifactHref(delivery.artifactRef, context.projectId)!} target={(safeArtifactHref(delivery.artifactRef, context.projectId) ?? "").startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{delivery.artifactRef}</a>
        : delivery.artifactRef} · 固定修订 {delivery.artifactRevision}</p><p className="break-anywhere">SHA-256 {delivery.contentHash}</p>
      <p><strong>技术检查证据</strong><br />{delivery.technicalEvidence}</p>
      <p>登记修订 <a href={`#/p/${context.projectId}/tasks/${task.id}?revision=${encodeURIComponent(delivery.taskRevisionId)}`}>{delivery.taskRevisionId} ↗</a>；{delivery.runId ? <>来源 Run {delivery.runId}（执行修订须从运行记录核对）</> : "无 Run 归属"}；提交者 {delivery.submittedByActorId ?? "未核实"}</p>
      <p className="muted">产物链接只指向位置；固定修订、哈希与实际内容仍须独立核对。</p>
      <h3>这次交付的使用观察</h3>
      {(detail.observations ?? []).filter(observation => observation.deliveryId === delivery.id).length === 0 && <p className="empty">尚无这次交付的使用观察。</p>}
      {(detail.observations ?? []).filter(observation => observation.deliveryId === delivery.id).map(observation => <div className="history" key={observation.id}><strong>{observation.observer}（{observation.observerKind}） · {observation.result}</strong><p>{observation.evidence}</p><p>记录理由：{observation.reason}</p><small>登记者 {observation.actorId} · {observation.createdAt}</small></div>)}
    </article>)}
    {(detail.closures ?? []).map(closure => <article className="decision" key={closure.id}><h3>任务验收决定</h3>
      <p>{closure.decisionId ? "依据：已结算的认知判断（仅完成本轮判断，不代表来源业务任务完成）" : "依据：本任务交付"}</p>
      <p className="break-anywhere">{closure.decisionId ? `判断 ${closure.decisionId} · 来源入站 ${closure.sourceInboxId} · 来源事件 ${closure.sourceEventId}` : `交付 ${closure.deliveryId}`}</p>
      {closure.sourceTaskId && <p className="break-anywhere">原业务任务 <a href={`#/p/${context.projectId}/tasks/${closure.sourceTaskId}`}>{closure.sourceTaskId} ↗</a></p>}
      {closure.waitingInboxId && <p className="break-anywhere">待承接入站 {closure.waitingInboxId}（仍须处理原业务责任）</p>}
      {closure.handoffDispatchId && <p className="break-anywhere">正式子派发 {closure.handoffDispatchId}；
        {closure.handoffTaskId && <>待办业务任务 <a href={`#/p/${context.projectId}/tasks/${closure.handoffTaskId}`}>{closure.handoffTaskId} ↗</a></>}
        （父任务的本轮判断已验收，子任务仍需独立完成）</p>}
      <p>{closure.acceptanceEvidence}</p><p>{closure.reason}</p><small>审阅者 {closure.actorId} · {closure.createdAt}</small>
    </article>)}
  </section>;
  if (mode === "history") return <section className="panel"><div className="panel-head"><h2>任务状态与决定</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
    {latestStateDecision ? <article className="decision"><strong>最近状态决定：{taskStateLabel[latestStateDecision.state]}</strong><p>理由：{latestStateDecision.reason}</p><small>{latestStateDecision.actorId} · {latestStateDecision.createdAt} · 固定修订 v{latestStateDecision.version}</small><p><a href={`#/p/${context.projectId}/tasks/${task.id}?revision=${encodeURIComponent(latestStateDecision.id)}`}>打开当次固定正文与依据 →</a></p></article>
      : <p className="muted">{revisions.length ? "目前只有初始任务，尚无状态变更决定。" : "正在读取状态决定历史；读取失败时不能据当前状态推断理由。"}</p>}
    <RevisionHistory label="重新读取完整任务状态时间线" autoLoad load={async () => {
      const rows = await api(context.token).taskRevisions(context.projectId, task.id);
      setRevisions(rows.map(row => row.revision));
      return rows.map(({ revision, basis }) => ({ key: revision.id, title: `v${revision.version} · ${taskStateLabel[revision.state]}`,
        body: `正文：${revision.content.slice(0, 320)}${revision.content.length > 320 ? "…" : ""}\n验收：${revision.acceptance}\n固定过程依据：${basis?.members.length ?? 0} 项`,
        reason: revision.reason, actorId: revision.actorId, createdAt: revision.createdAt,
        href: `#/p/${context.projectId}/tasks/${task.id}?revision=${encodeURIComponent(revision.id)}` }));
    }} />
    {detail.proposal && <dl><div><dt>验收方式</dt><dd>{acceptanceMode === "independent_agent" ? "独立 Agent 使用当前交付" : acceptanceMode === "human_required" ? "受信本人使用当前交付" : "历史合同"}</dd></div><div><dt>目标消费者</dt><dd>{detail.proposal.consumer || "未指定；须由符合验收方式的身份签收"}</dd></div><div><dt>完成要求</dt><dd>{detail.proposal.useRequired ? "需有本次交付的实际使用记录" : "按历史合同核对"}</dd></div><div><dt>提议证据</dt><dd>{detail.proposal.evidence}</dd></div><div><dt>停止条件</dt><dd>{detail.proposal.stopCondition}</dd></div></dl>}
    {(detail.judgements ?? []).length > 0 && <><h3>旧提议判断历史</h3>{(detail.judgements ?? []).map(judgement => <article className="decision" key={judgement.id}><strong>{judgement.decision}</strong><p>{judgement.reason}</p><p>证据：{judgement.evidence}</p><small>{judgement.actorId} · {judgement.createdAt}</small></article>)}</>}
  </section>;
  return <section className="panel"><div className="panel-head"><h2>任务操作</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
    <p className="muted">正文由任务持有固定文档。提交前核对当前版本；操作结果未知时保留原 ID，不重复发送。</p>
    {task.state === "in_progress" && <Notice>执行范围已固定。需要修改正文、验收、责任者或类型时，先通过下方操作返回待办，再更新并重新开始。</Notice>}
    {roleChoices.error && <Notice error>职责选择暂不可完整读取：{roleChoices.error}。仍可保留现负责者，修改任务正文与验收；更换负责者须先读全职责目录。<button type="button" onClick={() => setRoleRetry(value => value + 1)}>重试读取职责</button></Notice>}
    {(task.state === "todo" || task.state === "in_progress") && <ActionForm context={context} title="更新任务内容" fields={[
      { name: "title", label: "任务名称", value: task.title }, { name: "kind", label: "类型（可选）", kind: "select", optional: true, value: task.kind ?? "", options: [option("implementation", "实施"), option("research", "调研"), option("validation", "验证")] },
      { name: "content", label: "任务内容", kind: "textarea", value: task.content },
      { name: "acceptance", label: "独立验收条件", kind: "textarea", value: task.acceptance }, { name: "owner", label: "负责角色", kind: "select", value: task.owner, options: ownerOptions }, reasonField,
    ]} build={v => {
      if (!ownerOptions.some(item => item.value === v.owner)) throw new Error("所选职责未在当前已核对范围内");
      return { ...base, type: "task.update", title: v.title, kind: v.kind || null, content: v.content, acceptance: v.acceptance,
      owner: v.owner, documentIds: detail.links.map(link => link.documentId), ...(detail.proposal ? {
        ...(detail.proposal.consumer ? { consumer: detail.proposal.consumer } : {}), useRequired: detail.proposal.useRequired,
        ...(detail.proposal.evidence ? { evidence: detail.proposal.evidence } : {}),
        ...(detail.proposal.stopCondition ? { stopCondition: detail.proposal.stopCondition } : {}),
      } : {}), reason: v.reason };
    }} />}
    {task.state === "todo" && context.principal.permissions.includes("review") && <ActionForm context={context} review title="修订验收责任" fields={[
      { name: "acceptanceMode", label: "验收方式", kind: "select", value: acceptanceMode ?? "legacy", options: [
        ...(acceptanceMode ? [] : [option("legacy", "保留旧任务历史合同")]),
        option("independent_agent", "独立 Agent 验收"), option("human_required", "必须本人验收")] },
      { name: "consumer", label: "指定验收身份（可选）", optional: true, value: detail.proposal?.consumer ?? "",
        hint: "本人验收必须填写本人受信身份 ID；独立 Agent 可以不预先指定。" }, reasonField,
    ]} build={v => ({ ...base, type: "task.update", title: task.title, content: task.content, acceptance: task.acceptance,
      owner: task.owner, kind: task.kind, documentIds: detail.links.map(link => link.documentId),
      ...(v.acceptanceMode !== "legacy" ? { acceptanceMode: v.acceptanceMode, useRequired: true } : {}),
      consumer: v.consumer.trim() || null, reason: v.reason })} />}
    {task.state === "todo" && <><ActionForm context={context} review title="开始任务并固定依据" fields={[reasonField,
      ...olderSources.map(source => ({ name: `retain_${source.documentId}`, label: `如需保留《${source.title}》旧版 ${source.revisionId.slice(0, 8)}，请写理由`, kind: "textarea" as const, optional: true,
        hint: `已核到发布版 ${source.observedAdoptedRevisionId.slice(0, 8)}；先从依据页读两版。留空不会自动同意使用旧版。` })),
    ]} build={v => {
      const retentions = olderSources.filter(source => v[`retain_${source.documentId}`]?.trim()).map(source => ({ documentId: source.documentId,
        revisionId: source.revisionId, observedAdoptedRevisionId: source.observedAdoptedRevisionId, reason: v[`retain_${source.documentId}`].trim() }));
      return { ...base, type: "task.start", reason: v.reason, ...(retentions.length ? { retentions } : {}) };
    }} /><Notice>任务正文的固定修订由服务自动加入依据，无需预建独立文档；额外来源可由 Agent 按固定修订提交。已有且仍适用的保留决定会沿用；新的逐项理由与依据一起封存，上游再改版仍需复核。</Notice></>}
    {task.state === "in_progress" && <>
      {runReadError && <Notice error>{runReadError}</Notice>}
      <details className="workflow-detail" open={!latest}><summary>{latest ? "提交新的交付（旧记录保留）" : "登记本次交付"}</summary><ActionForm context={context} title="登记交付" fields={[
        { name: "runId", label: "来源 Run（可选，须真实归属）", kind: "select", optional: true, options: runs.map(run => option(run.id, `${run.state} · ${run.id.slice(0, 8)} · 执行修订 ${run.taskRevisionId.slice(0, 8)}`)), hint: "只列同项目本任务的终态 Run；不选择则明确无 Run 归属。服务器还会核对执行时和当前业务输入一致。终态不代表产物合格。" },
        { name: "artifactRef", label: "产物位置", hint: "可追溯的文档、文件或 PR 地址" }, { name: "artifactRevision", label: "产物固定修订" },
        { name: "contentHash", label: "内容 SHA-256", hint: "64 位十六进制摘要" },
        { name: "technicalResult", label: "技术检查结果", kind: "select", options: [option("passed", "检查通过"), option("failed", "检查失败，不能关闭")] },
        { name: "technicalEvidence", label: "实际检查与结果证据", kind: "textarea" }, reasonField,
      ]} build={v => { const { runId, ...fields } = v; return { ...base, type: "delivery.record", ...fields, ...(runId ? { runId } : {}) }; }} /></details>
      {latest && <>{acceptanceMode === "human_required" && context.principal.identityKind !== "human" && <Notice>本任务等待指定的受信用户本人登录并记录使用结果。</Notice>}
      {(acceptanceMode !== "human_required" || context.principal.identityKind === "human") && <ActionForm context={context} title="记录本次交付的使用观察" fields={[
        { name: "observer", label: "实际使用者", value: context.principal.actorId }, { name: "observerKind", label: "使用者类型", kind: "select", options: acceptanceMode === "independent_agent" ? [option("agent", "Agent 使用")] : acceptanceMode === "human_required" ? [option("human", "受信本人使用")] : [option("agent", "Agent 使用"), option("human", "人类使用（需实际证据）")] },
        { name: "result", label: "使用结果", kind: "select", options: [option("used", "实际使用并有结果"), option("failed", "尝试使用但失败"), option("notUsed", "尚未使用")] },
        { name: "evidence", label: "使用过程、结果与反馈证据", kind: "textarea" }, reasonField,
      ]} build={v => ({ type: "observation.record", taskId: task.id, deliveryId: latest.id, ...v })} />}
      <Notice>登记使用观察不自动证明长期效果。技术检查、实际使用与验收分别判断。</Notice>
      {closableDelivery ? <ActionForm context={context} review title="核对验收并关闭任务" fields={[
        { name: "acceptanceEvidence", label: "逐项验收已满足的证据与限制", kind: "textarea" }, reasonField,
      ]} build={v => ({ ...base, type: "task.close", deliveryId: latest.id, acceptanceResult: "met", ...v })} />
        : <Notice>当前修订需要合格交付{detail.proposal?.useRequired ? "，并有约定消费者对本次交付的实际使用记录" : ""}。验收未满足时继续处理，不关闭任务。</Notice>}</>}
    </>}
    {(task.state === "todo" || task.state === "in_progress") && <ActionForm context={context} review title="取消任务" fields={[reasonField]}
      build={v => ({ ...base, type: "task.cancel", ...v })} />}
    {(task.state === "in_progress" || task.state === "done" || task.state === "cancelled") && <ActionForm context={context} review title={task.state === "in_progress" ? "返回待办以重新定界" : "重新打开任务"} fields={[reasonField]}
      build={v => ({ ...base, type: "task.reopen", ...v })} />}
  </section>;
}
