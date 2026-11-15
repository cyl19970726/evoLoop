import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { runCli } from "../src/application.ts";

async function run(args: string[], state: string, env: Record<string, string> = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(args, {
    EVOLOOP_STATE_DIR: state,
    EVOLOOP_API_URL: "http://127.0.0.1:55371",
    EVOLOOP_TOKEN: "private-test-token",
    ...env,
  }, { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  return { code, stdout, stderr };
}

test("identity migrate prints an explicit before/after table and refuses legacy review by default", async t => {
  const state = await mkdtemp(join(tmpdir(), "evoloop-identity-cli-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const projectId = randomUUID(), input = join(state, "legacy.json"), output = join(state, "current.json");
  await writeFile(input, JSON.stringify([
    { token: "a".repeat(40), actorId: "leader", projectIds: [projectId], permissions: ["read", "write", "review"] },
    { token: "b".repeat(40), actorId: "owner-proxy", projectIds: [projectId], permissions: ["read", "write"] },
  ]));
  const refused = await run(["identity", "migrate", "--input", input, "--out", output], state);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /confirm-review-as-management/);
  const accepted = await run(["identity", "migrate", "--input", input, "--out", output,
    "--confirm-review-as-management"], state);
  assert.equal(accepted.code, 0, accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.output, output);
  assert.deepEqual(result.changes.map((item: { actorId: string; to: string[]; decisions: boolean }) =>
    [item.actorId, item.to, item.decisions]), [
    ["leader", ["task", "document", "session", "management"], true],
    ["owner-proxy", ["task", "document", "session"], false],
  ]);
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(written[0].permissions, ["task", "document", "session", "management"]);
  assert.equal(written[0].decisions, true);
  assert.deepEqual(written[1].permissions, ["task", "document", "session"]);
  assert.equal("decisions" in written[1], false);
});

test("CLI member readback receives the same classes, decision flag, kind and Session scope as the workbench endpoint", async t => {
  const state = await mkdtemp(join(tmpdir(), "evoloop-members-cli-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const projectId = randomUUID(), sessionId = randomUUID();
  const member = {
    actorId: "scoped-agent", identityKind: "agent", canRead: true,
    permissions: ["task", "session"], decisions: true, projectIds: [projectId],
    sessionIds: [sessionId], canWrite: true, canReview: false, pending: null,
  };
  const seen: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: URL | Request | string) => {
    seen.push(`${new URL(String(url)).pathname}${new URL(String(url)).search}`);
    return new Response(JSON.stringify({ projectId, status: "available", source: "local_identities",
      identityFile: "unchanged", items: [member] }), { status: 200 });
  });
  try {
    const result = await run(["get", `/api/projects/${projectId}/members`], state);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).items, [member]);
    assert.deepEqual(seen, [`/api/projects/${projectId}/members`]);
  } finally { fetch.mock.restore(); }
});
