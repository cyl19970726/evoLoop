import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { milestoneStatus, type StagePhaseLink } from "@evoloop/contracts/milestones";
import { buildMilestones, parseRoadmapPhases, readBuildInfo, registerMilestoneRoutes } from "../src/milestones/index.ts";
import { buildServer } from "../src/server.ts";

const roadmap = readFileSync(new URL("../../../docs/roadmap.md", import.meta.url), "utf8");
const link = (over: Partial<StagePhaseLink> & { phaseKey: string }): StagePhaseLink => ({ stageId: `s-${over.phaseKey}`, goalId: "g", state: "proposed", review: null, ...over });
const review = (adopted: string, rejected: string, gap: string) => ({ adopted, rejected, gap, createdAt: "2026-11-12T03:00:00.000Z" });

test("the roadmap's real phase table gives the six phases with their delivery and exit evidence", () => {
  const phases = parseRoadmapPhases(roadmap);
  assert.deepEqual(phases.map(phase => phase.id), ["M0", "M0.5", "M1", "M2", "M3", "M4"]);
  assert.equal(phases[0]!.title, "正式定义与仓库");
  for (const phase of phases) { assert.ok(phase.deliver.length > 10, phase.id); assert.ok(phase.exit.length > 10, phase.id); }
  assert.match(phases[2]!.exit, /dogfood/);
  assert.deepEqual(parseRoadmapPhases("no table here"), []);
});

test("exited needs something adopted and neither a gap nor a rejection; only a rejection or a gap is partial; the rest is just reviewed", () => {
  const reviewed = { state: "reviewed" as const };
  assert.equal(milestoneStatus(reviewed, review("it works", "", "")), "exited");
  assert.equal(milestoneStatus(reviewed, review("it works", "", "one gap")), "partial");
  assert.equal(milestoneStatus(reviewed, review("it works", "one thing refused", "")), "partial", "a rejection with no gap is not an exit");
  assert.equal(milestoneStatus(reviewed, review("", "refused", "")), "reviewed", "only a rejection and nothing adopted is not an exit either");
  assert.equal(milestoneStatus(reviewed, review("  ", "", "")), "reviewed");
  assert.equal(milestoneStatus(reviewed, null), "reviewed");
  assert.equal(milestoneStatus({ state: "active" }, review("a", "", "")), "in_progress");
  assert.equal(milestoneStatus({ state: "proposed" }, null), "not_started");
});

test("a phase is linked by an explicit key; none or several linked stages give no status; the current phase is named only for exactly one active stage", () => {
  const phases = parseRoadmapPhases(roadmap);
  const day1 = buildMilestones(phases, [], "abc1234", true);
  assert.deepEqual(day1.phases.map(phase => [phase.id, phase.status, phase.statusLabel, phase.reviewedAt]), phases.map(phase => [phase.id, null, null, null]));
  assert.equal(day1.currentPhaseId, null); assert.equal(day1.currentNote, "当前阶段未登记");
  const linked = buildMilestones(phases, [link({ phaseKey: "M0", state: "reviewed", review: review("done", "", "") }), link({ phaseKey: "M1", state: "active" }), link({ phaseKey: "M2", state: "proposed" })], null, true);
  const byId = Object.fromEntries(linked.phases.map(phase => [phase.id, phase]));
  assert.deepEqual([byId.M0!.status, byId.M1!.status, byId.M2!.status, byId["M0.5"]!.status], ["exited", "in_progress", "not_started", null]);
  assert.equal(byId.M0!.reviewedAt, "2026-11-12T03:00:00.000Z"); assert.equal(byId.M1!.reviewedAt, null, "no review, no date: never invented");
  assert.equal(linked.currentPhaseId, "M1"); assert.equal(linked.currentNote, null);
  const two = buildMilestones(phases, [link({ phaseKey: "M1", state: "active" }), link({ phaseKey: "M2", state: "active" })], null, true);
  assert.equal(two.currentPhaseId, null); assert.match(two.currentNote!, /多个进行中/);
  const twice = buildMilestones(phases, [link({ phaseKey: "M1", stageId: "a", state: "active" }), link({ phaseKey: "M1", stageId: "b", state: "reviewed" })], null, true);
  const m1 = twice.phases.find(phase => phase.id === "M1")!;
  assert.deepEqual([m1.status, m1.stage, m1.linkedStages], [null, null, 2], "two stages on one phase: nothing is guessed");
  assert.equal(twice.currentPhaseId, null, "the one active stage sits on an ambiguous phase: not named");
  assert.equal(buildMilestones([], [], null, false).source.roadmap, "unavailable");
});

test("GET /api/version is public and gives only commit, builtAt and startedAt; a missing build-info.json reads null, never an old value", async t => {
  const root = await mkdtemp(join(tmpdir(), "evoloop-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await buildServer({ service: new Proxy({ getProject: async () => ({ id: "p" }), listStagePhaseLinks: async () => [] }, { get: (target, name) => name in target ? (target as never)[name] : async () => undefined }) as never, credentials: [{ token: "t".repeat(40), actorId: "reader", projectIds: ["00000000-0000-4000-8000-000000000001"], permissions: ["read"] }], milestones: { repoRoot: root, startedAt: "2026-11-12T01:00:00.000Z" } } as never);
  t.after(() => app.close());
  const missing = await app.inject({ url: "/api/version" });
  assert.equal(missing.statusCode, 200, "no login needed");
  assert.deepEqual(missing.json(), { commit: null, builtAt: null, startedAt: "2026-11-12T01:00:00.000Z" });
  await writeFile(join(root, "build-info.json"), JSON.stringify({ commit: "9a4020a5886be01b2d74fe850687ca7355b2d226", builtAt: "2026-11-12T00:30:00Z", secret: "x", path: "/home/x" }));
  const present = await app.inject({ url: "/api/version" });
  assert.deepEqual(present.json(), { commit: "9a4020a5886be01b2d74fe850687ca7355b2d226", builtAt: "2026-11-12T00:30:00.000Z", startedAt: "2026-11-12T01:00:00.000Z" });
  assert.deepEqual(Object.keys(present.json()).sort(), ["builtAt", "commit", "startedAt"], "nothing else is ever exposed");
  await writeFile(join(root, "build-info.json"), "not json");
  assert.deepEqual(await readBuildInfo(root), { commit: null, builtAt: null }, "a broken file is the same as a missing one");
  await writeFile(join(root, "build-info.json"), JSON.stringify({ commit: "../../etc/passwd" }));
  assert.deepEqual(await readBuildInfo(root), { commit: null, builtAt: null }, "a commit that is not a hash is refused");
  assert.equal((await app.inject({ url: "/api/projects/00000000-0000-4000-8000-000000000001/milestones" })).statusCode, 401, "the milestones need a login");
});
