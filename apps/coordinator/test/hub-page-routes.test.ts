// Task 5a47dcb8: the Hub forwards only a project's own API, so a page behind the Hub cannot read `/api/instance/drain` or `/api/version` (404, every 15 s). The same facts are read at
// the project's path: same data, same access rule as every project read, and the instance paths are unchanged for a local login.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildServer } from "../src/server.ts";
import { FORWARDED_PATH } from "@evoloop/contracts";

const projectId = "00000000-0000-4000-8000-000000000001", otherProject = "00000000-0000-4000-8000-000000000002";
const reader = "r".repeat(43), outsider = "o".repeat(43);
const drainStatus = { state: "draining", reason: "release", startedBy: "maintainer", startedAt: "2026-11-17T00:00:00.000Z", inFlight: { counts: { runs: 1, messageTurns: 2 }, runs: [{ id: "run-1" }], messageTurns: [{ id: "turn-1" }] } };

async function app() {
  const root = await mkdtemp(join(tmpdir(), "hub-page-routes-"));
  await writeFile(join(root, "build-info.json"), JSON.stringify({ commit: "a".repeat(40), builtAt: "2026-11-17T00:00:00.000Z" }));
  const service = new Proxy({ getProject: async (principal: { projectIds: string[] }, id: string) => { if (!principal.projectIds.includes(id)) throw Object.assign(new Error("not a member"), { code: "FORBIDDEN" }); return { id }; } },
    { get: (target, name) => name in target ? (target as never)[name] : async () => undefined });
  return buildServer({ service: service as never, milestones: { repoRoot: root, startedAt: "2026-11-17T01:00:00.000Z" },
    drain: { control: { status: async () => drainStatus } as never, isMaintainer: async () => false },
    credentials: [{ token: reader, actorId: "viewer", projectIds: [projectId], permissions: [] }, { token: outsider, actorId: "outsider", projectIds: [otherProject], permissions: [] }] } as never);
}
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

test("the project path gives the drain state the instance path gives, without the list of Runs and Turns for a non-maintainer", async () => {
  const server = await app();
  try {
    const instance = (await server.inject({ url: "/api/instance/drain", headers: headers(reader) })).json();
    const project = await server.inject({ url: `/api/projects/${projectId}/instance-drain`, headers: headers(reader) });
    assert.equal(project.statusCode, 200, project.body);
    assert.deepEqual(project.json(), instance, "the same answer as the instance path");
    assert.equal(project.json().maintainer, false); assert.deepEqual(project.json().inFlight.runs, [], "no list of Runs for a reader who is not a maintainer");
    assert.equal(project.json().inFlight.counts.runs, 1, "the counts and the state are there");
  } finally { await server.close(); }
});

test("the project path needs a login and project membership; the instance path is unchanged", async () => {
  const server = await app();
  try {
    assert.equal((await server.inject({ url: `/api/projects/${projectId}/instance-drain` })).statusCode, 401);
    const foreign = await server.inject({ url: `/api/projects/${projectId}/instance-drain`, headers: headers(outsider) });
    assert.ok(foreign.statusCode >= 400, `another project's member is refused (${foreign.statusCode})`);
    assert.equal((await server.inject({ url: "/api/instance/drain", headers: headers(outsider) })).statusCode, 200, "a local login still reads the instance path as before");
  } finally { await server.close(); }
});

test("the version is also read at the project's path (members only); /api/version stays public", async () => {
  const server = await app();
  try {
    const project = await server.inject({ url: `/api/projects/${projectId}/version`, headers: headers(reader) });
    assert.equal(project.statusCode, 200, project.body);
    assert.deepEqual(project.json(), { commit: "a".repeat(40), builtAt: "2026-11-17T00:00:00.000Z", startedAt: "2026-11-17T01:00:00.000Z" });
    assert.deepEqual((await server.inject({ url: "/api/version" })).json(), project.json(), "the public path says the same");
    assert.equal((await server.inject({ url: `/api/projects/${projectId}/version` })).statusCode, 401);
    assert.ok((await server.inject({ url: `/api/projects/${projectId}/version`, headers: headers(outsider) })).statusCode >= 400);
  } finally { await server.close(); }
});

test("both project paths are ones the Hub forwards (the instance paths are not)", () => {
  for (const path of [`/api/projects/${projectId}/instance-drain`, `/api/projects/${projectId}/version`]) assert.ok(FORWARDED_PATH.test(path), path);
  for (const path of ["/api/instance/drain", "/api/version"]) assert.ok(!FORWARDED_PATH.test(path), `${path} is not forwarded: that is why the page asked the Hub for a 404`);
});
