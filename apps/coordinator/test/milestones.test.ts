import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseRoadmapPhases, readBuildInfo, registerMilestoneRoutes } from "../src/milestones/index.ts";
import { buildServer } from "../src/server.ts";

const roadmap = readFileSync(new URL("../../../docs/roadmap.md", import.meta.url), "utf8");

test("the roadmap's real phase table gives the six phases with their delivery and exit evidence", () => {
  const phases = parseRoadmapPhases(roadmap);
  assert.deepEqual(phases.map(phase => phase.id), ["M0", "M0.5", "M1", "M2", "M3", "M4"]);
  assert.equal(phases[0]!.title, "正式定义与仓库");
  for (const phase of phases) { assert.ok(phase.deliver.length > 10, phase.id); assert.ok(phase.exit.length > 10, phase.id); }
  assert.match(phases[2]!.exit, /dogfood/);
  assert.deepEqual(parseRoadmapPhases("no table here"), []);
});

test("GET /api/version is public and gives only commit, builtAt and startedAt; a missing build-info.json reads null, never an old value", async t => {
  const root = await mkdtemp(join(tmpdir(), "evoloop-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await buildServer({ service: new Proxy({ getProject: async () => ({ id: "p" }) }, { get: (target, name) => name in target ? (target as never)[name] : async () => undefined }) as never, credentials: [{ token: "t".repeat(40), actorId: "reader", projectIds: ["00000000-0000-4000-8000-000000000001"], permissions: [] }], milestones: { repoRoot: root, startedAt: "2026-11-12T01:00:00.000Z" } } as never);
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
});

test("the ladder reads each level's status as the first sentence of the roadmap's own status table, and a roadmap without the phase table is nothing", async () => {
  const { buildLadder, firstSentence, parseStatuses } = await import("../src/milestones/ladder.ts");
  const statuses = parseStatuses(roadmap);
  assert.deepEqual([...statuses.keys()], ["M0", "M1", "M2", "M3", "M4"]);
  for (const text of statuses.values()) assert.ok(text.length > 5 && text.indexOf("。") === text.length - 1 || !text.includes("。"));
  assert.equal(firstSentence("[链接](x.md#a)写了一句。第二句"), "链接写了一句。");
  const view = buildLadder(roadmap, "abc1234", [{ id: "s1", shortName: "短名", ladderKeys: ["M1"] }]);
  assert.equal(view?.available, true);
  assert.deepEqual(view?.levels.find(level => level.key === "M1")?.evidenceStages, [{ id: "s1", shortName: "短名" }]);
  assert.deepEqual(view?.levels.find(level => level.key === "M2")?.evidenceStages, []);
  assert.equal(buildLadder("# 没有表头", "abc1234", []), null);
});
