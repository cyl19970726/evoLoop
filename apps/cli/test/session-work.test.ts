import assert from "node:assert/strict";
import test from "node:test";
import { sessionWorkPath } from "../src/session-work.ts";
import { runCli } from "../src/application.ts";
const id = "00000000-0000-4000-8000-000000000001";
const key = `external:${id}`;
test("named work reads preserve opaque cursors, real Session identity and project-scoped filters", () => {
  const path = sessionWorkPath(["history", key], new Map([["cursor", "opaque+cursor/=="], ["task", id], ["importance", "all"]]));
  const u = new URL(path, "http://local");
  assert.equal(decodeURIComponent(u.pathname), `/session-work/${key}/activities`);
  assert.equal(u.searchParams.get("cursor"), "opaque+cursor/==");
  assert.equal(u.searchParams.get("taskId"), id);
  assert.equal(u.searchParams.get("importance"), "all");
});
test("work reads reject path injection, unbounded pages and missing change positions", () => {
  assert.throws(() => sessionWorkPath(["snapshot", `${key}/../other`], new Map()));
  assert.throws(() => sessionWorkPath(["list"], new Map([["limit", "51"]])));
  assert.throws(() => sessionWorkPath(["changes"], new Map()));
  assert.throws(() => sessionWorkPath(["snapshot", key], new Map([["cursor", "unrelated"]])));
  assert.match(sessionWorkPath(["changes", key], new Map([["cursor", "position"]])), /^\/session-work\/changes\?key=/);
});
test("Leader work discovery has runnable bounded Task, Document and change commands", () => {
  assert.equal(sessionWorkPath(["leader"], new Map([["limit", "20"]])),
    "/work-management/index?view=tasks&limit=20");
  assert.equal(sessionWorkPath(["leader"], new Map([["documents", true], ["closed", true]])),
    "/work-management/index?view=documents&includeClosed=true");
  assert.equal(sessionWorkPath(["leader", "changes"], new Map([["cursor", "opaque"], ["limit", "100"]])),
    "/work-management/changes?cursor=opaque&limit=100");
  assert.equal(sessionWorkPath(["leader", "changes"], new Map()), "/work-management/changes");
});
test("Agent help and schemas expose common message/assignment operations without authentication", async () => {
  const run = async (args: string[]) => { let out = ""; const code = await runCli(args, {}, { stdout: s => { out += s; }, stderr: () => {} }); return { code, body: JSON.parse(out) }; };
  assert.equal((await run(["help"])).body.commands.some((x: string) => x.startsWith("work list ")), true);
  assert.equal((await run(["help"])).body.commands.some((x: string) => x.startsWith("work leader ")), true);
  for (const name of ["work.plan.set", "work.dependencies.set", "work.review.set"]) {
    const schema = await run(["request", "schema", name]); assert.equal(schema.code, 0);
    assert.ok(schema.body.properties.operationId);
  }
  for (const type of ["session.message.post", "session.profile.set", "task.assignment.acknowledge"]) {
    const r = await run(["command", "schema", type]); assert.equal(r.code, 0); assert.ok(r.body.required.includes("operationId"));
  }
});
