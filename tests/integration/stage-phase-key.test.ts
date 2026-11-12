// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { milestoneStatus } from "@evoloop/contracts/milestones";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

test("a stage is linked to a roadmap phase by review permission only; the link is read with the stage's own state and latest review, and cleared with null", async t => {
  const schema = `phase_key_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID();
  const reviewer: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (s: string) => createHash("sha256").update(s).digest("hex") } });
  const issue = (who: Principal, command: Record<string, unknown>) => workflow.execute(who, { ...command, projectId, operationId: randomUUID() } as never);
  const applied = async (who: Principal, command: Record<string, unknown>) => { const r = await issue(who, command); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
  await applied(reviewer, { type: "project.create", title: "Phase links" });
  const owner = fixtureRoleId("phase-owner"); await seedFixtureRole(pool, projectId, owner);
  const goalId = randomUUID();
  await applied(reviewer, { type: "goal.create", goalId, outcome: "One goal", constraints: "none", consumer: owner, authority: owner, scope: "test", owner });
  const stage = async () => { const stageId = randomUUID(); await applied(reviewer, { type: "stage.propose", stageId, goalId, deliverable: "Deliver", learningQuestion: "Learn", reason: "propose" }); return stageId; };
  const first = await stage(), second = await stage();
  assert.deepEqual(await workflow.listStagePhaseLinks(reviewer, projectId), [], "day one: nothing is linked");

  const link = (who: Principal, stageId: string, phaseKey: string | null) => issue(who, { type: "stage.phaseKey.set", stageId, phaseKey, reason: "map to the roadmap" });
  await assert.rejects(link(writer, first, "M1"), { code: "FORBIDDEN", message: /Permission review is required/ });
  await assert.rejects(workflow.execute(reviewer, { type: "stage.phaseKey.set", projectId, operationId: randomUUID(), stageId: first, phaseKey: "milestone one", reason: "x" } as never), /phaseKey|regex|invalid/i);
  assert.equal((await link(reviewer, randomUUID(), "M1")).status, "rejected", "an unknown stage cannot be linked");
  await applied(reviewer, { type: "stage.phaseKey.set", stageId: first, phaseKey: "M1", reason: "map" });
  await applied(reviewer, { type: "stage.phaseKey.set", stageId: second, phaseKey: "M0.5", reason: "map" });
  let links = await workflow.listStagePhaseLinks(reviewer, projectId);
  assert.deepEqual(links.map(item => [item.phaseKey, item.state, item.review]), [["M0.5", "proposed", null], ["M1", "proposed", null]]);
  // The stage page's own state moves it: accept, then review; the link follows the same fields.
  await applied(reviewer, { type: "stage.accept", stageId: first, expectedVersion: 1, reason: "accept" });
  await applied(reviewer, { type: "stage.review", stageId: first, expectedVersion: 2, adopted: "The deliverable works", rejected: "Nothing refused", gap: "A gap remains", nextChoice: "continue", evidence: "e", reason: "review" });
  links = await workflow.listStagePhaseLinks(reviewer, projectId);
  const m1 = links.find(item => item.phaseKey === "M1")!;
  assert.equal(m1.state, "reviewed"); assert.equal(m1.review?.adopted, "The deliverable works"); assert.ok(m1.review?.createdAt);
  assert.equal(milestoneStatus(m1, m1.review), "partial", "an adopted result with a gap is partial");
  // Re-linking changes the phase of the same stage; null clears it; the stage itself is untouched.
  await applied(reviewer, { type: "stage.phaseKey.set", stageId: first, phaseKey: "M2", reason: "remap" });
  assert.deepEqual((await workflow.listStagePhaseLinks(reviewer, projectId)).map(item => item.phaseKey), ["M0.5", "M2"]);
  await applied(reviewer, { type: "stage.phaseKey.set", stageId: second, phaseKey: null, reason: "unlink" });
  assert.deepEqual((await workflow.listStagePhaseLinks(reviewer, projectId)).map(item => item.phaseKey), ["M2"]);
  assert.equal((await workflow.getStage(reviewer, projectId, first)).state, "reviewed", "the stage's own record is untouched by the link");
  // A reader without write still reads the links.
  assert.equal((await workflow.listStagePhaseLinks({ ...writer, permissions: ["read"] }, projectId)).length, 1);
});
