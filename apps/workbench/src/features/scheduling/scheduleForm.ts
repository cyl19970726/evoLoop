// 创建日程 and 保存日程修订 (docs/frontend/pages/schedules.md): the fields and the command they become. The person picks the
// responsible role and the grant by name and types times on the schedule's own clock; the command carries the same
// identifiers and UTC instants as before (scheduleCommandValues), which the identifiers layer under each choice shows.
import { createElement } from "react";
import type { MisfirePolicy, ScheduleDefinition, ScheduleRule } from "@evoloop/contracts/scheduling";
import type { Field } from "../../shared/ActionForm";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { localInputIn, localInstant, localInstantPreview, readerZone, timezoneOptions } from "../../shared/zonedTime";
import type { SchedulingGrant } from "./client";
import { scheduleTemplate } from "./managedTarget";
import { nextTimeText, scheduleTime } from "./presentation";

const option = (value: string, label: string) => ({ value, label });
export const grantKey = (grant: Pick<SchedulingGrant, "scopeId" | "roleId">) => JSON.stringify([grant.scopeId, grant.roleId]);
const grantOf = (key: string | undefined): { scopeId: string; roleId: string } | null => {
  try { const [scopeId, roleId] = JSON.parse(key ?? "") as unknown[]; return typeof scopeId === "string" && typeof roleId === "string" ? { scopeId, roleId } : null; }
  catch { return null; }
};

/** Role names the form speaks in. `roles` are the roles a task can be given to (in use or on trial), by title. */
export interface ScheduleRoleNames {
  roles: { id: string; title: string }[] | null;
  /** Why `roles` is null: still reading, or the read failed. */
  rolesProblem: "reading" | "failed" | null;
  /** Any role's title (grants, the registered owner), or null while it is unread. */
  roleName(id: string): string | null;
}

const quoted = (names: ScheduleRoleNames, roleId: string) => `“${names.roleName(roleId) ?? "名称待读取"}”`;

/** "按职责“开发职责”授权", numbered when two grants name the same role. */
export function grantLabels(grants: Pick<SchedulingGrant, "scopeId" | "roleId">[], names: ScheduleRoleNames): Map<string, string> {
  const labels = new Map<string, string>();
  for (const grant of grants) {
    const same = grants.filter(item => item.roleId === grant.roleId);
    const index = same.findIndex(item => grantKey(item) === grantKey(grant));
    labels.set(grantKey(grant), `按职责${quoted(names, grant.roleId)}授权${same.length > 1 ? `（第 ${index + 1} 项）` : ""}`);
  }
  return labels;
}

function ownerOptions(names: ScheduleRoleNames, owner: string | undefined) {
  const roles = [...names.roles ?? []].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  const listed = roles.map(role => option(role.id, role.title));
  if (owner && !roles.some(role => role.id === owner))
    listed.unshift(option(owner, `${names.roleName(owner) ?? "当前登记的职责"}${names.roles ? "（不在可选职责中）" : ""}`));
  return listed;
}

const ids = (rows: { label: string; value: string | null | undefined }[]) =>
  rows.some(row => row.value) ? createElement(FullIdentifiers, { summary: "完整标识", rows }) : null;

/**
 * The fields of both forms. Times are typed on the clock of the schedule's zone (`timezone`) and previewed as they will
 * be recorded; the revision form opens on the current definition's own values.
 */
export function scheduleFields(grants: SchedulingGrant[], names: ScheduleRoleNames, definition?: ScheduleDefinition, fresh = true, now = Date.now()): Field[] {
  const revision = definition?.revision;
  const rule = revision?.rule;
  const timezone = revision?.timezone ?? readerZone();
  const oldGrant = revision?.authorization;
  const currentGrant = oldGrant && grants.some(grant => grantKey(grant) === grantKey(oldGrant));
  const canActivate = grants.length > 0;
  const labels = grantLabels(oldGrant && !currentGrant ? [...grants, oldGrant] : grants, names);
  const choices = [...grants.map(grant => option(grantKey(grant), `${labels.get(grantKey(grant))}${fresh ? "" : "（上次读回，当前待核对）"}`)),
    ...(oldGrant && !currentGrant ? [option(grantKey(oldGrant), `${labels.get(grantKey(oldGrant))}（${fresh ? "授权已撤回，仅能暂停或停止" : "登记的旧授权，当前待核对"}）`)] : [])];
  const at = (kind: ScheduleRule["kind"], name: string) => (values: Record<string, string>) =>
    values.ruleKind === kind ? localInstantPreview(values[name] ?? "", values.timezone ?? "") : null;
  return [
    { name: "state", label: "日程状态", kind: "select", value: definition?.state === "active" && !currentGrant ? "paused" : definition?.state ?? "active",
      options: [...(canActivate ? [option("active", "启用后续检查")] : []), option("paused", "暂停"), option("stopped", "停止（不能恢复）")] },
    { name: "timezone", label: "时区", kind: "select", value: timezone, options: timezoneOptions([revision?.timezone]),
      hint: "下面的日期和时间都按这个时区的当地时间填写；每天的规则也按这个时区的钟点触发。" },
    { name: "ruleKind", label: "触发方式", kind: "select", value: rule?.kind ?? "once", options: [option("once", "仅一次"), option("interval", "固定分钟间隔"), option("daily", "每天固定时刻")] },
    { name: "atLocal", label: "仅一次：日期和时间", kind: "datetime", optional: true, value: rule?.kind === "once" ? localInputIn(rule.atUtc, timezone) : "", preview: at("once", "atLocal") },
    { name: "anchorLocal", label: "间隔：从何时开始", kind: "datetime", optional: true, value: rule?.kind === "interval" ? localInputIn(rule.anchorUtc, timezone) : "", preview: at("interval", "anchorLocal") },
    { name: "everyMinutes", label: "间隔：每多少分钟", optional: true, value: rule?.kind === "interval" ? String(rule.everyMinutes) : "" },
    { name: "localTime", label: "每天：当地时刻", kind: "time", optional: true, value: rule?.kind === "daily" ? rule.localTime : "",
      preview: values => values.ruleKind === "daily" && values.localTime
        ? `下次：${nextTimeText({ kind: "daily", localTime: values.localTime }, values.timezone ?? "", now, value => scheduleTime(value, values.timezone ?? ""))}` : null },
    { name: "misfireKind", label: "错过时刻的处理", kind: "select", value: revision?.misfire.kind ?? "latest", options: [option("skip", "跳过"), option("latest", "只取最近一次"), option("bounded", "有限补做")] },
    { name: "maxCatchUp", label: "有限补做的最多次数", optional: true, value: revision?.misfire.kind === "bounded" ? String(revision.misfire.maxCatchUp) : "" },
    { name: "overlap", label: "上次任务未结束时", kind: "select", value: revision?.overlap ?? "skip", options: [option("skip", "跳过新时刻"), option("queue", "排队待核对")] },
    { name: "title", label: "新提议任务的名称", value: revision?.template.title ?? "" },
    { name: "content", label: "新任务正文（Markdown）", kind: "textarea", value: revision?.template.content ?? "", maxLength: 65536 },
    { name: "acceptance", label: "新提议任务的接受条件", kind: "textarea", value: revision?.template.acceptance ?? "" },
    { name: "owner", label: "任务负责职责", kind: "select", value: revision?.template.owner ?? "", options: ownerOptions(names, revision?.template.owner),
      hint: names.rolesProblem === "reading" ? "正在读取可选职责…" : names.rolesProblem === "failed" ? "可选职责没有读回，暂时只能保留当前登记的职责；请回读当前状态。" : "按名称选择每次生成的任务由哪个职责负责。",
      preview: values => ids([{ label: "负责职责", value: values.owner }]) },
    ...(revision?.template.managedTarget ? [] : [
      { name: "acceptanceMode", label: "任务验收方式", kind: "select" as const, value: revision?.template.acceptanceMode ?? "independent_agent",
        options: [option("independent_agent", "独立智能体验收"), option("human_required", "必须本人验收")] },
      { name: "consumer", label: "指定验收人（可选）", optional: true, value: revision?.template.consumer ?? "",
        hint: "必须本人验收时，填写验收人的登录身份；独立智能体验收可以留空。" },
    ]),
    { name: "grant", label: fresh ? "日程授权" : "上次读回的日程授权", kind: "select", value: oldGrant ? grantKey(oldGrant) : choices[0]?.value ?? "", options: choices,
      hint: fresh ? "只列出当前身份在本项目的授权；已撤回的旧授权只能用来暂停或停止。" : "当前授权尚未核对；此表单暂不可提交。",
      preview: values => { const grant = grantOf(values.grant); return ids([{ label: "授权范围", value: grant?.scopeId }, { label: "授权职责", value: grant?.roleId }]); } },
    { name: "expiresLocal", label: "授权到期", kind: "datetime", optional: true, value: localInputIn(revision?.authorization.expiresAtUtc, timezone),
      preview: values => localInstantPreview(values.expiresLocal ?? "", values.timezone ?? "") },
    { name: "reason", label: "理由与依据", kind: "textarea" },
  ];
}

function instantOf(values: Record<string, string>, name: string, what: string): string {
  if (!values[name]?.trim()) throw new Error(`请选择${what}。`);
  try { return localInstant(values[name]!, values.timezone ?? "").iso; }
  catch (cause) { throw new Error(`${what}：${cause instanceof Error ? cause.message : "日期或时间无效。"}`); }
}

/** The definition part of schedule.create and schedule.revise, from the form's values. */
export function scheduleCommandValues(values: Record<string, string>, actorId: string, grants: SchedulingGrant[], definition?: ScheduleDefinition) {
  const grant = grants.find(item => grantKey(item) === values.grant);
  const old = definition?.revision.authorization;
  const usingRevokedOldGrant = !grant && !!old && grantKey(old) === values.grant && values.state !== "active";
  if (!grant && !usingRevokedOldGrant) throw new Error("当前身份没有所选日程授权；不能创建或恢复运行。");
  const rule: ScheduleRule = values.ruleKind === "interval" ? { kind: "interval", anchorUtc: instantOf(values, "anchorLocal", "间隔的开始时间"), everyMinutes: Number(values.everyMinutes) }
    : values.ruleKind === "daily" ? { kind: "daily", localTime: values.localTime! }
      : { kind: "once", atUtc: instantOf(values, "atLocal", "仅一次的日期和时间") };
  const misfire: MisfirePolicy = values.misfireKind === "bounded" ? { kind: "bounded", maxCatchUp: Number(values.maxCatchUp) }
    : values.misfireKind === "skip" ? { kind: "skip" } : { kind: "latest" };
  return { state: values.state, timezone: values.timezone, rule, misfire, overlap: values.overlap,
    template: scheduleTemplate(values, definition),
    authorization: { scopeId: grant?.scopeId ?? old!.scopeId, roleId: grant?.roleId ?? old!.roleId, authorizedBy: actorId,
      expiresAtUtc: values.expiresLocal?.trim() ? instantOf(values, "expiresLocal", "授权到期时间") : null }, reason: values.reason };
}
