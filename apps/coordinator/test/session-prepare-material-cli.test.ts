import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { buildServer } from "../src/server.js";
import { prepareMaterialCli, type MaterialCliBinding } from "../src/configuration.js";
import { resolveLineRecipient } from "../src/session-line/recipient.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const roleId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const otherSessionId = "00000000-0000-4000-8000-000000000005";
const revisionId = "00000000-0000-4000-8000-000000000004";
const token = "r".repeat(40);

/**
 * `session prepare` for a Session under a Role whose residentQueue.roleActors is "dev-agent", signing as its own identity. The preparation config
 * is built by the same `prepareMaterialCli` main.ts uses, from real materialCli entries; only the writer lookup is a fixed set.
 */
async function prepare(entries: MaterialCliBinding[], writers: string[]) {
  const role = { id: roleId, version: 2, currentRevisionId: revisionId, state: "active", proposal: { goal: "G", independentResponsibility: "R", workflow: "W", handoffBoundary: "B" } };
  const empty = async () => [];
  const service = { getProject: async () => ({ id: projectId }), roleRuntimeProvider: async () => "codex" as const, getRole: async () => role,
    getRuntimeSession: async () => { throw new DomainError("NOT_FOUND", "missing"); }, listRoleSessionBindings: empty, listRoleRevisions: empty, listRoleReviews: empty,
    listRoleHandoffs: empty, listSchedules: empty, listScheduleRevisions: empty, listScheduleOccurrences: empty,
    listRoles: async () => ({ items: [], nextCursor: null }) } as unknown as WorkflowService;
  const app = await buildServer({ service, credentials: [{ token, actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] }],
    sessionPreparation: async input => ({ runtimeAvailable: true, grantReady: true, cwdReady: true,
      materialCli: await prepareMaterialCli(entries, input, { ready: async () => true, projectWriter: async (_project, actor) => writers.includes(actor) }),
      roleActorId: "dev-agent", skills: [{ path: ".agents/skills/evoloop-workflow/SKILL.md", commit: "a".repeat(40), contentHash: "b".repeat(64), readSubcommand: "get /fixed" }] }) });
  try {
    const response = await app.inject({ url: `/api/projects/${projectId}/session-preparation/${sessionId}?roleId=${roleId}&cwd=%2Fp&authorizationScope=project&model=m`,
      headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200);
    return response.json() as { missing: string[]; config: { materialCli: { actorId: string } | null } };
  } finally { await app.close(); }
}
const entry = (cliActorId: string, extra: Partial<MaterialCliBinding> = {}): MaterialCliBinding =>
  ({ projectId, sessionActorId: "lead", cliActorId, command: "/private/cli", ...extra }) as MaterialCliBinding;
const identity = (value: { missing: string[] }) => value.missing.filter(code => code.startsWith("material_cli_actor"));

test("a Session with its own materialCli entry is judged by that entry, not by the Role's configured actor", async () => {
  const result = await prepare([entry("acceptance-agent", { sessionId })], ["dev-agent", "acceptance-agent"]);
  assert.deepEqual(identity(result), [], "a different signing identity under the same Role is allowed");
  assert.equal(result.config.materialCli?.actorId, "acceptance-agent", "the Session reads back the identity it signs with");
});

test("the Role-level check stays when the Session has no entry of its own", async () => {
  assert.deepEqual(identity(await prepare([entry("acceptance-agent", { roleId })], ["dev-agent", "acceptance-agent"])), ["material_cli_actor_mismatch"], "a Role entry that differs from roleActors is still refused");
  assert.deepEqual(identity(await prepare([entry("acceptance-agent", { sessionId: otherSessionId })], ["dev-agent", "acceptance-agent"])), [], "another Session's entry is not this Session's binding (no entry, so material_cli is what is missing)");
  assert.deepEqual(identity(await prepare([entry("dev-agent", { roleId })], ["dev-agent"])), [], "a matching Role entry is accepted as before");
});

test("an exact entry naming someone who is not a project writer is refused", async () => {
  const result = await prepare([entry("not-a-writer", { sessionId })], ["dev-agent"]);
  assert.deepEqual(identity(result), ["material_cli_actor_not_writer"]);
});

test("the Session's own entry beats a conflicting Role entry, as the line's recipient rule does", async () => {
  const entries = [entry("dev-agent", { roleId }), entry("acceptance-agent", { sessionId })];
  const result = await prepare(entries, ["dev-agent", "acceptance-agent"]);
  assert.deepEqual(identity(result), []);
  assert.equal(result.config.materialCli?.actorId, "acceptance-agent");
  const recipient = await resolveLineRecipient({ projectId, id: sessionId, roleId, actorId: "lead" },
    { materialCli: entries.map(value => ({ projectId, sessionId: value.sessionId, roleId: value.roleId, sessionActorId: value.sessionActorId, cliActorId: value.cliActorId })),
      roleActors: [{ projectId, roleId, actorId: "dev-agent" }] }, 2, async () => true);
  assert.deepEqual(recipient, { actorId: "acceptance-agent" }, "prepare and the line agree on who signs");
});

test("the onboarding skill and its private-config reference say what prepare now does: an acceptance Session is prepared with its own exact entry", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dirname, "../../../.agents/skills/evoloop-onboarding");
  const skill = await readFile(`${root}/SKILL.md`, "utf8"), config = await readFile(`${root}/references/private-config.md`, "utf8");
  for (const [name, text] of [["SKILL.md", skill], ["private-config.md", config]] as const) {
    assert.ok(!text.includes("验收 Session 不用 `session prepare`"), `${name}: the old advice not to use session prepare is gone`);
    assert.ok(!text.includes("已知不一致，待修"), `${name}: no "known inconsistency, to be fixed" left`);
    assert.ok(!text.includes("不能用 `session prepare` 建"), `${name}: no claim that an acceptance Session cannot be prepared`);
    assert.ok(text.includes("material_cli_actor_not_writer") || name === "SKILL.md", `${name}: the new refusal is named`);
  }
  assert.ok(skill.includes("精确绑定优先") && skill.includes("material_cli_actor_not_writer") && skill.includes("config.materialCli.actorId"), "step 4 names the rule, the refusal and the read-back");
});
