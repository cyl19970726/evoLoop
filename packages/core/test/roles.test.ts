import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import type { RoleCommand, RoleProposal, RoleTransaction } from "@evoloop/contracts/roles";
import { applyRole, RoleRuleError } from "../src/roles/index.js";

const projectId = randomUUID(), roleId = randomUUID(), taskId = randomUUID();
const principal: Principal = { actorId: "manager", projectIds: [projectId], permissions: ["write", "review"] };
const nowUtc = "2026-10-20T09:00:00.000Z";
const proposal: RoleProposal = {
  title: "Release stewardship", goal: "Own release health", independentResponsibility: "Judge readiness across releases", ownerScope: "this project releases",
  inputs: ["release plan"], writableAssets: ["release notes"], deliverables: ["release decision"], triggers: ["candidate release"], workflow: "Inspect, test and review", handoffBoundary: "handoff to product owner",
  evidence: [
    { kind: "rework", observation: "three repeated release failures", sourceRef: "task:failures", observedAtUtc: nowUtc },
    { kind: "effect", observation: "release blocked users", sourceRef: "review:consumer", observedAtUtc: nowUtc },
    { kind: "cost", observation: "six hours of recovery", sourceRef: "run:cost", observedAtUtc: nowUtc },
  ],
  alternatives: ["method", "knowledge", "another-instance", "temporary-assignment"].map(kind => ({ kind: kind as RoleProposal["alternatives"][number]["kind"], assessment: `${kind} does not own ongoing release judgement`, estimatedCost: "one day" })),
  firstTaskId: taskId, baseline: "three failures per month", expectedEffect: "fewer failures", costLimit: "two hours per release", trialDays: 14, reviewAtUtc: "2026-10-27T09:00:00.000Z", exitCriteria: "retire if no improvement",
};
const command = (overrides: Partial<Extract<RoleCommand, { type: "role.propose" }>> = {}): RoleCommand => ({ type: "role.propose", projectId, operationId: randomUUID(), roleId, proposal, ...overrides });
const tx = { getTask: async () => ({ id: taskId, owner: "manager", version: 1, state: "proposed" }), createRole: async () => {} } as unknown as RoleTransaction;

test("role proposal requires observed evidence, all alternatives and bounded trial", async () => {
  const context = { nowUtc, nextId: randomUUID };
  await assert.rejects(() => applyRole(tx, principal, command({ proposal: { ...proposal, evidence: [] } }), context), (error: unknown) => error instanceof RoleRuleError && error.code === "INVALID_COMMAND");
  await assert.rejects(() => applyRole(tx, principal, command({ proposal: { ...proposal, alternatives: proposal.alternatives.slice(0, 3) } }), context), (error: unknown) => error instanceof RoleRuleError && error.code === "INVALID_COMMAND");
  await assert.rejects(() => applyRole(tx, principal, command({ proposal: { ...proposal, reviewAtUtc: "2026-11-20T09:00:00.000Z" } }), context), (error: unknown) => error instanceof RoleRuleError && error.code === "INVALID_TRIAL");
  assert.equal((await applyRole(tx, principal, command(), context)).version, 1);
});

test("proposal may come from writer; decisions require project reviewer", async () => {
  const writer = { ...principal, permissions: ["write"] as Principal["permissions"] };
  assert.equal((await applyRole(tx, writer, command(), { nowUtc, nextId: randomUUID })).version, 1);
  await assert.rejects(() => applyRole(tx, { ...writer, projectIds: [] }, command(), { nowUtc, nextId: randomUUID }), (error: unknown) => error instanceof RoleRuleError && error.code === "FORBIDDEN");
  await assert.rejects(() => applyRole(tx, writer, { type: "role.decide", projectId, operationId: randomUUID(), roleId, expectedVersion: 1, decision: "accept-trial", reason: "reviewed" }, { nowUtc, nextId: randomUUID }), (error: unknown) => error instanceof RoleRuleError && error.code === "FORBIDDEN");
});

test("reviewer classification appends a Role revision with CAS and keeps proposal evidence", async () => {
  let current: any = { projectId, id: roleId, version: 2, currentRevisionId: randomUUID(), state: "active",
    proposal, proposedBy: "manager", createdAtUtc: nowUtc, trialStartedAtUtc: nowUtc,
    reviewAtUtc: proposal.reviewAtUtc, mergeTargetRoleId: null };
  const history: any[] = [];
  const store = { getRole: async () => current, advanceRole: async (value: typeof current, _expected: number, revision: unknown) => {
    current=value; history.push(revision);
  } } as unknown as RoleTransaction;
  const classify: RoleCommand={type:"role.classify",projectId,operationId:randomUUID(),roleId,
    expectedVersion:2,roleClass:"business",reason:"reviewed responsibility"};
  const result=await applyRole(store,principal,classify,{nowUtc,nextId:randomUUID});
  assert.equal(result.version,3);
  assert.equal(current.proposal.roleClass,"business");
  assert.deepEqual(history[0].proposal.evidence,proposal.evidence);
  await assert.rejects(()=>applyRole(store,principal,classify,{nowUtc,nextId:randomUUID}),
    (error:unknown)=>error instanceof RoleRuleError&&error.code==="VERSION_CONFLICT");
});

test("class change rejects an inherited incompatible template until explicitly cleared", async () => {
  const originalProposal: RoleProposal = { ...proposal, roleClass: "system", templateKey: "lead" };
  let current: any = { projectId, id: roleId, version: 2, currentRevisionId: randomUUID(), state: "active",
    proposal: originalProposal, proposedBy: "manager", createdAtUtc: nowUtc, trialStartedAtUtc: nowUtc,
    reviewAtUtc: proposal.reviewAtUtc, mergeTargetRoleId: null };
  const originalRevisionId = current.currentRevisionId;
  const history: any[] = [];
  const store = { getRole: async () => current, advanceRole: async (value: typeof current, _expected: number, revision: unknown) => {
    current=value; history.push(revision);
  } } as unknown as RoleTransaction;
  const change: RoleCommand={type:"role.classify",projectId,operationId:randomUUID(),roleId,
    expectedVersion:2,roleClass:"business",reason:"responsibility review"};
  await assert.rejects(()=>applyRole(store,principal,change,{nowUtc,nextId:randomUUID}),
    (error:unknown)=>error instanceof RoleRuleError&&error.code==="INVALID_CLASS");
  assert.equal(current.version,2);
  assert.equal(current.currentRevisionId,originalRevisionId);
  assert.equal(history.length,0);
  const applied=await applyRole(store,principal,{...change,templateKey:null},{nowUtc,nextId:randomUUID});
  assert.equal(applied.version,3);
  assert.equal(current.proposal.roleClass,"business");
  assert.equal(current.proposal.templateKey,undefined);
  assert.deepEqual(history[0].proposal.evidence,originalProposal.evidence);
  assert.equal(originalProposal.roleClass,"system");
  assert.equal(originalProposal.templateKey,"lead");
});

test("proposal cannot associate a template without a matching class", async () => {
  const context={nowUtc,nextId:randomUUID};
  for (const invalid of [{...proposal,templateKey:"lead" as const},
    {...proposal,roleClass:"business" as const,templateKey:"lead" as const}]) {
    await assert.rejects(()=>applyRole(tx,principal,command({proposal:invalid}),context),
      (error:unknown)=>error instanceof RoleRuleError&&error.code==="INVALID_CLASS");
  }
});
