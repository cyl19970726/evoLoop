// The team growth rules at the coordinator (apps/coordinator/src/staffing): the door on `runtime.session.reserve`, the 分工检查 read route, the
// staffing section of the private configuration, and the pump that turns a due trial into one review Task.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Principal } from "@evoloop/contracts";
import type { StaffingCheck, StaffingTrialDue } from "@evoloop/contracts/staffing";
import type { WorkflowService } from "@evoloop/core";
import { loadIntegrations } from "../src/configuration.js";
import type { RuntimeRunner } from "../src/runtime/runner.js";
import { buildServer } from "../src/server.js";
import { assertStaffingAllows, staffingReadOptions, type StaffingGateDeps } from "../src/staffing/gate.js";
import { reviewTaskCommand, reviewTaskIds, TrialReviewPump, type ReviewTaskGrant } from "../src/staffing/review-pump.js";
import { registerWorkManagementRoutes } from "../src/work-management/routes.js";

const projectId = randomUUID(), otherProject = randomUUID();
const leaderRole = randomUUID(), devRole = randomUUID();
const reviewer: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true };
const due: StaffingTrialDue = { roleId: devRole, title: "功能开发", layer: "business", reviewAtUtc: "2026-11-23T00:00:00.000Z", daysOverdue: 4, openSessions: 3 };
const check = (extra: Partial<StaffingCheck> = {}): StaffingCheck => ({ projectId, observedAt: "2026-11-27T08:00:00.000Z", thresholds: { idleDays: 3 },
  team: [{ roleId: leaderRole, title: "Leader", layer: "system", state: "trial", openSessions: 1 }, { roleId: devRole, title: "功能开发", layer: "business", state: "trial", openSessions: 3 }],
  trialsDue: [], lastAddition: null, idle: [], blockers: [], ...extra });
const blocked = check({ trialsDue: [due], blockers: [{ code: "TRIAL_REVIEW_OVERDUE", message: "有 1 个试行职责已过回看日还没有回看。" }] });
const deps = (current: StaffingCheck, configuration: Awaited<ReturnType<StaffingGateDeps["configuration"]>> = { enabled: true, projectIds: [projectId], idleDays: 5 },
  seen: unknown[] = []): StaffingGateDeps => ({
  configuration: async () => configuration,
  check: async (_principal, project, options) => { seen.push([project, options]); return current; },
  dynamicSessionIds: async () => ["loop-session"],
});

test("the door refuses a business Session while the check has blockers, and lets a system Role or a written exception through", async () => {
  const seen: unknown[] = [];
  const gate = deps(blocked, undefined, seen);
  await assert.rejects(assertStaffingAllows(gate, reviewer, { projectId, roleId: devRole }),
    (error: Error & { code?: string }) => error.code === "TRIAL_REVIEW_OVERDUE" && /staffingException/.test(error.message));
  assert.deepEqual(seen, [[projectId, { idleDays: 5, excludeSessionIds: ["loop-session"] }]], "the check is read with the configured threshold and without loop Sessions");
  await assertStaffingAllows(gate, reviewer, { projectId, roleId: leaderRole });
  await assertStaffingAllows(gate, reviewer, { projectId, roleId: devRole, staffingException: "起步配置" });
  await assertStaffingAllows(deps(check()), reviewer, { projectId, roleId: devRole });
});

test("the door is off without a staffing section, when disabled, and for a project the section does not list", async () => {
  const never: StaffingGateDeps["check"] = async () => { throw new Error("the check must not be read while the door is off"); };
  for (const configuration of [undefined, { enabled: false, projectIds: [projectId], idleDays: 3 }, { enabled: true, projectIds: [otherProject], idleDays: 3 }])
    await assertStaffingAllows({ ...deps(blocked), configuration: async () => configuration, check: never }, reviewer, { projectId, roleId: devRole });
  assert.deepEqual(await staffingReadOptions(deps(blocked, undefined))(projectId), { idleDays: 5, excludeSessionIds: ["loop-session"] });
  assert.deepEqual(await staffingReadOptions({ configuration: async () => undefined, dynamicSessionIds: async () => [] })(projectId), { excludeSessionIds: [] });
});

test("the staffing section has defaults, and a review grant must name a Role and an accepting identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-staffing-"));
  const file = join(directory, "integrations.json");
  try {
    await writeFile(file, JSON.stringify({}));
    assert.equal((await loadIntegrations(file, { allowedRoots: null })).staffing, undefined);
    await writeFile(file, JSON.stringify({ staffing: { enabled: true, projectIds: [projectId] } }));
    assert.deepEqual((await loadIntegrations(file, { allowedRoots: null })).staffing, { enabled: true, projectIds: [projectId], idleDays: 3, pollIntervalMs: 300000, reviewTasks: [] });
    await writeFile(file, JSON.stringify({ staffing: { enabled: true, projectIds: [projectId], idleDays: 7,
      reviewTasks: [{ projectId, actorId: "leader-agent", owner: leaderRole, consumer: "requirements-agent" }] } }));
    assert.equal((await loadIntegrations(file, { allowedRoots: null })).staffing?.reviewTasks[0]?.owner, leaderRole);
    await writeFile(file, JSON.stringify({ staffing: { enabled: true, reviewTasks: [{ projectId, actorId: "leader-agent", owner: "not-a-role-id", consumer: "x" }] } }));
    await assert.rejects(loadIntegrations(file, { allowedRoots: null }), /Invalid integration configuration/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the staffing check is one project-read route and passes the host's read options", async () => {
  const calls: unknown[] = [];
  const service = new Proxy({
    getStaffingCheck: async (who: Principal, project: string, options: unknown) => { calls.push([who.actorId, project, options]); return blocked; },
  }, { get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? (() => { throw new Error(`unused ${String(key)}`); }) }) as unknown as WorkflowService;
  const app = Fastify();
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = { actorId: "reader", projectIds: [projectId], permissions: [] }; });
  await registerWorkManagementRoutes(app, service, undefined, { options: async () => ({ idleDays: 5, excludeSessionIds: ["loop-session"] }) });
  const bare = Fastify();
  bare.decorateRequest("principal", null);
  bare.addHook("onRequest", async request => { request.principal = { actorId: "reader", projectIds: [projectId], permissions: [] }; });
  await registerWorkManagementRoutes(bare, service);
  try {
    const read = await app.inject({ url: `/api/projects/${projectId}/staffing-check` });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), blocked);
    assert.equal((await bare.inject({ url: `/api/projects/${projectId}/staffing-check` })).statusCode, 200);
    assert.deepEqual(calls, [["reader", projectId, { idleDays: 5, excludeSessionIds: ["loop-session"] }], ["reader", projectId, {}]]);
  } finally { await app.close(); await bare.close(); }
});

test("through /api/commands: a refused reservation never reaches core, an exception or a replay does, and a managed loop's Session is not judged", async () => {
  const token = "r".repeat(40), sessionId = randomUUID(), cwd = process.cwd();
  const grant = { projectId, actorId: "reviewer", roleId: devRole, authorizationScope: "task:bounded", cwd, sandbox: "danger-full-access" as const, approvalPolicy: "never" as const, model: "gpt-6" };
  const credentials = [{ token, actorId: "reviewer", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }];
  const headers = { authorization: `Bearer ${token}` };
  const command = { type: "runtime.session.reserve", projectId, operationId: randomUUID(), sessionId, roleId: devRole,
    authorizationScope: grant.authorizationScope, cwd, sandbox: "danger-full-access", approvalPolicy: "never", model: "gpt-6" };
  const executed: Array<Record<string, unknown>> = [];
  const journalled = new Set<string>();
  const service = {
    listRoles: async () => ({ items: [], nextCursor: null }), listRoleRevisions: async () => [], listRoleReviews: async () => [],
    listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [], listSchedules: async () => [], listScheduleRevisions: async () => [],
    listScheduleOccurrences: async () => [], roleRuntimeProvider: async () => "codex" as const,
    getOperation: async (_who: Principal, _project: string, operationId: string) => journalled.has(operationId) ? { operationId } : null,
    execute: async (_who: Principal, value: Record<string, unknown>) => { executed.push(value); return { status: "applied", operationId: value.operationId, entityId: sessionId, version: 1 }; },
  } as unknown as WorkflowService;
  const gate = deps(blocked);
  const dynamic = new Set<string>();
  const app = await buildServer({ service, credentials: credentials as never, runtime: { status: () => ({ available: true, error: null }) } as RuntimeRunner,
    listRuntimeModels: async () => ({ status: "available", models: ["gpt-6"], error: null, observedAtUtc: new Date().toISOString() }),
    allowedRuntimeCwd: async () => true, hasRuntimeGrant: scope => scope.roleId === grant.roleId && scope.actorId === grant.actorId,
    isDynamicSession: async (_project, id) => dynamic.has(id), authorizeDynamicSession: async () => true,
    staffingGate: (principal, value) => assertStaffingAllows(gate, principal, value) });
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/commands", headers, payload });
  try {
    const refused = await post(command);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().code, "TRIAL_REVIEW_OVERDUE");
    assert.equal(executed.length, 0, "a refused reservation is not sent to core");

    const excepted = await post({ ...command, operationId: randomUUID(), staffingException: "起步配置：产品、架构、开发各一个" });
    assert.equal(excepted.statusCode, 200, excepted.body);
    assert.equal(executed.at(-1)!.staffingException, "起步配置：产品、架构、开发各一个", "the exception travels with the reservation");
    assert.equal((await post({ ...command, operationId: randomUUID(), staffingException: "   " })).statusCode, 400, "a blank exception is not an exception");

    // The original reservation was journalled before the rule began to refuse: its replay is not judged again.
    journalled.add(command.operationId);
    assert.equal((await post(command)).statusCode, 200);

    const loopSession = randomUUID(); dynamic.add(loopSession);
    assert.equal((await post({ ...command, operationId: randomUUID(), sessionId: loopSession })).statusCode, 200, "a managed loop's own Session is not a staffing decision");
    assert.equal(executed.length, 3);
  } finally { await app.close(); }
});

test("a due trial becomes one review Task: the same ids every round, created once, as the configured actor and for the configured owner", async () => {
  const grant: ReviewTaskGrant = { projectId, actorId: "leader-agent", owner: leaderRole, consumer: "requirements-agent" };
  const command = reviewTaskCommand(grant, due);
  assert.deepEqual(reviewTaskIds(projectId, devRole, due.reviewAtUtc), { taskId: command.taskId, operationId: command.operationId });
  assert.match(command.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(command.taskId, command.operationId);
  assert.notEqual(reviewTaskIds(projectId, devRole, "2026-12-07T00:00:00.000Z").taskId, command.taskId, "a trial continued to a new date gets a new Task when that date passes");
  assert.equal(command.title, "试行回看：功能开发（2026-11-23 到期）");
  assert.equal(command.owner, leaderRole);
  assert.equal(command.consumer, "requirements-agent");
  assert.equal(command.noStage, true);
  assert.equal(command.completionBoundary, "delivered");
  assert.match(command.content, /role\.review/);
  assert.match(command.content, /^关闭后下一步：/m);
  assert.match(command.content, new RegExp(devRole));

  const tasks = new Set<string>();
  const created: string[] = [], said: string[] = [];
  let writable = true, current = blocked, refuse = false;
  const pump = new TrialReviewPump({ canWrite: () => writable, grants: async () => [grant, { ...grant, actorId: "gone" }],
    principal: async value => value.actorId === "gone" ? null : { actorId: value.actorId, projectIds: [projectId], permissions: ["task"] },
    check: async () => current,
    taskExists: async (_principal, _project, taskId) => tasks.has(taskId),
    createTask: async (principal, value) => {
      if (refuse) return { status: "rejected", code: "TASK_OWNER_ROLE_REQUIRED" };
      created.push(`${principal.actorId}:${value.taskId}`); tasks.add(value.taskId); return { status: "applied" };
    },
    onCreated: (_project, taskId, item) => said.push(`created ${taskId} ${item.roleId}`), onRefused: (_project, taskId, code) => said.push(`refused ${taskId} ${code}`) }, 60_000);

  writable = false; await pump.tick();
  assert.deepEqual(created, [], "nothing is written while this process may not write");
  writable = true; await pump.tick(); await pump.tick();
  assert.deepEqual(created, [`leader-agent:${command.taskId}`], "one Task, however many rounds");
  assert.deepEqual(said, [`created ${command.taskId} ${devRole}`]);

  // The trial was continued and is due again: a second Task. A refusal is said once, and tried again next round.
  const again = { ...due, reviewAtUtc: "2026-12-07T00:00:00.000Z" };
  current = check({ trialsDue: [again] }); refuse = true;
  await pump.tick(); await pump.tick();
  const second = reviewTaskIds(projectId, devRole, again.reviewAtUtc).taskId;
  assert.deepEqual(said.slice(1), [`refused ${second} TASK_OWNER_ROLE_REQUIRED`]);
  refuse = false; await pump.tick();
  assert.deepEqual(created, [`leader-agent:${command.taskId}`, `leader-agent:${second}`]);

  current = check(); await pump.tick();
  assert.equal(created.length, 2, "no due trial, nothing made");
});
