import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClock, Plus, RefreshCw } from "lucide-react";
import { Button, EmptyState, Notice as UiNotice, cn } from "@evoloop/ui";
import { ContextPanelContent } from "../../shared/ui/ContextPanel";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { date, href } from "../../shared/ui/shared";
import type { MisfirePolicy, Occurrence, ScheduleDefinition, ScheduleRevision, ScheduleRule } from "@evoloop/contracts/scheduling";
import { errorText } from "../../shared/api";
import { ActionForm, option, reasonField, type Field, type MutationContext } from "../../shared/ActionForm";
import { schedulingClient, type SchedulingGrant, type SchedulingStatus } from "./client";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { orchestrationClient } from "../../shared/orchestrationClient";
import { managedTargetProblem, scheduleTemplate, suspendSchedule } from "./managedTarget";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { RoleName } from "../../shared/ui/RecordName";

import {
  coordinatorErrorText, grantEmptyText, latestOccurrence, nextTimeText, occurrenceLabel, occurrenceReasonKnown,
  occurrenceReasonText, scheduleReadView, scheduleRuleText, scheduleTime, zoneName,
} from "./presentation";

// Times of the schedule itself (rule instants, planned times, watermark, expiry) are said in the schedule's own zone,
// with the reader's clock added when it differs; record and read times are the reader's local time, as everywhere else.
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
const ruleText = (rule: ScheduleRule, timezone: string): string => scheduleRuleText(rule, timezone);
interface ScheduleSnapshot { scope: string; readKey: string; schedules: ScheduleDefinition[]; status: SchedulingStatus; observedAt: string }

const coordinatorLabel: Record<SchedulingStatus["state"], string> = {
  idle: "待检查", running: "检查中", disabled: "未启用", unavailable: "不可用", "no-authority": "没有可运行授权", error: "检查失败", stopped: "已停止",
};
const stateTone: Record<ScheduleDefinition["state"], string> = { active: "bg-accent text-foreground", paused: "bg-warning-soft text-foreground", stopped: "bg-field text-muted-foreground" };
const muted = "text-caption text-muted-foreground";
// The shared command forms keep their old markup (ActionForm, rebuilt separately) under data-legacy until then.
const legacy = (label: string, children: ReactNode) => <SectionBoundary label={label}><div data-legacy="" className="workbench-layout">{children}</div></SectionBoundary>;

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="flex flex-col gap-2">{rows.map(([label, value]) => <div key={label} className="flex flex-col gap-0.5">
    <dt className={muted}>{label}</dt><dd className="m-0 break-words text-small text-foreground">{value}</dd>
  </div>)}</dl>;
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <h2 className="text-label font-semibold text-foreground">{title}</h2>{children}
  </section>;
}

function CoordinatorFacts({ status, fresh, loading, projectId }: { status: SchedulingStatus | null; fresh: boolean; loading: boolean; projectId: string }) {
  if (!status) return <p className={muted}>{loading ? "正在读取协调器状态与授权…" : "协调器状态尚未读回。"}</p>;
  return <div className="flex flex-col gap-2">
    {!fresh && <p className={muted} role="status">以下为上次读回，当前待核对{loading ? "（正在重新读取）" : "（重新读取失败）"}。</p>}
    <Facts rows={[
      ["协调器", coordinatorLabel[status.state]],
      ["最近检查", status.lastTickAt ? date(status.lastTickAt) : "尚无成功检查时刻"],
      ...status.lastError ? [["最近错误", coordinatorErrorText] as [string, ReactNode]] : [],
      ["当前身份的日程授权", status.grants.length
        ? <>{status.grants.map((grant, index) => <span key={grantKey(grant)}>{index ? "、" : ""}按职责“<RoleName projectId={projectId} roleId={grant.roleId} />”授权</span>)}</>
        : grantEmptyText({ fresh, loading })],
    ]} />
    <FullIdentifiers rows={[
      ...status.grants.flatMap(grant => [{ label: "授权范围", value: grant.scopeId }, { label: "授权职责", value: grant.roleId }]),
      { label: "最近错误原文", value: status.lastError, text: true },
    ]} />
  </div>;
}

export function SchedulingPanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const scope = JSON.stringify([context.token, context.projectId, context.principal.actorId]);
  const readKey = JSON.stringify([scope, refresh]);
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot | null>(null);
  const [readState, setReadState] = useState({ readKey, loading: true, error: "" });
  const { value, loading, error, fresh } = scheduleReadView(snapshot, scope, readKey, readState);
  const schedules = value?.schedules ?? [];
  const status = value?.status ?? null;
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [lastResults, setLastResults] = useState<Record<string, string>>({});
  const selectedSchedule = schedules.find(item => item.id === selectedScheduleId) ?? schedules[0];
  const formContext = { ...context, blocked: context.blocked || !fresh };
  useEffect(() => {
    let active = true; setReadState({ readKey, loading: true, error: "" }); setLastResults({});
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
  const showCreate = creating || (!!value && schedules.length === 0);
  const select = (id: string) => { setSelectedScheduleId(id); setCreating(false); };
  const listItem = (schedule: ScheduleDefinition) => {
    const selected = !showCreate && selectedSchedule?.id === schedule.id;
    return <button type="button" key={schedule.id} aria-current={selected ? "true" : undefined} onClick={() => select(schedule.id)}
      className={cn("schedule-item flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left outline-none focus-visible:shadow-[var(--focus-ring)]",
        selected ? "bg-raised shadow-sm" : "hover:bg-selected")}>
      <span className={cn("truncate text-small", selected ? "font-medium text-foreground" : "text-foreground")}>{schedule.revision.template.title}</span>
      <span className="truncate text-caption text-muted-foreground">{stateLabel[schedule.state]} · {ruleText(schedule.revision.rule, schedule.revision.timezone)}</span>
      <span className="truncate text-caption text-muted-foreground">{lastResults[`${schedule.id}:${schedule.version}`] ?? "上次结果尚未读回"}</span>
    </button>;
  };
  const createForm = status && status.grants.length > 0
    ? <>{!fresh && <p className={muted}>以下为上次读回的授权；重新核对完成前不可提交。</p>}{legacy("创建日程表单", <ActionForm context={{ ...formContext, draftScope: "schedule:create", draftBaseline: JSON.stringify(status.grants.map(grant => grantKey(grant)).sort()) }} review title="创建日程" fields={fields(status.grants, undefined, fresh).filter(field => field.name !== "state")} build={v => ({ type: "schedule.create", scheduleId: crypto.randomUUID(), revisionId: crypto.randomUUID(), watermarkUtc: new Date().toISOString(), ...fromValues({...v,state:"active"}, context,status.grants), state: "active" })} />)}</>
    : <p className="text-small text-text-secondary">{loading ? "正在核对当前身份的创建授权。" : "取得本项目明确授权后才能创建日程。"}</p>;
  return <div data-ui="" className="schedule-page mx-auto flex w-full max-w-[980px] flex-col gap-5 px-4 py-5 compact:px-8 compact:py-7">
    {schedules.length > 0 && <ContextRailContent>
      <nav aria-label="日程" className="flex flex-col gap-0.5 pt-2">
        <span className="px-3 pb-1.5 pt-2 text-caption text-muted-foreground">日程 · {schedules.length}</span>
        {schedules.map(listItem)}
      </nav>
    </ContextRailContent>}
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>日程</h1>
        <p className="mt-1 text-small text-text-secondary">日程只按授权范围创建待办任务；生成后仍要在任务里核对责任、计划、依赖与执行。</p>
        <p className={cn(muted, "schedule-read-scope mt-1")} role="status">{value ? `日程与当前身份授权读于 ${date(value.observedAt)}；已读 ${schedules.length} 项。${fresh ? "" : "以下保留上次读回，授权与后续触发待核对。"}`
          : loading ? "正在读取本项目日程与当前身份授权…" : "本项目日程与当前身份授权尚未读回。"}</p>
      </div>
      <div className="flex items-center gap-2">
        {schedules.length > 0 && <Button onClick={() => setCreating(true)} aria-pressed={showCreate}><Plus aria-hidden="true" />创建日程</Button>}
        <Button onClick={context.onChanged} disabled={loading}><RefreshCw aria-hidden="true" className={loading ? "animate-spin" : undefined} />回读当前状态</Button>
      </div>
    </header>
    {error && <UiNotice tone="error">日程与授权本次未读完整：{error}。{value ? "旧定义仅供阅读，保存与创建已暂停。" : "请重试读取。"}</UiNotice>}
    {status && ["disabled","unavailable","no-authority","error","stopped"].includes(status.state) && <UiNotice tone="error">{fresh ? "协调器状态" : "上次读回的协调器状态"}：{coordinatorLabel[status.state]}{status.lastError ? "，最近一次检查出错（原文在右栏的来源里）" : ""}。已登记的规则不会自行执行。</UiNotice>}
    {schedules.length > 1 && <label className="flex flex-col gap-1 desktop:hidden"><span className={muted}>切换日程</span>
      <select className="h-9 rounded-md bg-field px-3 text-small text-foreground" value={showCreate ? "" : selectedSchedule?.id ?? ""} onChange={event => select(event.target.value)}>
        {showCreate && <option value="">正在创建新日程</option>}
        {schedules.map(schedule => <option key={schedule.id} value={schedule.id}>{schedule.revision.template.title} · {stateLabel[schedule.state]}</option>)}
      </select></label>}
    {showCreate
      ? <section aria-label="创建日程" className="flex flex-col gap-3 rounded-xl bg-raised p-4 shadow-sm compact:p-5">
        {schedules.length === 0 && !loading && !error ? <EmptyState title="还没有日程" reason="这里不会自行启动定时任务。建立日程后，协调器按规则和授权创建待办任务。" /> : <h2 className="text-heading font-semibold text-foreground">创建日程</h2>}
        <p className={muted}>支持一次、固定间隔、每天当地时间；暂不支持任意 cron 表达式。授权范围和到期时间需与协调器实际许可一致。</p>
        {createForm}
        {schedules.length > 0 && <Button variant="ghost" className="w-fit" onClick={() => setCreating(false)}>返回日程</Button>}
      </section>
      : selectedSchedule && <ScheduleCard key={`${readKey}:${selectedSchedule.id}:${selectedSchedule.version}`} definition={selectedSchedule} context={formContext} grants={status?.grants ?? []} status={status} fresh={fresh} loading={loading} onResult={(result) => setLastResults(previous => ({ ...previous, [`${selectedSchedule.id}:${selectedSchedule.version}`]: result }))} />}
    {(showCreate || !selectedSchedule) && <ContextPanelContent><div className="flex flex-col gap-4"><PanelSection title="协调器与授权"><CoordinatorFacts status={status} fresh={fresh} loading={loading} projectId={context.projectId} /></PanelSection></div></ContextPanelContent>}
  </div>;
}

function ScheduleCard({ definition, context, grants, status, fresh, loading, onResult }: { definition: ScheduleDefinition; context: MutationContext; grants: SchedulingGrant[]; status: SchedulingStatus | null; fresh: boolean; loading: boolean; onResult(result: string): void }) {
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
      if (historyEpoch.current === epoch) { const latest = latestOccurrence(occurrences); setHistorySnapshot({ scope: historyScope, revisions, occurrences }); setHistoryReadAt(new Date().toISOString()); onResult(latest ? occurrenceLabel(latest) : "尚无发生记录"); }
    } catch (cause) { if (historyEpoch.current === epoch) setError(errorText(cause)); } finally { if (historyEpoch.current === epoch) setBusy(false); }
  }
  // A new scope (token, project, definition version) drops the old history and any read still in flight, then reads
  // the new one; the epoch keeps a late answer for an older scope from landing.
  const readScope = useRef<string | null>(null);
  useEffect(() => {
    if (readScope.current !== null && readScope.current !== historyScope) {
      historyEpoch.current++; setHistorySnapshot(null); setHistoryReadAt(null); setBusy(false); setError("");
    }
    readScope.current = historyScope;
    void readHistory();
  }, [historyScope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { historyEpoch.current++; }, []);
  const revision = definition.revision;
  const last = history ? latestOccurrence(history.occurrences) : null;
  const editContext = { ...context, draftScope: `schedule:${definition.id}`, draftBaseline: `${definition.version}:${definition.currentRevisionId}` };
  const taskHref = (taskId: string) => href(context.projectId, "task", taskId);
  const created = history?.occurrences.filter(item => item.taskId) ?? [];
  // An occurrence is said in the zone of the revision that planned it.
  const zoneOf = (revisionId: string) => history?.revisions.find(item => item.id === revisionId)?.timezone ?? revision.timezone;
  const card = "flex flex-col gap-3 rounded-xl bg-raised p-4 shadow-sm compact:p-5";
  return <article className="schedule-definition flex flex-col gap-4" aria-label={revision.template.title}>
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-heading font-semibold text-foreground">{revision.template.title}</h2>
        <span className={cn("rounded-full px-2.5 py-0.5 text-caption", stateTone[definition.state])}>{stateLabel[definition.state]} · v{definition.version}</span>
      </div>
      <p className="flex items-center gap-1.5 text-small text-text-secondary"><CalendarClock size={15} aria-hidden="true" />{ruleText(revision.rule, revision.timezone)} · 责任 <RoleName projectId={context.projectId} roleId={revision.template.owner} /></p>
      <p className={muted}>上次已读结果：{last ? `${occurrenceLabel(last)} · 观察于 ${date(last.observedAtUtc)}` : busy ? "正在核对发生记录…" : history ? "尚无发生记录" : "发生记录待核"}</p>
    </header>
    {!fresh && <UiNotice tone="waiting">这是上次读回的定义；当前规则与授权正在核对或读取失败。保存、暂停和恢复暂不可用。</UiNotice>}
    {target && targetRead.state === "invalid" && <UiNotice tone="error">{targetRead.reason}。不能保存普通修订或恢复运行；可在下方保持原定义暂停或停止。</UiNotice>}
    <section aria-label="检查目的与任务材料" className={card}>
      <h3 className="text-label font-semibold text-foreground">检查目的与任务材料</h3>
      <Facts rows={[["每次创建的任务", revision.template.title], ["验收", revision.template.acceptance], ["责任", <RoleName projectId={context.projectId} roleId={revision.template.owner} />],
        ["验收方式", revision.template.managedTarget ? "受管判断合同" : revision.template.acceptanceMode === "human_required" ? "必须本人验收" : "独立智能体验收"],
        ...revision.template.managedTarget ? [] : [["指定验收身份", revision.template.consumer ? "已指定，身份见下方来源" : "未指定"] as [string, ReactNode]]]} />
      <details className="text-small"><summary className="cursor-pointer text-text-secondary">阅读触发时使用的完整任务材料</summary>
        <div className="mt-2"><SectionBoundary label="任务材料"><MarkdownBody className="text-small" source={revision.template.content} identity={`schedule-${revision.id}`} projectId={context.projectId} /></SectionBoundary></div>
      </details>
      <FullIdentifiers summary="来源与完整标识（含固定目标）" rows={[
        { label: "日程", value: definition.id }, { label: "当前修订", value: definition.currentRevisionId },
        { label: "责任职责", value: revision.template.owner }, { label: "指定验收身份", value: revision.template.consumer },
        ...target ? [{ label: "受管工作链", value: target.loopId }, { label: "受管阶段", value: target.stageId },
          { label: "所属目标", value: targetRead.goalId ?? (targetRead.state === "checking" ? "正在核对" : "未能读回") }] : [],
      ]} />
    </section>
    <section aria-label="发生记录" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-label font-semibold text-foreground">发生记录</h3>
        <Button size="compact" variant="ghost" onClick={() => void readHistory()} disabled={busy}>{busy ? "读取中…" : "重新读取记录"}</Button>
      </div>
      {error && <UiNotice tone="error">{error}</UiNotice>}
      {history ? <>
        <p className={muted}>本定义 v{definition.version} 的记录读于 {historyReadAt ? date(historyReadAt) : "未核"}{error || !fresh ? " · 保留上次读回" : ""}。生成任务不等于已执行，也不等于已验收。</p>
        {history.occurrences.length === 0 ? <p className="text-small text-text-secondary">尚无已检查的发生时刻；定义日程不等于执行任务。</p>
          : <ol className="flex flex-col">{[...history.occurrences].reverse().map(item => <li key={`${item.revisionId}:${item.plannedAtUtc}`} className="flex flex-col gap-0.5 border-t border-border py-2.5 first:border-t-0">
            <span className="text-small font-medium text-foreground">{scheduleTime(item.plannedAtUtc, zoneOf(item.revisionId))} · {occurrenceLabel(item)}</span>
            <span className="text-small text-text-secondary">{occurrenceReasonText(item.reason)}</span>
            {item.taskId && <a href={taskHref(item.taskId)} className="w-fit text-caption text-foreground underline">阅读此任务</a>}
            <FullIdentifiers rows={[{ label: "操作", value: item.operationId }, { label: "任务", value: item.taskId }, { label: "日程修订", value: item.revisionId },
              { label: "原因原文", value: occurrenceReasonKnown(item.reason) ? null : item.reason, text: true }]} />
          </li>)}</ol>}
        <details className="text-small"><summary className="cursor-pointer text-text-secondary">日程修订 · {history.revisions.length} 版已读</summary>
          {history.revisions.length === 0 ? <p className={cn(muted, "mt-2")}>尚无修订记录。</p> : <ol className="mt-2 flex flex-col gap-2">{history.revisions.map(item => <li key={item.id} className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground">v{item.version} · {ruleText(item.rule, item.timezone)}</span>
            <span className="text-text-secondary">{item.reason}</span><span className={muted}>修订于 {date(item.createdAtUtc)}</span>
            <FullIdentifiers rows={[{ label: "修订", value: item.id }, { label: "修订人", value: item.actorId }]} />
          </li>)}</ol>}
        </details>
      </> : <p className="text-small text-text-secondary">{busy ? "正在核对发生记录…" : "发生记录尚未读回。"}</p>}
    </section>
    {definition.state !== "stopped" && <details className={cn(card, "text-small")}>
      <summary className="cursor-pointer font-medium text-foreground">修订规则、暂停或恢复</summary>
      <p className={muted}>修订以当前版本为基线；已排队的旧修订时刻仍需单独核对，不会悄悄改写。</p>
      {targetRead.state === "verified" ? legacy("日程修订表单", <ActionForm context={editContext} review title="保存日程修订" fields={fields(grants,definition,fresh)} build={v => ({ type: "schedule.revise", scheduleId: definition.id, expectedVersion: definition.version, revisionId: crypto.randomUUID(), ...fromValues(v, context,grants,definition) })} />)
        : targetRead.state === "checking" ? <p className="text-text-secondary">请等候固定目标核对完成，再编辑日程。</p>
          : legacy("停用表单", <ActionForm context={editContext} review title="保持原定义并暂停或停止" fields={[
            { name: "state", label: "停用状态", kind: "select", value: definition.state === "active" ? "paused" : "stopped",
              options: [option("paused", "暂停"), option("stopped", "停止（不能恢复）")] }, reasonField,
          ]} build={v => suspendSchedule(definition, v.state as "paused" | "stopped", v.reason, context.principal.actorId)} />)}
    </details>}
    <p className={muted}>暂停或停止只影响以后的触发；已经生成的任务、在途运行和智能体各有自己的状态。</p>
    <ContextPanelContent>
      <div className="schedule-panel flex flex-col gap-4">
        <PanelSection title="触发条件">
          <Facts rows={[
            ["规则", ruleText(revision.rule, revision.timezone)],
            ["时区", zoneName(revision.timezone) === revision.timezone ? revision.timezone : `${zoneName(revision.timezone)}（${revision.timezone}）`],
            ["错过时刻", revision.misfire.kind === "bounded" ? `最多补做 ${revision.misfire.maxCatchUp} 次` : revision.misfire.kind === "latest" ? "只取最近一次" : "跳过"],
            ["上次任务未结束时", revision.overlap === "queue" ? "排队待核对" : "跳过新时刻"],
            ["规则核对水位", scheduleTime(definition.watermarkUtc, revision.timezone)],
          ]} />
        </PanelSection>
        <PanelSection title="下次时间">
          <p className="text-small text-foreground">{definition.state !== "active" ? (definition.state === "paused" ? "已暂停，以后不触发" : "已停止，以后不触发") : nextTimeText(revision.rule, revision.timezone, Date.now(), value => scheduleTime(value, revision.timezone))}</p>
          {definition.state === "active" && <p className={muted}>是否真的创建任务，取决于协调器、授权以及错过和重叠的处理方式。</p>}
        </PanelSection>
        <PanelSection title="产生的任务">
          {created.length ? <ul className="flex flex-col gap-1.5">{[...created].reverse().slice(0, 6).map(item => <li key={`${item.revisionId}:${item.plannedAtUtc}`} className="flex flex-col">
            <a href={taskHref(item.taskId!)} className="truncate text-small text-foreground hover:underline">{scheduleTime(item.plannedAtUtc, zoneOf(item.revisionId))} 的任务</a>
            <span className={muted}>{occurrenceLabel(item)}</span>
          </li>)}</ul> : <p className={muted}>{history ? "这个日程还没有创建过任务。" : "发生记录尚未读回。"}</p>}
        </PanelSection>
        <PanelSection title="授权与协调器">
          <Facts rows={[
            ["日程授权", <>按职责“<RoleName projectId={context.projectId} roleId={revision.authorization.roleId} />”授权</>],
            ["到期", revision.authorization.expiresAtUtc ? scheduleTime(revision.authorization.expiresAtUtc, revision.timezone) : "未设"],
            ...target ? [["受管目标", targetRead.state === "verified" ? `阶段产物：${targetRead.stageName}（工作链${({ active: "可运行", paused: "已暂停", stopped: "已停止" } as Record<string, string>)[targetRead.loopState ?? ""] ?? "状态未核"}）` : targetRead.state === "checking" ? "正在核对绑定的工作链与阶段…" : "绑定暂不可核对"] as [string, ReactNode]] : [],
          ]} />
          <FullIdentifiers rows={[{ label: "授权范围", value: revision.authorization.scopeId }, { label: "授权职责", value: revision.authorization.roleId },
            { label: "授权人", value: revision.authorization.authorizedBy }]} />
          <CoordinatorFacts status={status} fresh={fresh} loading={loading} projectId={context.projectId} />
        </PanelSection>
      </div>
    </ContextPanelContent>
  </article>;
}
