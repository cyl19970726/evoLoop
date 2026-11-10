// 分工与运行 wording and rules: managed agents group by state, only full grants create agents, and a close names
// every recorded blocker instead of being offered on an incomplete read.
import assert from "node:assert/strict";
import test from "node:test";
import type { ResidentQueue } from "@evoloop/contracts/queues";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import {
  allowedModels, closeBlockers, fullGrants, messageKindText, needsFullAccessUpgrade, permissionsText, profileText, sessionGroups, sessionTargetNotice, turnStatusText,
} from "../src/features/runtime/executionPresentation.ts";
import { roleNameOf } from "../src/features/runtime/useRoleNames.ts";
import { ApiError } from "../src/shared/api.ts";
import { preflightPresentation, preflightView } from "../src/shared/preflightPresentation.ts";

const sessionId = "40000004-0000-4000-8000-000000000004";
const roleId = "40000002-0000-4000-8000-000000000002";
const session = (overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord => ({
  projectId: "p", id: sessionId, roleId, cwd: "/w", authorizationScope: "固定任务", model: "m", sandbox: "danger-full-access", approvalPolicy: "never",
  state: "ready", version: 3, nativeThreadId: "t", nativeSessionId: "n", operationId: "o", actorId: "a", createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z", ...overrides,
});
const run = (state: RuntimeRunRecord["state"], id = "r1"): RuntimeRunRecord => ({ projectId: "p", id, taskId: "t", taskRevisionId: "t", basisSetId: "b",
  sessionId, operationId: id, input: "", inputHash: "", state, version: 1, nativeTurnId: null, interruptRequested: false, resultSummary: null,
  actorId: "a", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
const queue = (state: "queued" | "claimed" | "released"): ResidentQueue => ({ projectId: "p", id: "q", version: 1, adoptedVersion: 1, maxRuns: 3, reason: "", actorId: "a",
  entries: [{ projectId: "p", queueId: "q", id: "e", taskId: "t", taskRevisionId: "t", sourceInputJson: "{}", sessionId, roleId, position: 0, dependsOn: [],
    consumerId: "c", useRequired: true, releaseRule: "accepted", state, holdCode: null, holdReason: null, claimId: state === "claimed" ? "c" : null, version: 1 }] });

test("a ready agent with nothing in flight can be closed; every recorded blocker is named", () => {
  assert.deepEqual(closeBlockers(session(), { runsRead: true, runs: [run("completed")], queues: [queue("released")] }), []);
  assert.deepEqual(closeBlockers(session(), { runsRead: true, runs: [run("running"), run("unknown", "r2")], queues: [queue("claimed")] }), [
    "仍有在途或结果未知的运行（2 项）", "仍有队列占用或待处理条目（1 项，含 1 项已领取）",
  ]);
  assert.deepEqual(closeBlockers(session({ nativeThreadId: null }), { runsRead: false, runs: [], queues: null }), [
    "原生线程尚未绑定，无法核实归档", "运行列表未读回，不能确认没有在途运行", "队列未读回，不能确认没有占用",
  ], "an unread list is a blocker, never an empty one");
  assert.match(closeBlockers(session({ state: "closing" }), { runsRead: true, runs: [], queues: [] })[0]!, /不能重发关闭/);
  assert.match(closeBlockers(session({ state: "reserved" }), { runsRead: true, runs: [], queues: [] })[0]!, /只有就绪的智能体可以请求关闭/);
});

test("agents group by state, newest first, and permissions read as words", () => {
  const groups = sessionGroups([session({ id: "a", state: "closed" }), session({ id: "b" }), session({ id: "c", state: "unknown" }), session({ id: "d", state: "creating" })]);
  assert.deepEqual(groups.map(group => [group.label, group.items.map(item => item.id)]), [["就绪", ["b"]], ["准备中", ["d"]], ["需要核对", ["c"]], ["已关闭", ["a"]]]);
  assert.equal(permissionsText("read-only", "on-request"), "只读 · 按需审批");
});

test("only full-access grants create agents, and only models the grant and the catalog both allow", () => {
  const grant = { projectId: "p", actorId: "a", roleId, authorizationScope: "s", cwd: "/w", sandbox: "danger-full-access" as const, approvalPolicy: "never" as const, networkAccess: true, models: ["x", "y"] };
  assert.equal(fullGrants([grant, { ...grant, networkAccess: false }, { ...grant, sandbox: "workspace-write" }]).length, 1);
  assert.equal(fullGrants([grant], "other-role").length, 0);
  assert.deepEqual(allowedModels(grant, ["y", "z", "x"]), ["y", "x"]);
  assert.deepEqual(allowedModels({ ...grant, models: [] }, ["x"]), []);
});

test("the execution profile and the old full-access upgrade follow the recorded activation", () => {
  const profile = (activationState: "active" | "pending" | "unknown", activeRevisionId: string | null) => ({
    revision: { revisionId: "rev", version: 2, sandbox: "read-only", approvalPolicy: "on-request", model: "m" }, activationState, activeRevisionId,
  }) as unknown as RuntimeSessionRecord["executionProfile"];
  const label = (state: string) => state === "pending" ? "待激活" : state;
  assert.match(profileText(session({ executionProfile: profile("active", "rev") }), label), /目标执行配置 v2：只读 · 按需审批.*此修订已登记激活/);
  assert.match(profileText(session({ executionProfile: profile("pending", "old") }), label), /待激活。目标修订尚未确认激活/);
  assert.match(profileText(session(), label), /未读到执行配置修订/);
  assert.equal(needsFullAccessUpgrade(session({ executionProfile: profile("active", "rev") })), true);
  assert.equal(needsFullAccessUpgrade(session({ executionProfile: profile("unknown", "rev") })), false);
});

test("a Role name shows only after its own read succeeds; a free-text owner is shown as written", () => {
  assert.deepEqual(roleNameOf("acceptance-owner", undefined), { fallback: "acceptance-owner" });
  assert.equal(roleNameOf(roleId, { title: "开发流程", pending: false }).title, "开发流程");
  assert.equal(roleNameOf(roleId, { pending: true }).fallback, "职责（名称待读取）");
  assert.equal(roleNameOf(roleId, { error: new ApiError(404, "x"), pending: false }).fallback, "职责（未找到）");
  assert.equal(roleNameOf(roleId, { error: new ApiError(503, "x"), pending: false }).fallback, "职责（名称暂不可读）");
  assert.doesNotMatch(JSON.stringify(roleNameOf(roleId, { pending: true })), /40000002/, "never the identifier's first characters");
});

test("a linked agent is located, unreadable or absent — 没有 only after the list was read back", () => {
  assert.deepEqual(sessionTargetNotice({ valid: true, reading: true, error: "" }).tone, "info");
  assert.equal(sessionTargetNotice({ valid: true, reading: true, error: "" }).title, "正在定位");
  assert.equal(sessionTargetNotice({ valid: true, reading: false, error: "503" }).title, "无法定位");
  assert.doesNotMatch(sessionTargetNotice({ valid: true, reading: false, error: "503" }).text, /没有这个|未读到/);
  assert.equal(sessionTargetNotice({ valid: true, reading: false, error: "" }).title, "没有这个智能体");
  assert.equal(sessionTargetNotice({ valid: false, reading: false, error: "" }).title, "链接无效");
});

test("thread history and refused dispatches read as words; codes and source IDs go to 完整标识", () => {
  assert.equal(turnStatusText("completed"), "已完成");
  assert.equal(turnStatusText("weird"), "状态未识别");
  assert.equal(messageKindText("agentMessage"), "智能体回复");
  assert.equal(messageKindText("somethingNew"), "其他记录");
  const report = preflightPresentation(`evoloop-preflight-v1:${JSON.stringify({ version: 1, code: "FIXED_SOURCE_UNAVAILABLE", category: "unavailable", actualBytes: null, limitBytes: null,
    source: { kind: "document", id: "doc-1", revisionId: "rev-1" }, modelStarted: false, nextAction: "用本 Run 的执行身份读取固定资料" })}`)!;
  const view = preflightView(report);
  assert.equal(view.title, "读不到固定资料");
  assert.equal(view.source, "来源是一份文档的固定修订");
  assert.doesNotMatch(`${view.title}${view.next}${view.source}`, /Run|Session|doc-1|rev-1|document/);
  assert.deepEqual(view.ids, [["检查代码", "FIXED_SOURCE_UNAVAILABLE"], ["来源", "doc-1"], ["来源修订", "rev-1"]]);
  assert.equal(preflightView({ ...report, code: "NEW_CODE", source: null }).title, "原因未识别");
});
