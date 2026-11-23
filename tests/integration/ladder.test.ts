// The verification ladder (`GET /api/projects/:id/ladder`, Task f6debf43): read from each project's own registered repositories with plain git, on a real
// PostgreSQL schema and real bare repositories. Refuses a live or shared server before opening TEST_DATABASE_URL.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

const roadmap = (status: string) => `# 路线图

| 阶段 | 要交付什么 | 退出证据 |
| --- | --- | --- |
| M0 正式定义 | 定义 | 读者检查 |
| M1 一次交付 | 交付 | 验收 |

### 各阶段现在在哪

| 阶段 | 现在的状态 |
| --- | --- |
| M0 | ${status}。第二句不该出现 |
| M1 | 还没开始 |
`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
/** A bare repository whose `main` holds the given files, plus the working copy that made it (to commit again). */
const bareRepo = (base: string, name: string, files: Record<string, string>, branch = "main") => {
  const work = join(base, `${name}-work`), bare = join(base, `${name}.git`);
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", branch);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), text); }
  git(work, "add", "-A"); git(work, "commit", "-q", "-m", "init");
  git(base, "clone", "-q", "--bare", work, bare);
  return { work, bare, push: () => git(work, "push", "-q", bare, `${branch}:${branch}`) };
};

const setup = async (t: test.TestContext) => {
  const schema = `ladder_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const base = mkdtempSync(join(tmpdir(), "ladder-"));
  t.after(async () => { rmSync(base, { recursive: true, force: true }); await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const reserved = Array.from({ length: 4 }, () => randomUUID());
  const decider: Principal = { actorId: "decider", projectIds: [...reserved], permissions: ["read", "write", "task", "document", "session", "management"], decisions: true };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => "2026-11-22T12:00:00.000Z" }, ids: { next: randomUUID },
    hasher: { hash: (s: string) => createHash("sha256").update(s).digest("hex") } });
  const makeProject = async () => {
    const projectId = reserved.shift()!;
    const applied = async (command: Record<string, unknown>) => { const r = await workflow.execute(decider, { ...command, projectId, operationId: randomUUID() } as never); assert.equal(r.status, "applied", JSON.stringify(r)); };
    await applied({ type: "project.create", title: "Ladder" });
    const owner = fixtureRoleId(`ladder-${projectId.slice(0, 6)}`); await seedFixtureRole(pool, projectId, owner);
    const goalId = randomUUID();
    await applied({ type: "goal.create", goalId, outcome: "G", constraints: "none", consumer: owner, authority: owner, scope: "t", owner });
    const stage = async (shortName: string, dueOn: string | null, ladderKeys: string[]) => {
      const stageId = randomUUID();
      await applied({ type: "stage.propose", stageId, goalId, deliverable: "第一行\n第二行", learningQuestion: "Q", shortName, checkMethod: "核对", dueOn, ladderKeys, reason: "r" });
      return stageId;
    };
    return { projectId, stage };
  };
  const repos: Array<{ projectId: string; root: string }> = [];
  const token = "l".repeat(40), outsider = "o".repeat(40);
  const app = await buildServer({ service: workflow, milestones: { repoRoot: base, repositories: () => repos },
    credentials: [{ token, actorId: "reader", identityKind: "agent", projectIds: [...reserved], permissions: ["task"] },
      { token: outsider, actorId: "outsider", identityKind: "agent", projectIds: [randomUUID()], permissions: ["task"] }] });
  t.after(() => app.close());
  const get = (projectId: string, path = "ladder", bearer = token) => app.inject({ url: `/api/projects/${projectId}/${path}`, headers: { authorization: `Bearer ${bearer}` } });
  return { base, repos, makeProject, get, outsider, pool };
};

test("a project with a roadmap in its registered bare repository reads its own ladder, with evidence stages in due order, and follows a new commit without a restart", async t => {
  const f = await setup(t);
  const p = await f.makeProject();
  const repo = bareRepo(f.base, "a", { "docs/roadmap.md": roadmap("定义已写回") });
  f.repos.push({ projectId: p.projectId, root: repo.bare });
  const late = await p.stage("晚的", "2026-12-20", ["M1"]), early = await p.stage("早的", "2026-12-01", ["M1", "M0"]), undated = await p.stage("未定", null, ["M1"]);
  await f.pool.query("UPDATE stage_milestone SET short_name=NULL WHERE stage_id=$1", [undated]);
  const first = await f.get(p.projectId);
  assert.equal(first.statusCode, 200, first.body);
  const body = first.json();
  assert.equal(body.available, true);
  assert.equal(body.source.commit, git(repo.bare, "rev-parse", "refs/heads/main"));
  assert.deepEqual(body.levels.map((l: { key: string; name: string; status: string }) => [l.key, l.name, l.status]), [["M0", "正式定义", "定义已写回。"], ["M1", "一次交付", "还没开始"]]);
  assert.deepEqual(body.levels[0].evidenceStages, [{ id: early, shortName: "早的" }]);
  assert.deepEqual(body.levels[1].evidenceStages, [{ id: early, shortName: "早的" }, { id: late, shortName: "晚的" }, { id: undated, shortName: "第一行" }], "due order, undated last, no short name falls back to the first line");
  // A new commit on the default branch shows on the next read.
  writeFileSync(join(repo.work, "docs/roadmap.md"), roadmap("换了一句"));
  git(repo.work, "commit", "-q", "-am", "update"); repo.push();
  const second = (await f.get(p.projectId)).json();
  assert.notEqual(second.source.commit, body.source.commit);
  assert.equal(second.source.commit, git(repo.bare, "rev-parse", "refs/heads/main"));
  assert.equal(second.levels[0].status, "换了一句。");
});

test("no repository, a repository without the file, or a file without the phase table is 'none', never evoLoop's own ladder and never an error", async t => {
  const f = await setup(t);
  const none = await f.makeProject(), noFile = await f.makeProject(), noTable = await f.makeProject();
  f.repos.push({ projectId: noFile.projectId, root: bareRepo(f.base, "nf", { "README.md": "x" }).bare });
  f.repos.push({ projectId: noTable.projectId, root: bareRepo(f.base, "nt", { "docs/roadmap.md": "# 没有表头\n" }).bare });
  for (const p of [none, noFile, noTable]) {
    const r = await f.get(p.projectId);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { available: false, source: { commit: null }, levels: [] });
  }
});

test("two repositories: the first one that has the roadmap decides, in registration order", async t => {
  const f = await setup(t);
  const p = await f.makeProject();
  f.repos.push({ projectId: p.projectId, root: bareRepo(f.base, "one", { "README.md": "x" }).bare });
  const second = bareRepo(f.base, "two", { "docs/roadmap.md": roadmap("第二个仓库") });
  f.repos.push({ projectId: p.projectId, root: second.bare });
  f.repos.push({ projectId: p.projectId, root: bareRepo(f.base, "three", { "docs/roadmap.md": roadmap("第三个仓库") }).bare });
  const body = (await f.get(p.projectId)).json();
  assert.equal(body.levels[0].status, "第二个仓库。");
  assert.equal(body.source.commit, git(second.bare, "rev-parse", "refs/heads/main"));
});

test("a repository without a main ref is an identifiable error, different from 'none'; the origin/main ref is preferred over a local main", async t => {
  const f = await setup(t);
  const broken = await f.makeProject(), both = await f.makeProject();
  f.repos.push({ projectId: broken.projectId, root: bareRepo(f.base, "dev", { "docs/roadmap.md": roadmap("x") }, "dev").bare });
  const r = await f.get(broken.projectId);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().code, "LADDER_UNREADABLE");
  // A repository where refs/remotes/origin/main is ahead of refs/heads/main: the remote ref wins.
  const repo = bareRepo(f.base, "rem", { "docs/roadmap.md": roadmap("本地") });
  writeFileSync(join(repo.work, "docs/roadmap.md"), roadmap("远端")); git(repo.work, "commit", "-q", "-am", "remote");
  const head = git(repo.work, "rev-parse", "HEAD");
  git(repo.work, "push", "-q", repo.bare, "HEAD:refs/remotes/origin/main");
  f.repos.push({ projectId: both.projectId, root: repo.bare });
  const body = (await f.get(both.projectId)).json();
  assert.equal(body.levels[0].status, "远端。");
  assert.equal(body.source.commit, head);
});

test("permission is project read permission; the old /milestones route is gone; the other project's repository is never read", async t => {
  const f = await setup(t);
  const a = await f.makeProject(), b = await f.makeProject();
  f.repos.push({ projectId: a.projectId, root: bareRepo(f.base, "only-a", { "docs/roadmap.md": roadmap("A") }).bare });
  assert.equal((await f.get(a.projectId, "ladder", f.outsider)).statusCode, 403);
  assert.equal((await f.get(a.projectId, "ladder", "x".repeat(40))).statusCode, 401);
  assert.equal((await f.get(b.projectId)).json().available, false, "project B registered nothing, so it sees nothing of A's roadmap");
  const old = await f.get(a.projectId, "milestones");
  assert.equal(old.statusCode, 404);
});
