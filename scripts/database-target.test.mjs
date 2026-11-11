import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertDevelopmentDatabase, judgeTarget, targetOf } from "./lib/database-target.mjs";

const url = (port, database = "evoloop_x_test") => `postgres://user:secret@127.0.0.1:${port}/${database}`;
const liveLike = ["evoloop", "evoloop_sched_test", "postgres", "template0", "template1"];
const devOnly = ["postgres", "template0", "template1", "evoloop_local_test", "evoloop_dev", "evoloop_restored_empty"];

test("a server that hosts the live database is refused, naming it and what to do; a dedicated server is accepted", () => {
  const live = judgeTarget({ url: url(55432), databases: liveLike });
  assert.equal(live.ok, false);
  assert.deepEqual(live.foreign, ["evoloop"]);
  assert.match(live.reason, /server 127\.0\.0\.1:55432 also hosts "evoloop"/);
  assert.match(live.reason, /own PostgreSQL instance/);
  assert.match(live.reason, /EVOLOOP_DEV_DATABASE_SERVER=127\.0\.0\.1:55432/);
  assert.equal(judgeTarget({ url: url(55433), databases: devOnly }).ok, true, "evoloop_dev, evoloop_local_test and the like live on a development server");
  // Any database that is not a development one marks the server, not only the one called evoloop.
  assert.equal(judgeTarget({ url: url(1), databases: [...devOnly, "customer_data"] }).ok, false);
});

test("a test database name is still required, and the one override names the exact server", () => {
  assert.match(judgeTarget({ url: url(55433, "evoloop"), databases: devOnly }).reason, /not a dedicated evoloop_\*_test database/);
  assert.equal(judgeTarget({ url: url(55433, "other_test"), databases: devOnly }).ok, false);
  const shared = { url: url(55432), databases: liveLike };
  assert.equal(judgeTarget({ ...shared, allowedServer: "127.0.0.1:55432" }).overridden, true);
  assert.equal(judgeTarget({ ...shared, allowedServer: "127.0.0.1:55431" }).ok, false, "another server's name does not unlock this one");
  assert.equal(judgeTarget({ ...shared, allowedServer: "" }).ok, false);
  assert.deepEqual(targetOf("postgres:///evoloop_x_test?host=/tmp/pg&port=5444"), { host: "/tmp/pg", port: "5444", server: "/tmp/pg:5444", database: "evoloop_x_test" });
  assert.equal(targetOf("postgres://u@LOCALHOST/evoloop_x_test").server, "localhost:5432");
});

test("assertDevelopmentDatabase refuses a live server before any test runs, and a server it cannot read", async () => {
  await assert.rejects(assertDevelopmentDatabase(url(55432), { env: {}, list: async () => liveLike }), /Refusing to run against 127\.0\.0\.1:55432: server 127\.0\.0\.1:55432 also hosts "evoloop"/);
  await assert.rejects(assertDevelopmentDatabase(url(7, "evoloop"), { env: {}, list: async () => { throw new Error("must not connect for a bad name"); } }), /not a dedicated/);
  await assert.rejects(assertDevelopmentDatabase(url(8), { env: {}, list: async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } }), /cannot list the databases.*ECONNREFUSED/);
  assert.equal((await assertDevelopmentDatabase(url(55433), { env: {}, list: async () => devOnly })).ok, true);
  assert.equal((await assertDevelopmentDatabase(url(55432), { env: { EVOLOOP_DEV_DATABASE_SERVER: "127.0.0.1:55432" }, list: async () => liveLike })).overridden, true);
});

test("the preload stops a process whose TEST_DATABASE_URL has an unusable name, without touching any server", () => {
  const guard = fileURLToPath(new URL("./test-database-guard.mjs", import.meta.url));
  const run = env => spawnSync(process.execPath, ["--import", guard, "-e", "console.log('ran')"], { env: { ...process.env, ...env }, encoding: "utf8" });
  const refused = run({ TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:1/evoloop" });
  assert.equal(refused.status, 78);
  assert.match(refused.stderr, /Refusing to run against 127\.0\.0\.1:1: database "evoloop" is not a dedicated evoloop_\*_test database/);
  assert.doesNotMatch(refused.stdout, /ran/);
  const unset = run({ TEST_DATABASE_URL: "" });
  assert.equal(unset.status, 0, "without a test database nothing is checked");
});
