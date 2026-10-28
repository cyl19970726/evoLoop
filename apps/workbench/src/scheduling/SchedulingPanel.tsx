import { useEffect, useState } from "react";
import type { MisfirePolicy, Occurrence, ScheduleDefinition, ScheduleRevision, ScheduleRule } from "@evoloop/contracts/scheduling";
import { errorText } from "../api";
import { ActionForm, Notice, option, reasonField, type Field, type MutationContext } from "../workflow/ActionForm";
import { schedulingClient, type SchedulingGrant, type SchedulingStatus } from "./client";
import { MarkdownBody } from "../ui/MarkdownBody";
import { orchestrationClient } from "../orchestration/client";
import { managedTargetProblem, scheduleTemplate, suspendSchedule } from "./managedTarget";

const stamp = (value: string) => new Date(value).toLocaleString();
const stateLabel = { active: "运行中", paused: "已暂停", stopped: "已停止" } as const;
const grantKey = (grant: Pick<SchedulingGrant,"scopeId"|"roleId">) => JSON.stringify([grant.scopeId,grant.roleId]);
function fields(grants: SchedulingGrant[], definition?: ScheduleDefinition): Field[] {
  const revision = definition?.revision;
  const rule = revision?.rule;
  const oldGrant = revision?.authorization;
  const currentGrant = oldGrant && grants.some(grant => grantKey(grant) === grantKey(oldGrant));
  const canActivate = grants.length > 0;
  const choices = [...grants.map(grant => option(grantKey(grant), `${grant.scopeId} · 职责 ${grant.roleId}`)),
    ...(oldGrant && !currentGrant ? [option(grantKey(oldGrant), `${oldGrant.scopeId} · 职责 ${oldGrant.roleId}（授权已撤回，仅能暂停或停止）`)] : [])];
  return [
    { name: "state", label: "日程状态", kind: "select", value: definition?.state === "active" && !currentGrant ? "paused" : definition?.state ?? "active",
      options: [...(canActivate ? [option("active", "运行")] : []), option("paused", "暂停"), option("stopped", "停止（不能恢复）")] },
    { name: "timezone", label: "IANA 时区", value: revision?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, hint: "例如 Asia/Taipei；每日规则按当地时间，间隔规则按 UTC。" },
    { name: "ruleKind", label: "触发方式", kind: "select", value: rule?.kind ?? "once", options: [option("once", "仅一次（UTC 时刻）"), option("interval", "固定分钟间隔"), option("daily", "每天当地时间")] },
    { name: "atUtc", label: "仅一次：UTC 时刻（ISO 8601）", optional: true, value: rule?.kind === "once" ? rule.atUtc : "" },
    { name: "anchorUtc", label: "间隔：UTC 起点（ISO 8601）", optional: true, value: rule?.kind === "interval" ? rule.anchorUtc : "" },
    { name: "everyMinutes", label: "间隔：每多少分钟", optional: true, value: rule?.kind === "interval" ? String(rule.everyMinutes) : "" },
    { name: "localTime", label: "每天：当地时间 HH:mm", optional: true, value: rule?.kind === "daily" ? rule.localTime : "" },
    { name: "misfireKind", label: "错过时刻的处理", kind: "select", value: revision?.misfire.kind ?? "latest", options: [option("skip", "跳过"), option("latest", "只取最近一次"), option("bounded", "有限补做")] },
    { name: "maxCatchUp", label: "有限补做的最多次数", optional: true, value: revision?.misfire.kind === "bounded" ? String(revision.misfire.maxCatchUp) : "" },
    { name: "overlap", label: "上次任务未结束时", kind: "select", value: revision?.overlap ?? "skip", options: [option("skip", "跳过新时刻"), option("queue", "排队待核对")] },
    { name: "title", label: "新提议任务的名称", value: revision?.template.title ?? "" },
    { name: "content", label: "新任务正文（Markdown）", kind: "textarea", value: revision?.template.content ?? "" },
    { name: "acceptance", label: "新提议任务的接受条件", kind: "textarea", value: revision?.template.acceptance ?? "" },
    { name: "owner", label: "任务责任角色 ID", value: revision?.template.owner ?? "" },
    ...(revision?.template.managedTarget ? [] : [
      { name: "acceptanceMode", label: "任务验收方式", kind: "select" as const, value: revision?.template.acceptanceMode ?? "independent_agent",
        options: [option("independent_agent", "独立 Agent 验收"), option("human_required", "必须本人验收")] },
      { name: "consumer", label: "指定验收身份（可选）", optional: true, value: revision?.template.consumer ?? "",
        hint: "本人验收必须填写受信身份 ID；独立 Agent 可留空。" },
    ]),
    { name: "grant", label: "已配置的日程授权", kind: "select", value: oldGrant ? grantKey(oldGrant) : choices[0]?.value ?? "", options: choices,
      hint: "仅显示当前身份在本项目的授权；已撤回的旧授权只允许暂停或停止。" },
    { name: "expiresAtUtc", label: "授权到期（ISO 8601，可留空）", optional: true, value: revision?.authorization.expiresAtUtc ?? "" },
    reasonField,
  ];
}
function fromValues(values: Record<string, string>, context: MutationContext, grants: SchedulingGrant[], definition?: ScheduleDefinition) {
  const grant = grants.find(item => grantKey(item) === values.grant);
  const old = definition?.revision.authorization;
  const usingRevokedOldGrant = !grant && !!old && grantKey(old) === values.grant && values.state !== "active";
  if (!grant && !usingRevokedOldGrant) throw new Error("当前身份没有所选日程授权；不能创建或恢复运行。");
  const rule: ScheduleRule = values.ruleKind === "interval" ? { kind: "interval", anchorUtc: new Date(values.anchorUtc!).toISOString(), everyMinutes: Number(values.everyMinutes) }
    : values.ruleKind === "daily" ? { kind: "daily", localTime: values.localTime! }
      : { kind: "once", atUtc: new Date(values.atUtc!).toISOString() };
  const misfire: MisfirePolicy = values.misfireKind === "bounded" ? { kind: "bounded", maxCatchUp: Number(values.maxCatchUp) }
    : values.misfireKind === "skip" ? { kind: "skip" } : { kind: "latest" };
  return { state: values.state, timezone: values.timezone, rule, misfire, overlap: values.overlap,
    template: scheduleTemplate(values, definition),
    authorization: { scopeId: grant?.scopeId ?? old!.scopeId, roleId: grant?.roleId ?? old!.roleId, authorizedBy: context.principal.actorId,
      expiresAtUtc: values.expiresAtUtc ? new Date(values.expiresAtUtc).toISOString() : null }, reason: values.reason };
}
function ruleText(rule: ScheduleRule): string {
  if (rule.kind === "once") return `仅一次 · ${stamp(rule.atUtc)}`;
  if (rule.kind === "interval") return `从 ${stamp(rule.anchorUtc)} 起，每 ${rule.everyMinutes} 分钟`;
  return `每天 ${rule.localTime}（当地时间）`;
}

export function SchedulingPanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [schedules, setSchedules] = useState<ScheduleDefinition[]>([]);
  const [status, setStatus] = useState<SchedulingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    const client = schedulingClient(context.token, context.projectId);
    Promise.all([client.list(),client.status()])
      .then(([items,nextStatus]) => { if (active) { setSchedules(items); setStatus(nextStatus); } })
      .catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh]);
  return <div className="journey-board">
    <section className="panel"><div className="panel-head"><h2>日程</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
      <p>日程只按授权范围创建待办任务；任务仍需由负责人或 Agent 核对正文、开始与执行。</p>
      {loading && <p>正在读取日程…</p>}{error && <Notice error>日程暂不可读：{error}</Notice>}
      {status && <Notice error={["disabled","unavailable","no-authority","error","stopped"].includes(status.state)}>
        协调器状态：{({ idle:"待检查",running:"检查中",disabled:"未启用",unavailable:"不可用", "no-authority":"没有可运行授权",error:"检查失败",stopped:"已停止" } as Record<SchedulingStatus["state"],string>)[status.state]}
        {status.lastTickAt ? ` · 最近检查 ${stamp(status.lastTickAt)}` : " · 尚无成功检查时刻"}
        {status.lastError ? ` · ${status.lastError}` : ""}
      </Notice>}
      {status && status.grants.length === 0 && <Notice error>当前身份没有本项目日程授权，不能创建或恢复运行；已有定义仍可阅读，已撤权的定义可暂停或停止。</Notice>}
      {!loading && !error && schedules.length === 0 && <p className="empty">还没有日程。这里不会自行启动定时任务。</p>}
      {schedules.map(schedule => <ScheduleCard key={`${schedule.id}:${schedule.version}`} definition={schedule} context={context} refresh={refresh} grants={status?.grants ?? []} />)}
    </section>
    <section className="panel"><details className="workflow-detail" open={schedules.length === 0}><summary>创建有限日程</summary>
      <Notice>支持一次、固定间隔、每天当地时间；暂不支持任意 cron 表达式。授权范围和到期时间需与协调器实际许可一致。</Notice>
      {status && status.grants.length > 0 ? <ActionForm context={context} review title="创建日程" fields={fields(status.grants).filter(field => field.name !== "state")} build={v => ({ type: "schedule.create", scheduleId: crypto.randomUUID(), revisionId: crypto.randomUUID(), watermarkUtc: new Date().toISOString(), ...fromValues({...v,state:"active"}, context,status.grants), state: "active" })} />
        : <p>取得本项目明确授权后才能创建日程。</p>}
    </details></section>
  </div>;
}

function ScheduleCard({ definition, context, refresh, grants }: { definition: ScheduleDefinition; context: MutationContext; refresh: number; grants: SchedulingGrant[] }) {
  const [history, setHistory] = useState<{ revisions: ScheduleRevision[]; occurrences: Occurrence[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const target = definition.revision.template.managedTarget;
  const [targetRead, setTargetRead] = useState<{ state: "checking" | "verified" | "invalid"; reason?: string;
    stageName?: string; loopState?: string; goalId?: string }>(() => ({ state: target ? "checking" : "verified" }));
  useEffect(() => {
    if (!target) { setTargetRead({ state: "verified" }); return; }
    let active = true;
    setTargetRead({ state: "checking" });
    const client = orchestrationClient(context.token, context.projectId);
    void Promise.all([client.loop(target.loopId), client.stage(target.stageId)])
      .then(([loop,stage]) => {
        if (!active) return;
        const reason = managedTargetProblem(context.projectId, definition, loop, stage);
        setTargetRead(reason ? { state: "invalid", reason } : { state: "verified", stageName: stage.deliverable, loopState: loop.state, goalId: loop.goalId });
      })
      .catch(cause => { if (active) setTargetRead({ state: "invalid", reason: `目标读回失败：${errorText(cause)}` }); });
    return () => { active = false; };
  }, [context.token, context.projectId, definition, target?.loopId, target?.stageId]);
  async function readHistory() {
    setBusy(true); setError("");
    try {
      const client = schedulingClient(context.token, context.projectId);
      const [revisions, occurrences] = await Promise.all([client.revisions(definition.id), client.occurrences(definition.id)]);
      setHistory({ revisions, occurrences });
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  useEffect(() => { setHistory(null); }, [refresh, definition.version]);
  const revision = definition.revision;
  return <details className="workflow-detail"><summary>{revision.template.title} <span className="pill">{stateLabel[definition.state]} · v{definition.version}</span></summary>
    <dl><div><dt>规则</dt><dd>{ruleText(revision.rule)} · {revision.timezone}</dd></div>
      <div><dt>错过</dt><dd>{revision.misfire.kind === "bounded" ? `最多补做 ${revision.misfire.maxCatchUp} 次` : revision.misfire.kind === "latest" ? "只取最近一次" : "跳过"}</dd></div>
      <div><dt>重叠</dt><dd>{revision.overlap === "queue" ? "排队" : "跳过"}</dd></div>
      <div><dt>新任务正文</dt><dd><MarkdownBody source={revision.template.content} identity={`schedule-${revision.id}`} projectId={context.projectId} /><p>验收：{revision.template.acceptance}；责任者：{revision.template.owner}；{revision.template.managedTarget ? "受管判断合同" : revision.template.acceptanceMode === "human_required" ? "本人验收" : "独立 Agent 验收"}{revision.template.consumer ? ` · ${revision.template.consumer}` : ""}</p></dd></div>
      <div><dt>授权</dt><dd>{revision.authorization.scopeId} · 职责 {revision.authorization.roleId} · 授权人 {revision.authorization.authorizedBy} · 到期 {revision.authorization.expiresAtUtc ? stamp(revision.authorization.expiresAtUtc) : "未设"}</dd></div>
      {target && <div><dt>受管目标</dt><dd>{targetRead.state === "verified" ? `阶段产物：${targetRead.stageName} · 工作链 ${target.loopId.slice(0,8)}（${targetRead.loopState === "paused" ? "已暂停" : "运行中"}）` : targetRead.state === "checking" ? "正在核对绑定的工作链与阶段…" : "绑定暂不可核对"}
        <details><summary>核对固定目标标识</summary><p>Loop <code>{target.loopId}</code> · Stage <code>{target.stageId}</code>{targetRead.goalId && <> · Goal <code>{targetRead.goalId}</code></>}</p></details></dd></div>}
      <div><dt>已检查至</dt><dd>{stamp(definition.watermarkUtc)}</dd></div></dl>
    {target && targetRead.state === "invalid" && <Notice error>{targetRead.reason}。不能保存普通修订或恢复运行；可在下方保持原定义暂停或停止。</Notice>}
    {definition.state !== "stopped" && <details className="workflow-detail"><summary>修订规则、暂停或恢复</summary>
      <Notice>修订以当前版本为基线；已排队的旧修订时刻仍需单独核对，不会悄悄改写。</Notice>
      {targetRead.state === "verified" ? <ActionForm context={context} review title="保存日程修订" fields={fields(grants,definition)} build={v => ({ type: "schedule.revise", scheduleId: definition.id, expectedVersion: definition.version, revisionId: crypto.randomUUID(), ...fromValues(v, context,grants,definition) })} />
        : targetRead.state === "checking" ? <p>请等候固定目标核对完成，再编辑日程。</p>
          : <ActionForm context={context} review title="保持原定义并暂停或停止" fields={[
            { name: "state", label: "停用状态", kind: "select", value: definition.state === "active" ? "paused" : "stopped",
              options: [option("paused", "暂停"), option("stopped", "停止（不能恢复）")] }, reasonField,
          ]} build={v => suspendSchedule(definition, v.state as "paused" | "stopped", v.reason, context.principal.actorId)} />}
    </details>}
    <div className="actions"><button type="button" onClick={readHistory} disabled={busy}>{busy ? "读取中…" : "阅读修订与发生记录"}</button></div>{error && <Notice error>{error}</Notice>}
    {history && <><h3>日程修订</h3>{history.revisions.length === 0 && <p className="empty">尚无修订记录。</p>}{history.revisions.map(item => <article className="history" key={item.id}><strong>v{item.version} · {ruleText(item.rule)}</strong><p>{item.reason}</p><small>{item.actorId} · {stamp(item.createdAtUtc)}</small></article>)}
      <h3>发生记录</h3>{history.occurrences.length === 0 && <p className="empty">尚无已检查的发生时刻；定义日程不等于执行任务。</p>}{history.occurrences.map(item => <article className="decision" key={`${item.revisionId}:${item.plannedAtUtc}`}><strong>{stamp(item.plannedAtUtc)} · {item.state === "created" ? "已创建待办任务" : item.state === "queued" ? "等待排队" : "已跳过"}</strong><p>{item.reason}</p>{item.taskId && <p>任务：<a href={`#/p/${encodeURIComponent(context.projectId)}/tasks/${encodeURIComponent(item.taskId)}`}>阅读此任务</a> · <code>{item.taskId}</code></p>}<small>操作 {item.operationId}</small></article>)}
    </>}
  </details>;
}
