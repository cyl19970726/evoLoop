import { useEffect, useRef, useState } from "react";
import type { MisfirePolicy, Occurrence, ScheduleDefinition, ScheduleRevision, ScheduleRule } from "@evoloop/contracts/scheduling";
import { errorText } from "../api";
import { ActionForm, Notice, option, reasonField, type Field, type MutationContext } from "../workflow/ActionForm";
import { schedulingClient, type SchedulingGrant, type SchedulingStatus } from "./client";
import { MarkdownBody } from "../ui/MarkdownBody";
import { orchestrationClient } from "../orchestration/client";
import { managedTargetProblem, scheduleTemplate, suspendSchedule } from "./managedTarget";

import { scheduleRuleLabel, latestOccurrence, occurrenceLabel, scheduleReadView, utcInstant } from "./presentation";
import "./scheduling.css";

const stamp = utcInstant;
const stateLabel = { active: "已启用", paused: "已暂停", stopped: "已停止" } as const;
const grantKey = (grant: Pick<SchedulingGrant,"scopeId"|"roleId">) => JSON.stringify([grant.scopeId,grant.roleId]);
function fields(grants: SchedulingGrant[], definition?: ScheduleDefinition, fresh = true): Field[] {
  const revision = definition?.revision;
  const rule = revision?.rule;
  const oldGrant = revision?.authorization;
  const currentGrant = oldGrant && grants.some(grant => grantKey(grant) === grantKey(oldGrant));
  const canActivate = grants.length > 0;
  const choices = [...grants.map(grant => option(grantKey(grant), `${grant.scopeId} · 职责 ${grant.roleId}${fresh ? "" : "（上次读回，当前待核对）"}`)),
    ...(oldGrant && !currentGrant ? [option(grantKey(oldGrant), `${oldGrant.scopeId} · 职责 ${oldGrant.roleId}（${fresh ? "授权已撤回，仅能暂停或停止" : "登记的旧授权，当前待核对"}）`)] : [])];
  return [
    { name: "state", label: "日程状态", kind: "select", value: definition?.state === "active" && !currentGrant ? "paused" : definition?.state ?? "active",
      options: [...(canActivate ? [option("active", "启用后续检查")] : []), option("paused", "暂停"), option("stopped", "停止（不能恢复）")] },
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
    { name: "grant", label: fresh ? "已配置的日程授权" : "上次读回的日程授权", kind: "select", value: oldGrant ? grantKey(oldGrant) : choices[0]?.value ?? "", options: choices,
      hint: fresh ? "仅显示当前身份在本项目的授权；已撤回的旧授权只允许暂停或停止。" : "当前授权尚未核对；此表单暂不可提交。" },
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
const ruleText = scheduleRuleLabel;
interface ScheduleSnapshot { scope: string; readKey: string; schedules: ScheduleDefinition[]; status: SchedulingStatus; observedAt: string }

export function SchedulingPanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const scope = JSON.stringify([context.token, context.projectId, context.principal.actorId]);
  const readKey = JSON.stringify([scope, refresh]);
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot | null>(null);
  const [readState, setReadState] = useState({ readKey, loading: true, error: "" });
  const { value, loading, error, fresh } = scheduleReadView(snapshot, scope, readKey, readState);
  const schedules = value?.schedules ?? [];
  const status = value?.status ?? null;
  const formContext = { ...context, blocked: context.blocked || !fresh };
  useEffect(() => {
    let active = true; setReadState({ readKey, loading: true, error: "" });
    const client = schedulingClient(context.token, context.projectId);
    Promise.all([client.list(),client.status()])
      .then(([items,nextStatus]) => {
        if (!active) return;
        if (items.some(item => item.projectId !== context.projectId || item.revision.projectId !== context.projectId ||
          item.revision.scheduleId !== item.id || item.currentRevisionId !== item.revision.id) ||
          nextStatus.grants.some(grant => grant.projectId !== context.projectId || grant.actorId !== context.principal.actorId))
          throw new Error("日程或授权响应与当前项目及身份不符");
        setSnapshot({ scope, readKey, schedules: items, status: nextStatus, observedAt: new Date().toISOString() });
      })
      .catch(cause => { if (active) setReadState({ readKey, loading: false, error: errorText(cause) }); })
      .finally(() => { if (active) setReadState(previous => previous.readKey === readKey ? { ...previous, loading: false } : previous); });
    return () => { active = false; };
  }, [context.token, context.projectId, context.principal.actorId, refresh, scope, readKey]);
  return <div className="journey-board schedule-page">
    <section className="panel"><div className="panel-head"><h2>检查安排</h2><button type="button" onClick={context.onChanged}>回读当前状态</button></div>
      <p>日程只按授权范围创建待办任务；生成后仍需在任务详情核对责任、计划、依赖、开始与执行。</p>
      <p className="schedule-read-scope" role="status">{value ? `本项目日程与当前身份授权读于 ${stamp(value.observedAt)}；已读 ${schedules.length} 项。${fresh ? "" : "以下保留上次读回，授权与后续触发待核对。"}`
        : loading ? "正在读取本项目日程与当前身份授权…" : "本项目日程与当前身份授权尚未读回。"}</p>
      {loading && <p>正在重新核对日程与授权…</p>}{error && <Notice error>日程与授权本次未读完整：{error}。{value ? "旧定义仅供阅读，保存与创建已暂停。" : "请重试读取。"}</Notice>}
      {status && <Notice error={["disabled","unavailable","no-authority","error","stopped"].includes(status.state)}>
        {fresh ? "协调器状态" : "上次读回的协调器状态"}：{({ idle:"待检查",running:"检查中",disabled:"未启用",unavailable:"不可用", "no-authority":"没有可运行授权",error:"检查失败",stopped:"已停止" } as Record<SchedulingStatus["state"],string>)[status.state]}
        {status.lastTickAt ? ` · 最近检查 ${stamp(status.lastTickAt)}` : " · 尚无成功检查时刻"}
        {status.lastError ? ` · ${status.lastError}` : ""}
      </Notice>}
      {fresh && status && status.grants.length === 0 && <p className="schedule-permission" role="status">当前身份没有日程创建或恢复授权；已有安排可阅读，已撤权定义仍可暂停或停止。</p>}
      {!loading && !error && schedules.length === 0 && <p className="empty">还没有日程。这里不会自行启动定时任务。</p>}
      {schedules.map(schedule => <ScheduleCard key={`${schedule.id}:${schedule.version}`} definition={schedule} context={formContext} grants={status?.grants ?? []} fresh={fresh} />)}
    </section>
    <section className="panel"><details className="workflow-detail" open={schedules.length === 0}><summary>创建有限日程</summary>
      <Notice>支持一次、固定间隔、每天当地时间；暂不支持任意 cron 表达式。授权范围和到期时间需与协调器实际许可一致。</Notice>
      {status && status.grants.length > 0 ? <><p className="schedule-read-scope">{fresh ? "授权已读回。" : "以下为上次读回的授权；重新核对完成前不可提交。"}</p><ActionForm context={{ ...formContext, draftScope: "schedule:create", draftBaseline: JSON.stringify(status.grants.map(grant => grantKey(grant)).sort()) }} review title="创建日程" fields={fields(status.grants, undefined, fresh).filter(field => field.name !== "state")} build={v => ({ type: "schedule.create", scheduleId: crypto.randomUUID(), revisionId: crypto.randomUUID(), watermarkUtc: new Date().toISOString(), ...fromValues({...v,state:"active"}, context,status.grants), state: "active" })} /></>
        : <p>{loading ? "正在核对当前身份的创建授权。" : "取得本项目明确授权后才能创建日程。"}</p>}
    </details></section>
  </div>;
}

function ScheduleCard({ definition, context, grants, fresh }: { definition: ScheduleDefinition; context: MutationContext; grants: SchedulingGrant[]; fresh: boolean }) {
  const historyScope = JSON.stringify([context.token, context.projectId, definition.id, definition.version]);
  const [historySnapshot, setHistorySnapshot] = useState<{ scope: string; revisions: ScheduleRevision[]; occurrences: Occurrence[] } | null>(null);
  const history = historySnapshot?.scope === historyScope ? historySnapshot : null;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const historyEpoch = useRef(0);
  const [historyReadAt, setHistoryReadAt] = useState<string | null>(null);
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
    const epoch = ++historyEpoch.current;
    setBusy(true); setError("");
    try {
      const client = schedulingClient(context.token, context.projectId);
      const [revisions, occurrences] = await Promise.all([client.revisions(definition.id), client.occurrences(definition.id)]);
      if (revisions.some(item => item.projectId !== context.projectId || item.scheduleId !== definition.id) || occurrences.some(item => item.projectId !== context.projectId || item.scheduleId !== definition.id)) throw new Error("日程历史与当前对象不符");
      if (historyEpoch.current === epoch) { setHistorySnapshot({ scope: historyScope, revisions, occurrences }); setHistoryReadAt(new Date().toISOString()); }
    } catch (cause) { if (historyEpoch.current === epoch) setError(errorText(cause)); } finally { if (historyEpoch.current === epoch) setBusy(false); }
  }
  useEffect(() => { historyEpoch.current++; setHistorySnapshot(null); setHistoryReadAt(null); setBusy(false); setError(""); return () => { historyEpoch.current++; }; }, [historyScope]);
  const revision = definition.revision;
  const last = history ? latestOccurrence(history.occurrences) : null;
  const editContext = { ...context, draftScope: `schedule:${definition.id}`, draftBaseline: `${definition.version}:${definition.currentRevisionId}` };
  return <details className="workflow-detail schedule-definition" onToggle={event => { if (event.currentTarget.open && !history && !busy) void readHistory(); }}><summary>{revision.template.title} <span className="pill">{stateLabel[definition.state]} · v{definition.version}</span><small className="schedule-summary-rule">{ruleText(revision.rule, revision.timezone)}{revision.rule.kind !== "daily" && ` · ${revision.timezone}`} · 责任 {revision.template.owner}</small><small className="schedule-summary-result">{history ? `上次已读结果：${last ? occurrenceLabel(last) : "尚无发生记录"} · 读于 ${historyReadAt ? stamp(historyReadAt) : "未记录"}` : busy ? "正在核对上次发生记录…" : "上次结果尚未读回，展开核对"}</small></summary>
    {!fresh && <p className="schedule-stale-note" role="status">这是上次读回的定义；当前规则与授权正在核对或读取失败。保存、暂停和恢复暂不可用。</p>}
    <section className="schedule-current" aria-label="当前规则与上次检查"><div><span>后续触发</span><strong>{definition.state === "active" ? "按已登记规则检查，实际执行仍需协调器与授权" : definition.state === "paused" ? "已暂停后续检查" : "已停止后续检查"}</strong></div><div><span>上次已读结果</span><strong>{last ? occurrenceLabel(last) : busy ? "正在核对发生记录…" : history ? "尚无发生记录" : "发生记录待核"}</strong>{last && <small>观察于 {stamp(last.observedAtUtc)} · {last.reason}</small>}{last?.taskId && <a href={`#/p/${encodeURIComponent(context.projectId)}/tasks/${encodeURIComponent(last.taskId)}`}>查看生成的任务 →</a>}</div></section>
    <p className="schedule-scope">暂停/停止只影响未来触发，已经生成的Task、在途Run与Session各有自己的状态。</p>
    <dl><div><dt>规则</dt><dd>{ruleText(revision.rule, revision.timezone)}{revision.rule.kind !== "daily" && ` · 日程定义时区 ${revision.timezone}`}</dd></div>
      <div><dt>错过</dt><dd>{revision.misfire.kind === "bounded" ? `最多补做 ${revision.misfire.maxCatchUp} 次` : revision.misfire.kind === "latest" ? "只取最近一次" : "跳过"}</dd></div>
      <div><dt>重叠</dt><dd>{revision.overlap === "queue" ? "排队" : "跳过"}</dd></div>
      <div><dt>触发材料</dt><dd><details className="schedule-material"><summary>阅读触发时使用的完整任务材料</summary><MarkdownBody source={revision.template.content} identity={`schedule-${revision.id}`} projectId={context.projectId} /><p>验收：{revision.template.acceptance}；责任者：{revision.template.owner}；{revision.template.managedTarget ? "受管判断合同" : revision.template.acceptanceMode === "human_required" ? "本人验收" : "独立 Agent 验收"}{revision.template.consumer ? ` · ${revision.template.consumer}` : ""}</p></details></dd></div>
      <div><dt>授权</dt><dd>{revision.authorization.scopeId} · 职责 {revision.authorization.roleId} · 授权人 {revision.authorization.authorizedBy} · 到期 {revision.authorization.expiresAtUtc ? stamp(revision.authorization.expiresAtUtc) : "未设"}</dd></div>
      {target && <div><dt>受管目标</dt><dd>{targetRead.state === "verified" ? `阶段产物：${targetRead.stageName} · 工作链 ${target.loopId.slice(0,8)}（${({active:"可运行",paused:"已暂停",stopped:"已停止"} as Record<string,string>)[targetRead.loopState ?? ""] ?? "状态未核"}）` : targetRead.state === "checking" ? "正在核对绑定的工作链与阶段…" : "绑定暂不可核对"}
        <details><summary>核对固定目标标识</summary><p>Loop <code>{target.loopId}</code> · Stage <code>{target.stageId}</code>{targetRead.goalId && <> · Goal <code>{targetRead.goalId}</code></>}</p></details></dd></div>}
      <div><dt>规则核对水位</dt><dd>{stamp(definition.watermarkUtc)}</dd></div></dl>
    {target && targetRead.state === "invalid" && <Notice error>{targetRead.reason}。不能保存普通修订或恢复运行；可在下方保持原定义暂停或停止。</Notice>}
    {definition.state !== "stopped" && <details className="workflow-detail"><summary>修订规则、暂停或恢复</summary>
      <Notice>修订以当前版本为基线；已排队的旧修订时刻仍需单独核对，不会悄悄改写。</Notice>
      {targetRead.state === "verified" ? <ActionForm context={editContext} review title="保存日程修订" fields={fields(grants,definition,fresh)} build={v => ({ type: "schedule.revise", scheduleId: definition.id, expectedVersion: definition.version, revisionId: crypto.randomUUID(), ...fromValues(v, context,grants,definition) })} />
        : targetRead.state === "checking" ? <p>请等候固定目标核对完成，再编辑日程。</p>
          : <ActionForm context={editContext} review title="保持原定义并暂停或停止" fields={[
            { name: "state", label: "停用状态", kind: "select", value: definition.state === "active" ? "paused" : "stopped",
              options: [option("paused", "暂停"), option("stopped", "停止（不能恢复）")] }, reasonField,
          ]} build={v => suspendSchedule(definition, v.state as "paused" | "stopped", v.reason, context.principal.actorId)} />}
    </details>}
    <div className="actions"><button type="button" onClick={readHistory} disabled={busy}>{busy ? "读取中…" : "阅读修订与发生记录"}</button></div>{error && <Notice error>{error}</Notice>}
    {history && <><p className="schedule-history-time">本定义 v{definition.version} 的发生记录读于 {historyReadAt ? stamp(historyReadAt) : "未核"}{error || !fresh ? " · 保留上次读回" : ""}。生成Task不等于Run已执行或交付验收。</p><details className="schedule-revisions"><summary>日程修订 · {history.revisions.length} 版已读</summary>{history.revisions.length === 0 && <p className="empty">尚无修订记录。</p>}{history.revisions.map(item => <article className="history" key={item.id}><strong>v{item.version} · {ruleText(item.rule, item.timezone)}</strong><p>{item.reason}</p><small>{item.actorId} · {stamp(item.createdAtUtc)}</small></article>)}
      </details><h3>发生记录</h3>{history.occurrences.length === 0 && <p className="empty">尚无已检查的发生时刻；定义日程不等于执行任务。</p>}{history.occurrences.map(item => <article className="decision" key={`${item.revisionId}:${item.plannedAtUtc}`}><strong>{stamp(item.plannedAtUtc)} · {occurrenceLabel(item)}</strong><p>{item.reason}</p>{item.taskId && <p>任务：<a href={`#/p/${encodeURIComponent(context.projectId)}/tasks/${encodeURIComponent(item.taskId)}`}>阅读此任务</a> · <code>{item.taskId}</code></p>}<small>操作 {item.operationId}</small></article>)}
    </>}
  </details>;
}
