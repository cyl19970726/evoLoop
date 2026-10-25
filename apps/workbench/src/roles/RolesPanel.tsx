import { useEffect, useRef, useState } from "react";
import type { RoleHandoff, RoleProposal, RoleRecord, RoleRevision, RoleSessionBinding, RoleTrialReview } from "@evoloop/contracts/roles";
import { errorText } from "../api";
import { ActionForm, Notice, option, reasonField, type Field, type MutationContext } from "../workflow/ActionForm";
import { roleClient } from "./client";
import { RolePresenceCard } from "./RolePresenceCard";
import { RoleTemplateSummary } from "./RoleTemplateSummary";
import { href } from "../ui/shared";

const roleIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function roleQuery(projectId: string): string | null {
  const [path, query = ""] = window.location.hash.split("?");
  if (path !== href(projectId,"roles")) return null;
  const params = new URLSearchParams(query);
  if (!params.has("role")) return null;
  const values = params.getAll("role");
  return values.length === 1 ? values[0]! : "";
}

const lines = (value: string) => value.split(/\r?\n/).map(part => part.trim()).filter(Boolean);
const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const stateLabel: Record<RoleRecord["state"], string> = { candidate: "待判断", trial: "试行中", active: "持续职责", "retirement-pending": "待交接关闭", retired: "已撤回", rejected: "未采纳", deferred: "待重看" };
const classLabel = (role: RoleRecord) => role.proposal.roleClass === "system" ? "系统职责" : role.proposal.roleClass === "business" ? "业务职责" : "分类未登记";
const evidenceKinds = [{ kind: "gap", label: "积压、遗漏或返工" }, { kind: "effect", label: "实际效果" }, { kind: "cost", label: "已付成本" }] as const;
const alternativeKinds = [
  { kind: "method", label: "改方法或工具" }, { kind: "knowledge", label: "补知识或输入" },
  { kind: "another-instance", label: "同职责增实例" }, { kind: "temporary-assignment", label: "临时专项" },
] as const;
const proposalFields: Field[] = [
  { name: "title", label: "职责名称" }, { name: "goal", label: "独立目标", kind: "textarea" },
  { name: "independentResponsibility", label: "为什么需要持续独立判断", kind: "textarea" },
  { name: "ownerScope", label: "责任与授权范围", kind: "textarea" },
  { name: "inputs", label: "主要输入（每行一项）", kind: "textarea" },
  { name: "writableAssets", label: "可写资产（每行一项，可留空）", kind: "textarea", optional: true },
  { name: "deliverables", label: "交付（每行一项）", kind: "textarea" },
  { name: "triggers", label: "触发条件（每行一项）", kind: "textarea" },
  { name: "workflow", label: "检查、判断、修复与交付流程", kind: "textarea" },
  { name: "handoffBoundary", label: "与既有职责的交接边界", kind: "textarea" },
  { name: "gapKind", label: "主要责任缺口", kind: "select", options: [option("backlog", "持续积压"), option("omission", "反复遗漏"), option("rework", "反复返工")] },
  ...evidenceKinds.flatMap(item => [
    { name: `${item.kind}Observation`, label: `${item.label}：观察`, kind: "textarea" as const },
    { name: `${item.kind}SourceRef`, label: `${item.label}：固定来源引用` },
    { name: `${item.kind}ObservedAtUtc`, label: `${item.label}：实际观察时间（ISO 8601）`, hint: "填来源发生或核对的时间，不会自动写成提案时间。" },
  ]),
  ...alternativeKinds.flatMap(item => [
    { name: `${item.kind}Assessment`, label: `${item.label}能否解决及原因`, kind: "textarea" as const },
    { name: `${item.kind}Cost`, label: `${item.label}的估计成本` },
  ]),
  { name: "firstTaskId", label: "首项试行任务 ID", hint: "必须是本项目仍未结束的真实任务；创建职责不会自动接受任务。" },
  { name: "baseline", label: "当前基线", kind: "textarea" }, { name: "expectedEffect", label: "预期效果", kind: "textarea" },
  { name: "costLimit", label: "试行成本上限" }, { name: "trialDays", label: "最长试行天数（1–90）", value: "14" },
  { name: "reviewAtUtc", label: "回看时间（ISO 8601，含时区）", hint: "须在试行期限内；例如 2026-11-03T09:00:00+08:00。" },
  { name: "exitCriteria", label: "停止或撤回判据", kind: "textarea" },
];
function buildProposal(values: Record<string, string>): RoleProposal {
  return {
    title: values.title!, goal: values.goal!, independentResponsibility: values.independentResponsibility!, ownerScope: values.ownerScope!,
    inputs: lines(values.inputs!), writableAssets: lines(values.writableAssets || ""), deliverables: lines(values.deliverables!), triggers: lines(values.triggers!),
    workflow: values.workflow!, handoffBoundary: values.handoffBoundary!,
    evidence: evidenceKinds.map(item => ({ kind: item.kind === "gap" ? values.gapKind as "backlog" | "omission" | "rework" : item.kind, observation: values[`${item.kind}Observation`]!, sourceRef: values[`${item.kind}SourceRef`]!, observedAtUtc: new Date(values[`${item.kind}ObservedAtUtc`]!).toISOString() })),
    alternatives: alternativeKinds.map(item => ({ kind: item.kind, assessment: values[`${item.kind}Assessment`]!, estimatedCost: values[`${item.kind}Cost`]! })),
    firstTaskId: values.firstTaskId!, baseline: values.baseline!, expectedEffect: values.expectedEffect!, costLimit: values.costLimit!, trialDays: Number(values.trialDays),
    reviewAtUtc: new Date(values.reviewAtUtc!).toISOString(), exitCriteria: values.exitCriteria!,
  };
}

export function RolesPanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const epochRef = useRef(0);
  const moreInFlightRef = useRef(false);
  const targetPages = useRef(0);
  const [targetRoute, setTargetRoute] = useState(() => ({projectId:context.projectId,value:roleQuery(context.projectId),tick:0}));
  useEffect(() => {
    const reread = () => setTargetRoute(previous => ({projectId:context.projectId,value:roleQuery(context.projectId),tick:previous.tick+1}));
    reread(); window.addEventListener("hashchange",reread);
    return () => window.removeEventListener("hashchange",reread);
  }, [context.projectId]);
  const target = targetRoute.projectId === context.projectId ? targetRoute.value : roleQuery(context.projectId);
  const validTarget = target !== null && roleIdPattern.test(target);
  const foundTarget = validTarget ? roles.find(role => role.id === target && role.projectId === context.projectId) : undefined;
  useEffect(() => { targetPages.current = 0; }, [target, context.projectId, refresh]);
  useEffect(() => {
    let active = true; const epoch = ++epochRef.current;
    moreInFlightRef.current = false;
    setRoles([]); setNextCursor(null); setLoading(true); setLoadingMore(false); setError(""); setMoreError("");
    roleClient(context.token, context.projectId).list()
      .then(page => { if (active && epochRef.current === epoch) { setRoles(page.items); setNextCursor(page.nextCursor); } })
      .catch(cause => { if (active && epochRef.current === epoch) setError(errorText(cause)); })
      .finally(() => { if (active && epochRef.current === epoch) setLoading(false); });
    return () => { active = false; if (epochRef.current === epoch) epochRef.current++; };
  }, [context.token, context.projectId, refresh]);
  async function loadMore() {
    if (!nextCursor || loading || moreInFlightRef.current) return;
    const cursor = nextCursor, epoch = epochRef.current;
    moreInFlightRef.current = true; setLoadingMore(true); setMoreError("");
    try {
      const page = await roleClient(context.token, context.projectId).list(cursor);
      if (epochRef.current !== epoch) return;
      if (page.nextCursor === cursor) throw new Error("职责列表游标没有前进，请回读当前状态。");
      setRoles(previous => {
        const byId = new Map(previous.map(role => [role.id, role]));
        for (const role of page.items) byId.set(role.id, role);
        return [...byId.values()];
      });
      setNextCursor(page.nextCursor);
    } catch (cause) { if (epochRef.current === epoch) setMoreError(errorText(cause)); }
    finally { if (epochRef.current === epoch) { moreInFlightRef.current = false; setLoadingMore(false); } }
  }
  useEffect(() => {
    if (!validTarget || foundTarget || loading || loadingMore || moreError || !nextCursor || targetPages.current >= 20) return;
    targetPages.current += 1;
    void loadMore();
  }, [target, validTarget, foundTarget, loading, loadingMore, moreError, nextCursor, roles.length]);
  useEffect(() => {
    if (!target || !foundTarget) return;
    const frame = requestAnimationFrame(() => {
      if (roleQuery(context.projectId) !== target) return;
      const card = document.getElementById(`role-${target}`);
      if (card instanceof HTMLDetailsElement && card.getClientRects().length) {
        card.open = true; card.scrollIntoView({block:"start"}); card.focus({preventScroll:true});
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [context.projectId, target, targetRoute.tick, foundTarget?.id, foundTarget?.version]);
  return <div className="journey-board">
    <RoleTemplateSummary token={context.token} projectId={context.projectId} refresh={refresh} />
    <section className="panel"><div className="panel-head"><h2>职责试行</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
      <p>新会话仍可沿用已有职责。只有反复出现的独立责任缺口，才进入有边界、有成本上限的试行。</p>
      {target !== null && !validTarget && <Notice error>链接中的目标职责 ID 无效；没有定位到其他职责。</Notice>}
      {validTarget && !foundTarget && <Notice error={Boolean(error || moreError || !loading && !nextCursor || targetPages.current >= 20)}>{error ? `目标职责暂不可核对：${error}`
        : moreError ? `目标职责后续页未读回：${moreError}` : loading || loadingMore || nextCursor && targetPages.current < 20 ? `正在定位目标职责 ${target}…`
        : nextCursor ? `目标职责尚未定位；自动追加读取已到 20 页上限，可继续手动加载并核对 ${target}。`
        : `当前项目已读完职责，未找到目标 ${target}；没有定位到其他职责。`}</Notice>}
      {loading && <p>正在读取职责…</p>}{error && <Notice error>职责暂不可读：{error}</Notice>}
      {!loading && !error && roles.length === 0 && <p className="empty">本项目还没有职责提案；不会自动创建常设角色。</p>}
      {roles.map(role => <RoleCard key={`${role.id}:${role.version}`} context={context} role={role} refresh={refresh} />)}
      {moreError && <Notice error>{moreError}</Notice>}
      {nextCursor && !loading && !error && <button type="button" className="more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "继续读取中…" : "加载更多职责"}</button>}
    </section>
    <section className="panel"><details className="workflow-detail" open={roles.length === 0}><summary>提出有证据的职责试行</summary>
      <Notice>提案会保存观察与备选方案；审阅接受后才进入试行。首项任务需通过普通任务流程承接。</Notice>
      <ActionForm context={context} title="提出职责试行" fields={proposalFields} build={v => ({ type: "role.propose", roleId: crypto.randomUUID(), proposal: buildProposal(v) })} />
    </details></section>
  </div>;
}

function RoleCard({ context, role, refresh }: { context: MutationContext; role: RoleRecord; refresh: number }) {
  const [history, setHistory] = useState<{ revisions: RoleRevision[]; reviews: RoleTrialReview[]; handoffs: RoleHandoff[]; bindings: RoleSessionBinding[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function readHistory() {
    setBusy(true); setError("");
    try {
      const client = roleClient(context.token, context.projectId);
      const [revisions, reviews, handoffs, bindings] = await Promise.all([client.revisions(role.id), client.reviews(role.id), client.handoffs(role.id), client.bindings(role.id)]);
      setHistory({ revisions, reviews, handoffs, bindings });
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  useEffect(() => { setHistory(null); }, [refresh, role.version]);
  const base = { roleId: role.id, expectedVersion: role.version };
  const p = role.proposal;
  return <details className="workflow-detail" id={`role-${role.id}`} tabIndex={-1}><summary>{p.title} <span className="pill subtle">{classLabel(role)}</span> <span className="pill">{stateLabel[role.state]} · v{role.version}</span></summary>
    <RolePresenceCard token={context.token} projectId={context.projectId} roleId={role.id} roleState={role.state} refresh={refresh} />
    <dl><div><dt>目标</dt><dd>{p.goal}</dd></div><div><dt>独立判断</dt><dd>{p.independentResponsibility}</dd></div><div><dt>范围</dt><dd>{p.ownerScope}</dd></div><div><dt>输入</dt><dd>{p.inputs.join("；")}</dd></div><div><dt>可写资产</dt><dd>{p.writableAssets.join("；") || "未列出"}</dd></div><div><dt>交付</dt><dd>{p.deliverables.join("；")}</dd></div><div><dt>触发</dt><dd>{p.triggers.join("；")}</dd></div><div><dt>流程</dt><dd>{p.workflow}</dd></div><div><dt>交接边界</dt><dd>{p.handoffBoundary}</dd></div><div><dt>首项任务</dt><dd><code>{p.firstTaskId}</code></dd></div><div><dt>试行与回看</dt><dd>{p.trialDays} 天 · {stamp(role.reviewAtUtc)}</dd></div><div><dt>退出判据</dt><dd>{p.exitCriteria}</dd></div></dl>
    <h3>提出依据与比较</h3>{p.evidence.map((item, i) => <article className="decision" key={i}><strong>{item.kind}</strong><p>{item.observation}</p><small className="break-anywhere">{item.sourceRef} · {stamp(item.observedAtUtc)}</small></article>)}
    <p>当前基线：{p.baseline}。期望：{p.expectedEffect}。成本上限：{p.costLimit}。</p>
    {p.alternatives.map(item => <p key={item.kind}><strong>{item.kind}：</strong>{item.assessment}；成本 {item.estimatedCost}</p>)}
    {(role.state === "candidate" || role.state === "deferred") && <ActionForm context={context} review title="决定是否试行" fields={[{ name: "decision", label: "决定", kind: "select", options: [option("accept-trial", "接受有限试行"), option("reject", "不采纳"), option("defer", "暂缓重看")] }, reasonField]} build={v => ({ ...base, type: "role.decide", ...v })} />}
    {(role.state === "trial" || role.state === "active") && <ActionForm context={context} review title="记录职责回看" fields={[
      { name: "decision", label: "回看决定", kind: "select", options: [option("continue-trial", "延长试行并设下次回看"), option("activate", "确认持续职责"), option("merge", "并入已有职责并准备交接"), option("retire", "撤回并准备交接")] },
      { name: "effectEvidence", label: "实际效果与反例", kind: "textarea" }, { name: "effectEvidenceRefs", label: "效果固定来源（每行一项）", kind: "textarea" },
      { name: "costEvidence", label: "实际成本", kind: "textarea" }, { name: "costEvidenceRefs", label: "成本固定来源（每行一项）", kind: "textarea" },
      { name: "baselineComparison", label: "与试行前基线对比", kind: "textarea" },
      { name: "nextReviewAtUtc", label: "若延长：下次回看（ISO 8601）", optional: true },
      { name: "mergeTargetRoleId", label: "若合并：现有持续职责 ID", optional: true }, reasonField,
    ]} build={v => ({ ...base, type: "role.review", decision: v.decision, effectEvidence: v.effectEvidence, effectEvidenceRefs: lines(v.effectEvidenceRefs), costEvidence: v.costEvidence, costEvidenceRefs: lines(v.costEvidenceRefs), baselineComparison: v.baselineComparison, reason: v.reason,
      ...(v.nextReviewAtUtc ? { nextReviewAtUtc: new Date(v.nextReviewAtUtc).toISOString() } : {}), ...(v.mergeTargetRoleId ? { mergeTargetRoleId: v.mergeTargetRoleId } : {}) })} />}
    {(["trial", "active", "retirement-pending"] as string[]).includes(role.state) && <details className="workflow-detail"><summary>准备任务、知识或会话交接</summary>
      <ActionForm context={context} review title="登记待交接事项" fields={[
        { name: "kind", label: "事项类型", kind: "select", options: [option("task", "未完成任务"), option("knowledge", "知识与材料"), option("session", "会话现场")] },
        { name: "sourceRef", label: "原对象引用；任务请填任务 ID" }, { name: "targetRoleId", label: "接收职责 ID" },
        { name: "observedTaskVersion", label: "若为任务：当前任务版本", optional: true }, { name: "note", label: "交接范围与待确认内容", kind: "textarea" },
      ]} build={v => ({ ...base, type: "role.handoff", handoffId: crypto.randomUUID(), kind: v.kind, sourceRef: v.sourceRef, targetRoleId: v.targetRoleId, ...(v.kind === "task" ? { observedTaskVersion: Number(v.observedTaskVersion) } : {}), note: v.note })} />
      <Notice>任务接收需先走普通任务修订，以新版本明确改变责任者；登记交接不会直接转移任务。</Notice>
    </details>}
    {(role.state === "trial" || role.state === "active") && <details className="workflow-detail"><summary>绑定已归属的运行会话</summary><ActionForm context={context} review title="绑定运行会话" fields={[{ name: "sessionId", label: "本项目已预留且就绪的会话 ID", hint: "不能绑定任意桌面会话。" }, { name: "note", label: "绑定说明" }]} build={v => ({ ...base, type: "role.bindSession", ...v })} /></details>}
    {role.state === "retirement-pending" && <ActionForm context={context} review title="核对并撤回职责" fields={[reasonField, { name: "knowledgeDisposition", label: "知识与未读材料的处理", kind: "textarea" }, { name: "runtimeDisposition", label: "在途及未知会话的核对结果", kind: "textarea" }]} build={v => ({ ...base, type: "role.retire", ...v })} />}
    <div className="actions"><button type="button" onClick={readHistory} disabled={busy}>{busy ? "读取中…" : "阅读修订与交接历史"}</button></div>{error && <Notice error>{error}</Notice>}
    {history && <><h3>修订</h3>{history.revisions.map(item => <article className="history" key={item.id}><strong>v{item.version} · {stateLabel[item.state]}</strong><p>{item.reason}</p><small>{item.actorId} · {stamp(item.createdAtUtc)}</small></article>)}
      <h3>试行回看</h3>{history.reviews.length === 0 && <p className="empty">尚无回看；到期不会自动确认职责。</p>}{history.reviews.map(item => <article className="decision" key={item.id}><strong>{item.decision}</strong><p>效果：{item.effectEvidence}</p><p className="break-anywhere">效果来源：{item.effectEvidenceRefs.join("；")}</p><p>成本：{item.costEvidence}</p><p className="break-anywhere">成本来源：{item.costEvidenceRefs.join("；")}</p><p>基线对比：{item.baselineComparison}</p><small>{item.actorId} · {stamp(item.createdAtUtc)}</small></article>)}
      <h3>交接</h3>{history.handoffs.length === 0 && <p className="empty">尚无已登记交接事项。关闭前仍需核对未完任务、知识和在途会话。</p>}{history.handoffs.map(item => <article className="decision" key={item.id}><strong>{item.kind} · {item.state}</strong><p className="break-anywhere">{item.sourceRef} → {item.targetRoleId}</p>{item.state === "prepared" && <ActionForm context={context} review title="确认交接已完成" fields={[{ name: "note", label: "接收与核对证据", kind: "textarea" }]} build={v => ({ ...base, type: "role.ackHandoff", handoffId: item.id, ...v })} />}</article>)}
      <h3>会话绑定</h3>{history.bindings.length === 0 && <p className="empty">尚无已确认绑定的运行会话。</p>}{history.bindings.map(item => <p key={item.id} className="break-anywhere"><code>{item.sessionId}</code> · 职责修订 {item.roleRevisionId} · {stamp(item.createdAtUtc)}</p>)}
    </>}
  </details>;
}
