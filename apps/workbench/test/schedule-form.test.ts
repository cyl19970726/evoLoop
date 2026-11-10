// 创建日程 / 保存日程修订: the person picks the role and the grant by name and types times on the schedule's own clock,
// and the command carries exactly what the old form (role ID, grant ID, UTC ISO times) sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleCommands, type MisfirePolicy, type ScheduleDefinition, type ScheduleRule } from "@evoloop/contracts/scheduling";
import type { SchedulingGrant } from "../src/features/scheduling/client.ts";
import { scheduleTemplate } from "../src/features/scheduling/managedTarget.ts";
import { grantKey, grantLabels, scheduleCommandValues, scheduleFields, withMemberChoice, type ScheduleRoleNames } from "../src/features/scheduling/scheduleForm.ts";
import { toFormField } from "../src/shared/ActionForm.tsx";
import { fieldLabel, missingFields } from "../src/shared/command/CommandForm.tsx";

const id = (n: number) => `43000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2), otherRole = id(3), scheduleId = id(4);
const grant: SchedulingGrant = { projectId, actorId: "reader", scopeId: "acceptance-schedules", roleId };
const second: SchedulingGrant = { projectId, actorId: "reader", scopeId: "night-checks", roleId };
const names: ScheduleRoleNames = { roles: [{ id: roleId, title: "巡检职责" }, { id: otherRole, title: "发布职责" }], rolesProblem: null,
  roleName: value => ({ [roleId]: "巡检职责", [otherRole]: "发布职责" } as Record<string, string>)[value] ?? null };
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-/;

/** The form before this change (SchedulingPanel fromValues on main), kept verbatim as the oracle for the command. */
function legacyFromValues(values: Record<string, string>, actorId: string, grants: SchedulingGrant[], definition?: ScheduleDefinition) {
  const legacyKey = (item: Pick<SchedulingGrant, "scopeId" | "roleId">) => JSON.stringify([item.scopeId, item.roleId]);
  const grant = grants.find(item => legacyKey(item) === values.grant);
  const old = definition?.revision.authorization;
  const usingRevokedOldGrant = !grant && !!old && legacyKey(old) === values.grant && values.state !== "active";
  if (!grant && !usingRevokedOldGrant) throw new Error("当前身份没有所选日程授权；不能创建或恢复运行。");
  const rule: ScheduleRule = values.ruleKind === "interval" ? { kind: "interval", anchorUtc: new Date(values.anchorUtc!).toISOString(), everyMinutes: Number(values.everyMinutes) }
    : values.ruleKind === "daily" ? { kind: "daily", localTime: values.localTime! }
      : { kind: "once", atUtc: new Date(values.atUtc!).toISOString() };
  const misfire: MisfirePolicy = values.misfireKind === "bounded" ? { kind: "bounded", maxCatchUp: Number(values.maxCatchUp) }
    : values.misfireKind === "skip" ? { kind: "skip" } : { kind: "latest" };
  return { state: values.state, timezone: values.timezone, rule, misfire, overlap: values.overlap,
    template: scheduleTemplate(values, definition),
    authorization: { scopeId: grant?.scopeId ?? old!.scopeId, roleId: grant?.roleId ?? old!.roleId, authorizedBy: actorId,
      expiresAtUtc: values.expiresAtUtc ? new Date(values.expiresAtUtc).toISOString() : null }, reason: values.reason };
}

const common = { state: "active", misfireKind: "bounded", maxCatchUp: "3", overlap: "queue", title: "每日巡检", content: "核对来源", acceptance: "留下报告",
  owner: roleId, acceptanceMode: "human_required", consumer: "acceptance-owner", grant: grantKey(second), reason: "开始巡检" };

test("a one-off time on the schedule's clock is sent as the UTC instant the old form asked for", () => {
  const typed = { ...common, timezone: "America/New_York", ruleKind: "once", atUtc: "2026-11-12T14:30:00Z", expiresAtUtc: "2027-01-01T04:59:00.000Z" };
  const chosen = { ...common, timezone: "America/New_York", ruleKind: "once", atLocal: "2026-11-12T09:30", expiresLocal: "2026-12-31T23:59" };
  const sent = scheduleCommandValues(chosen, "reader", [grant, second]);
  assert.deepEqual(sent, legacyFromValues(typed, "reader", [grant, second]));
  assert.deepEqual(sent.rule, { kind: "once", atUtc: "2026-11-12T14:30:00.000Z" });
  assert.deepEqual(sent.authorization, { scopeId: "night-checks", roleId, authorizedBy: "reader", expiresAtUtc: "2027-01-01T04:59:00.000Z" });
  const command = { type: "schedule.create", projectId, operationId: id(9), scheduleId, revisionId: id(5), watermarkUtc: "2026-11-10T00:00:00.000Z", ...sent, state: "active" };
  assert.equal(scheduleCommands[0].parse(command).type, "schedule.create", "the contract accepts it as before");
});

test("interval and daily rules, and an empty expiry, are sent as before", () => {
  const interval = { ...common, timezone: "Asia/Taipei", ruleKind: "interval", everyMinutes: "45", expiresAtUtc: "" };
  assert.deepEqual(scheduleCommandValues({ ...interval, anchorLocal: "2026-11-12T08:00", expiresLocal: "" }, "reader", [grant, second]),
    legacyFromValues({ ...interval, anchorUtc: "2026-11-12T00:00:00.000Z" }, "reader", [grant, second]));
  const daily = { ...common, timezone: "Europe/Berlin", ruleKind: "daily", localTime: "07:15" };
  assert.deepEqual(scheduleCommandValues(daily, "reader", [grant, second]), legacyFromValues(daily, "reader", [grant, second]));
});

test("daylight saving: a skipped time is refused before sending, a repeated one is its earlier instant as the scheduler takes it", () => {
  const base = { ...common, timezone: "America/New_York", ruleKind: "once" };
  assert.throws(() => scheduleCommandValues({ ...base, atLocal: "2027-03-14T02:30" }, "reader", [grant, second]), /仅一次的日期和时间：所选时区没有这个时刻/);
  assert.deepEqual(scheduleCommandValues({ ...base, atLocal: "2027-11-07T01:30" }, "reader", [grant, second]).rule, { kind: "once", atUtc: "2027-11-07T05:30:00.000Z" });
  assert.throws(() => scheduleCommandValues({ ...base, atLocal: "" }, "reader", [grant, second]), /请选择仅一次的日期和时间/);
});

const definition: ScheduleDefinition = { projectId, id: scheduleId, version: 3, currentRevisionId: id(6), state: "active", watermarkUtc: "2026-11-09T00:00:00.000Z",
  revision: { projectId, scheduleId, id: id(6), version: 3, timezone: "America/New_York", rule: { kind: "once", atUtc: "2027-11-07T05:30:00.000Z" },
    misfire: { kind: "latest" }, overlap: "skip",
    template: { title: "季度巡检", content: "按清单", acceptance: "报告", owner: otherRole, acceptanceMode: "independent_agent" },
    authorization: { scopeId: "acceptance-schedules", roleId, authorizedBy: "reader", expiresAtUtc: "2027-12-01T05:00:30.000Z" },
    reason: "上一版", actorId: "reader", createdAtUtc: "2026-11-09T00:00:00.000Z" } };

test("the revision form opens on the definition's own times and names; saving it untouched sends the same definition", () => {
  const fields = scheduleFields([grant, second], names, definition);
  const initial = Object.fromEntries(fields.map(field => [field.name, field.value ?? ""]));
  assert.equal(initial.timezone, "America/New_York");
  assert.equal(initial.atLocal, "2027-11-07T01:30|2027-11-07T05:30:00.000Z", "on the schedule's clock, not UTC, with the stored instant kept");
  assert.equal(initial.expiresLocal, "2027-12-01T00:00:30|2027-12-01T05:00:30.000Z");
  const values = { ...initial, reason: "改理由" };
  const typed = { ...values, atUtc: definition.revision.rule.kind === "once" ? definition.revision.rule.atUtc : "", expiresAtUtc: definition.revision.authorization.expiresAtUtc! };
  const sent = scheduleCommandValues(values, "reader", [grant, second], definition);
  assert.deepEqual(sent, legacyFromValues(typed, "reader", [grant, second], definition));
  assert.deepEqual(sent.rule, definition.revision.rule);
  assert.equal(sent.authorization.expiresAtUtc, definition.revision.authorization.expiresAtUtc);
  assert.equal(sent.template.owner, otherRole);
});

test("a revision saved without touching its times sends them as stored: the later repeated reading, milliseconds, an unknown zone", () => {
  const later: ScheduleDefinition = { ...definition, revision: { ...definition.revision, rule: { kind: "once", atUtc: "2027-11-07T06:30:00.000Z" },
    authorization: { ...definition.revision.authorization, expiresAtUtc: "2027-12-01T05:00:30.500Z" } } };
  const opened = (item: ScheduleDefinition) => Object.fromEntries(scheduleFields([grant, second], names, item).map(field => [field.name, field.value ?? ""]));
  const paused = scheduleCommandValues({ ...opened(later), state: "paused", reason: "先暂停" }, "reader", [grant, second], later);
  assert.deepEqual(paused.rule, later.revision.rule, "the later 01:30 stays the later one");
  assert.equal(paused.authorization.expiresAtUtc, "2027-12-01T05:00:30.500Z", "milliseconds are kept");
  const berlin: ScheduleDefinition = { ...definition, revision: { ...definition.revision, timezone: "Europe/Berlin", rule: { kind: "interval", anchorUtc: "2026-10-25T01:30:00.000Z", everyMinutes: 60 } } };
  assert.deepEqual(scheduleCommandValues({ ...opened(berlin), reason: "r" }, "reader", [grant, second], berlin).rule, berlin.revision.rule);
  // A zone the browser does not know: the expiry is kept, never dropped to “none”.
  const unknown: ScheduleDefinition = { ...definition, revision: { ...definition.revision, timezone: "Mars/Base", rule: { kind: "daily", localTime: "09:00" },
    authorization: { ...definition.revision.authorization, expiresAtUtc: "2026-12-31T16:00:00.000Z" } } };
  const values = opened(unknown);
  assert.notEqual(values.expiresLocal, "");
  const sent = scheduleCommandValues({ ...values, state: "paused", reason: "先暂停" }, "reader", [grant, second], unknown);
  assert.equal(sent.authorization.expiresAtUtc, "2026-12-31T16:00:00.000Z");
  assert.equal(sent.timezone, "Mars/Base");
  assert.throws(() => scheduleCommandValues({ ...values, expiresLocal: "2026-12-31T18:00", state: "paused", reason: "r" }, "reader", [grant, second], unknown),
    /授权到期时间：浏览器不认识这个时区/, "a changed time in an unknown zone is refused, not guessed");
});

test("roles and grants are offered by name; their identifiers stay in the preview's 完整标识", () => {
  const fields = scheduleFields([grant, second], names);
  const field = (name: string) => fields.find(item => item.name === name)!;
  assert.deepEqual(field("owner").options, [{ value: otherRole, label: "发布职责" }, { value: roleId, label: "巡检职责" }]);
  assert.deepEqual(field("grant").options?.map(option => option.label), ["按职责“巡检职责”授权（第 1 项）", "按职责“巡检职责”授权（第 2 项）"]);
  for (const item of fields) {
    assert.doesNotMatch(`${item.label} ${item.hint ?? ""} ${item.options?.map(option => option.label).join(" ") ?? ""}`, uuid, `${item.name} shows no raw ID`);
    assert.doesNotMatch(`${item.label} ${item.hint ?? ""}`, /UTC|ISO|IANA|Agent|\bID\b/, `${item.name} speaks the page's words`);
  }
  assert.equal(field("atLocal").kind, "custom");
  assert.equal(field("expiresLocal").kind, "custom");
  assert.equal(field("localTime").kind, "time");
  assert.equal(field("timezone").kind, "select");
  assert.ok(field("owner").preview?.({ owner: roleId }), "the chosen role's ID is one click away");
  assert.ok(field("grant").preview?.({ grant: grantKey(second) }));
});

test("a registered owner outside the choosable roles, an unread name and a revoked grant are said, not hidden", () => {
  const unread: ScheduleRoleNames = { roles: null, rolesProblem: "failed", roleName: () => null };
  const fields = scheduleFields([], unread, definition);
  const field = (name: string) => fields.find(item => item.name === name)!;
  assert.deepEqual(field("owner").options, [{ value: otherRole, label: "当前登记的职责" }]);
  assert.match(field("owner").hint ?? "", /没有读回/);
  assert.deepEqual(field("grant").options, [{ value: grantKey(definition.revision.authorization), label: "按职责“名称读取中”授权（授权已撤回，仅能暂停或停止）" }]);
  const failed = scheduleFields([], { ...unread, nameUnreadable: () => true }, definition).find(item => item.name === "grant")!;
  assert.match(failed.options?.[0]?.label ?? "", /^按职责“名称暂不可读”授权/, "a name whose read failed is not said to be on its way");
  assert.equal(field("state").value, "paused", "a revoked grant can only pause or stop");
  const outside = scheduleFields([grant], { ...names, roles: [{ id: roleId, title: "巡检职责" }] }, definition).find(item => item.name === "owner")!;
  assert.deepEqual(outside.options?.[0], { value: otherRole, label: "发布职责（不在可选职责中）" });
  assert.deepEqual([...grantLabels([grant], names).values()], ["按职责“巡检职责”授权"]);
});

test("指定验收人 is optional for 独立智能体验收 only: 必须本人验收 drops “（可选）” and needs the person, as 新建任务 does (N5)", () => {
  const field = toFormField(withMemberChoice(scheduleFields([grant], names), projectId).find(item => item.name === "consumer")!);
  assert.equal(fieldLabel(field, { acceptanceMode: "independent_agent" }), "指定验收人（可选）");
  assert.equal(fieldLabel(field, { acceptanceMode: "human_required" }), "指定验收人");
  assert.deepEqual(missingFields([field], { acceptanceMode: "independent_agent", consumer: "" }), {});
  assert.deepEqual(missingFields([field], { acceptanceMode: "human_required", consumer: "" }), { consumer: "请选择指定验收人。" });
  assert.deepEqual(missingFields([field], { acceptanceMode: "human_required", consumer: "acceptance-owner" }), {});
});
