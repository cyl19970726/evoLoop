// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { CommandResult, Principal } from "@evoloop/contracts";
import type { RoleBootstrapProposal } from "@evoloop/contracts/roles";
import { WorkflowService } from "@evoloop/core";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { runCli } from "../../apps/cli/src/application.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_[a-z0-9_]*test(?:\?|$)/.test(url))
  throw new Error("Use a dedicated evoloop_[a-z0-9_]*test database");

const now = "2026-11-15T09:00:00.000Z";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const applied = (result: CommandResult) => {
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result as Extract<CommandResult, { status: "applied" }>;
};
const cliErrorCode = (stderr: string) => {
  const last = stderr.trim().split("\n").at(-1);
  return last ? (JSON.parse(last) as { error: { code: string } }).error.code : null;
};

const leadProposal = (projectId: string): RoleBootstrapProposal => ({
  title: "Lead",
  roleClass: "system",
  templateKey: "lead",
  goal: "Carry project coordination from the first working day",
  independentResponsibility: "Own project-level ordering and handoffs independently",
  ownerScope: "This project's coordination and resourcing",
  inputs: ["project state", "Task and Role results"],
  writableAssets: ["project Tasks and assignments"],
  deliverables: ["ordered work", "explicit handoffs"],
  triggers: ["project creation", "new result or blocked work"],
  workflow: "Read fixed evidence, order work, assign an eligible Role and verify the handoff",
  handoffBoundary: "Hand implementation to business Roles; leave product and technical decisions to their owners",
  evidence: [
    { kind: "omission", observation: "The empty project has no Role that can own work", sourceRef: `project:${projectId}`, observedAtUtc: now },
    { kind: "effect", observation: "Task creation is blocked until a Role enters trial", sourceRef: `project:${projectId}`, observedAtUtc: now },
    { kind: "cost", observation: "Onboarding cannot proceed through the public CLI", sourceRef: `project:${projectId}`, observedAtUtc: now },
  ],
  alternatives: ["method", "knowledge", "another-instance", "temporary-assignment"].map(kind => ({
    kind, assessment: `${kind} cannot provide a persistent first Role`, estimatedCost: "one onboarding cycle",
  })),
  baseline: "No Role and no assignable owner",
  expectedEffect: "The first Role can enter trial and create the first Task",
  costLimit: "One bounded onboarding trial",
  trialDays: 14,
  reviewAtUtc: "2026-11-22T09:00:00.000Z",
  exitCriteria: "Coordination work is absent or can be handled without this Role",
});

test("an empty project can bootstrap one trial Lead from its project.create operation, then create the first Task", async t => {
  const schema = `first_role_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await migrate(url, schema);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: url });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
  });

  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const reviewer: Principal = {
    actorId: "onboarding-reviewer",
    projectIds: [projectId, otherProjectId],
    permissions: ["task", "document", "session", "management"], decisions: true,
  };
  const writer: Principal = { ...reviewer, actorId: "onboarding-writer", permissions: ["task", "document", "session"] };
  const service = new WorkflowService({
    uow: new PostgresUnitOfWork(pool),
    clock: { now: () => now },
    ids: { next: randomUUID },
    hasher: { hash },
  });
  const reviewerToken = "r".repeat(40), writerToken = "w".repeat(40);
  const app = await buildServer({
    service,
    credentials: [
      { token: reviewerToken, actorId: reviewer.actorId, projectIds: [projectId, otherProjectId], permissions: ["task", "document", "session", "management"], decisions: true },
      { token: writerToken, actorId: writer.actorId, projectIds: [projectId, otherProjectId], permissions: ["task", "document", "session"] },
    ],
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const state = await mkdtemp(join(tmpdir(), "evoloop-first-role-cli-"));
  t.after(async () => {
    await app.close();
    await rm(state, { recursive: true, force: true });
  });
  const run = async (args: string[], token = reviewerToken) => {
    let stdout = "", stderr = "";
    const code = await runCli(args, {
      EVOLOOP_API_URL: origin, EVOLOOP_TOKEN: token, EVOLOOP_PROJECT: projectId, EVOLOOP_STATE_DIR: join(state, "receipts"),
    }, { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    return { code, stdout, stderr };
  };
  const cli = async (name: string, command: Record<string, unknown>, token = reviewerToken) => {
    const file = join(state, `${name}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(command));
    return run(["command", "run", file], token);
  };
  const cliApplied = (result: { code: number; stdout: string; stderr: string }) => {
    assert.equal(result.code, 0, result.stderr);
    return applied(JSON.parse(result.stdout) as CommandResult);
  };
  const projectOperationId = randomUUID();
  cliApplied(await cli("project-create", {
    type: "project.create", projectId, operationId: projectOperationId, title: "First Role project",
  }));
  const taskBlocked = await cli("task-create-before-role", {
    type: "task.create", projectId, operationId: randomUUID(), taskId: randomUUID(), title: "Too early",
    content: "# Too early\n关闭后下一步：无", acceptance: "Must not exist", owner: randomUUID(), documentIds: [],
  });
  assert.equal(taskBlocked.code, 1);
  assert.equal(cliErrorCode(taskBlocked.stderr), "TASK_OWNER_ROLE_REQUIRED");
  const proposalWithoutRole = leadProposal(projectId);
  const proposeBlocked = await cli("role-propose-before-bootstrap", {
    type: "role.propose", projectId, operationId: randomUUID(), roleId: randomUUID(),
    proposal: { ...proposalWithoutRole, firstTaskId: randomUUID() },
  });
  assert.equal(proposeBlocked.code, 1);
  assert.equal(cliErrorCode(proposeBlocked.stderr), "INVALID_FIRST_TASK");

  const leadId = randomUUID();
  const bootstrap = {
    type: "role.bootstrap",
    projectId,
    roleId: leadId,
    proposal: leadProposal(projectId),
    projectCreateOperationId: projectOperationId,
    reason: "The project has no Role and needs its bounded first Lead",
  };
  const bootstrapOperationId = randomUUID();
  const bootstrapped = cliApplied(await cli("role-bootstrap", { ...bootstrap, operationId: bootstrapOperationId }));
  assert.deepEqual([bootstrapped.entityId, bootstrapped.version], [leadId, 1]);

  const role = await service.getRole(reviewer, projectId, leadId);
  assert.equal(role.state, "trial");
  assert.equal(role.proposedBy, reviewer.actorId);
  assert.equal(role.trialStartedAtUtc, now);
  assert.equal(role.proposal.firstTaskId, undefined, "the first Role has no invented first Task");
  assert.ok(role.proposal.evidence.some(item => item.sourceRef === `project:${projectId}`));
  const revisions = await service.listRoleRevisions(reviewer, projectId, leadId);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]?.actorId, reviewer.actorId);
  assert.match(revisions[0]?.reason ?? "", new RegExp(`project\\.create ${projectOperationId}`));
  const decisions = await pool.query(
    "SELECT decision,actor_id,reason FROM role_decision WHERE project_id=$1 AND role_id=$2",
    [projectId, leadId],
  );
  assert.deepEqual(decisions.rows, [{
    decision: "accept-trial",
    actor_id: reviewer.actorId,
    reason: "The project has no Role and needs its bounded first Lead",
  }]);
  const journal = await pool.query(
    "SELECT actor_id,command_type,result->>'status' AS status FROM operation_journal WHERE project_id=$1 AND operation_id=$2",
    [projectId, bootstrapOperationId],
  );
  assert.deepEqual(journal.rows, [{ actor_id: reviewer.actorId, command_type: "role.bootstrap", status: "applied" }]);

  const firstTaskId = randomUUID();
  cliApplied(await cli("task-create", {
    type: "task.create",
    projectId,
    operationId: randomUUID(),
    taskId: firstTaskId,
    title: "First onboarding work",
    content: "# First work\n\nUse the new trial Lead.\n关闭后下一步：无",
    acceptance: "The first Task is owned by the trial Lead.",
    owner: leadId,
    documentIds: [],
  }));
  assert.equal((await service.getTask(reviewer, projectId, firstTaskId)).task.owner, leadId);
  const roleReadback = await run(["read", "role", leadId, "--project", projectId]);
  assert.equal(roleReadback.code, 0, roleReadback.stderr);
  const readRole = JSON.parse(roleReadback.stdout) as Record<string, unknown> & { proposal: Record<string, unknown> };
  assert.equal(readRole.state, "trial");
  assert.equal(readRole.proposedBy, reviewer.actorId);
  assert.equal(readRole.proposal.firstTaskId, undefined);
  const readEvidence = readRole.proposal.evidence;
  assert.ok(Array.isArray(readEvidence));
  assert.ok(readEvidence.some(item =>
    typeof item === "object" && item !== null && (item as Record<string, unknown>).sourceRef === `project:${projectId}`));
  const revisionsReadback = await run(["read", "role", leadId, "--revisions", "--project", projectId]);
  assert.equal(revisionsReadback.code, 0, revisionsReadback.stderr);
  const readRevisions = JSON.parse(revisionsReadback.stdout) as Array<{ actorId: string; reason: string }>;
  assert.equal(readRevisions.length, 1);
  assert.equal(readRevisions[0]?.actorId, reviewer.actorId);
  assert.match(readRevisions[0]?.reason ?? "", new RegExp(`project\\.create ${projectOperationId}`));
  const operationReadback = await run(["operation", bootstrapOperationId, "--project", projectId]);
  assert.equal(operationReadback.code, 0, operationReadback.stderr);
  assert.equal(JSON.parse(operationReadback.stdout).result.status, "applied");

  const duplicate = await cli("role-bootstrap-again", {
    ...bootstrap,
    operationId: randomUUID(),
    roleId: randomUUID(),
    proposal: leadProposal(projectId),
  });
  assert.equal(duplicate.code, 1);
  assert.equal(cliErrorCode(duplicate.stderr), "ROLE_BOOTSTRAP_NOT_EMPTY");

  const otherProjectOperationId = randomUUID();
  cliApplied(await cli("project-create-other", {
    type: "project.create", projectId: otherProjectId, operationId: otherProjectOperationId, title: "Permission and origin checks",
  }));
  const noReview = await cli("role-bootstrap-no-review", {
    ...bootstrap,
    projectId: otherProjectId,
    operationId: randomUUID(),
    roleId: randomUUID(),
    proposal: leadProposal(otherProjectId),
    projectCreateOperationId: otherProjectOperationId,
  }, writerToken);
  assert.equal(noReview.code, 1);
  assert.equal(cliErrorCode(noReview.stderr), "FORBIDDEN");
  const forgedOrigin = await cli("role-bootstrap-forged-origin", {
    ...bootstrap,
    projectId: otherProjectId,
    operationId: randomUUID(),
    roleId: randomUUID(),
    proposal: leadProposal(otherProjectId),
    projectCreateOperationId: randomUUID(),
  });
  assert.equal(forgedOrigin.code, 1);
  assert.equal(cliErrorCode(forgedOrigin.stderr), "ROLE_BOOTSTRAP_ORIGIN_INVALID");
});
