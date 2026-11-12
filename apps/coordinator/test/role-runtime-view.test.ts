import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@evoloop/contracts";
import { defaultRoleSkillSelection, type RoleRuntimeRevision } from "@evoloop/contracts/role-skills";
import type { RuntimeCapabilityListing, RuntimeObservedCapabilities, RuntimeProvider, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { buildServer } from "../src/server.js";
import { roleRuntimeView, type RoleRuntimeViewDeps } from "../src/session-preparation/role-runtime-view.js";

const projectId = "00000000-0000-4000-8000-000000000001", roleId = "00000000-0000-4000-8000-000000000002";
const principal: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
const businessPaths = [".agents/skills/evoloop-workflow/SKILL.md"];

async function skill(dir: string, name: string) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody.\n`);
}

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "evoloop-role-view-")));
  const business = join(root, "evoloop"), repo = join(root, "repo"), home = join(root, "home");
  await skill(join(business, ".agents", "skills"), "evoloop-workflow");
  await mkdir(join(repo, ".git"), { recursive: true });
  await skill(join(repo, ".agents", "skills"), "repo-agents");
  await skill(join(repo, ".claude", "skills"), "repo-claude");
  await skill(join(home, ".agents", "skills"), "mine");
  return { root, business, repo, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const revision = (provider: RuntimeProvider, skills = defaultRoleSkillSelection()): RoleRuntimeRevision => ({ projectId, roleId,
  revision: 1, provider, skills, actorId: "lead", reason: "bind", operationId: null, createdAtUtc: "2026-11-09T00:00:00.000Z" });
const session = (provider: RuntimeProvider, cwd: string, updatedAt: string, state: RuntimeSessionRecord["state"] = "ready") => ({
  projectId, id: `s-${updatedAt}`, roleId, cwd, authorizationScope: "project", model: null, sandbox: "workspace-write",
  approvalPolicy: "on-request", state, version: 1, nativeThreadId: "t", nativeSessionId: "n", operationId: "o", actorId: "lead",
  createdAt: updatedAt, updatedAt, runtimeProvider: provider }) as RuntimeSessionRecord;

function deps(l: Awaited<ReturnType<typeof layout>>, input: { history?: RoleRuntimeRevision[]; sessions?: RuntimeSessionRecord[];
  available?: RuntimeProvider[]; grantCwds?: string[]; grants?: Array<{ actorId: string; cwd: string }>; runtime?: RoleRuntimeViewDeps["runtime"] }): RoleRuntimeViewDeps {
  return {
    service: {
      getRole: async (_p: Principal, project: string, role: string) => {
        if (project !== projectId || role !== roleId) throw new Error("NOT_FOUND");
        return {} as never;
      },
      listRoleRuntimeRevisions: async () => input.history ?? [],
      runtimeProviderSettings: () => ({ defaultProvider: "codex", availableProviders: input.available ?? ["codex", "claude"] }),
      listRuntimeSessions: async () => input.sessions ?? [],
    } as unknown as RoleRuntimeViewDeps["service"],
    runtime: input.runtime,
    roleGrants: () => input.grants ?? (input.grantCwds ?? []).map(cwd => ({ actorId: "lead", cwd })),
    skillRoots: async () => ({ businessRoot: l.business, businessPaths }),
    claudeContextMode: "project",
    home: l.home,
    now: () => new Date("2026-11-09T01:00:00.000Z"),
  };
}

test("an unbound Role reads the default runtime and its files from a granted directory", async () => {
  const l = await layout();
  try {
    const view = await roleRuntimeView(deps(l, { grantCwds: [l.repo] }), principal, projectId, roleId);
    assert.equal(view.provider, "codex");
    assert.equal(view.providerSource, "default");
    assert.equal(view.selectionSource, "default");
    assert.deepEqual(view.workDirectory, { cwd: l.repo, source: "grant", grantCount: 1 });
    assert.equal(view.skillsReportedBy, "files");
    assert.deepEqual(view.skills.map(item => [item.source, item.name, item.selected, item.reason, item.delivery]), [
      ["evoloop", "evoloop-workflow", true, "business", "role_context"],
      ["project", "repo-agents", true, "switch", "native"],
      ["personal", "mine", false, "switch_off", "none"],
    ], "Codex does not read .claude/skills");
    assert.ok(view.notes.some(note => note.includes("内置 skill")));
    assert.equal(view.observedAtUtc, "2026-11-09T01:00:00.000Z");
    await assert.rejects(roleRuntimeView(deps(l, {}), principal, projectId, "00000000-0000-4000-8000-000000000009"), /NOT_FOUND/);
    const nowhere = await roleRuntimeView(deps(l, {}), principal, projectId, roleId);
    assert.equal(nowhere.workDirectory, null);
    assert.deepEqual(nowhere.skills.map(item => item.name), ["evoloop-workflow", "mine"]);
  } finally { await l.cleanup(); }
});

test("a Codex Role shows what the running Codex lists for its latest Session directory", async () => {
  const l = await layout();
  try {
    const listing: RuntimeCapabilityListing = { skills: [
      { name: "repo-agents", path: join(l.repo, ".agents/skills/repo-agents/SKILL.md"), scope: "repo", enabled: true, description: "listed", pluginId: null },
      { name: "skill-installer", path: "/codex/skills/.system/skill-installer/SKILL.md", scope: "system", enabled: true, description: null, pluginId: null },
      { name: "imagegen", path: "/codex/skills/.system/imagegen/SKILL.md", scope: "system", enabled: true, description: null, pluginId: null },
    ], plugins: [{ name: "tools", enabled: true }], mcpServers: null, errors: ["mcpServerStatus/list"] };
    const asked: string[] = [];
    const view = await roleRuntimeView(deps(l, {
      history: [revision("codex", { ...defaultRoleSkillSelection(), add: ["absent-skill"] })],
      sessions: [session("codex", "/old", "2026-11-01T00:00:00.000Z", "closed"), session("codex", l.repo, "2026-11-02T00:00:00.000Z"),
        session("claude", "/other", "2026-11-08T00:00:00.000Z")],
      runtime: { listCapabilitiesFor: async (provider, cwd) => { asked.push(`${provider}:${cwd}`); return listing; },
        latestObservedCapabilities: async () => { throw new Error("not for Codex"); } },
    }), principal, projectId, roleId);
    assert.deepEqual(asked, [`codex:${l.repo}`]);
    assert.equal(view.providerSource, "binding");
    assert.deepEqual(view.workDirectory, { cwd: l.repo, source: "session" });
    assert.equal(view.skillsReportedBy, "codex.list");
    assert.deepEqual(view.skills.map(item => [item.source, item.name, item.selected, item.reason, item.delivery, item.location]), [
      ["evoloop", "evoloop-workflow", true, "business", "role_context", ".agents/skills/evoloop-workflow"],
      ["project", "repo-agents", true, "switch", "native", ".agents/skills/repo-agents"],
      ["builtin", "imagegen", true, "switch", "native", null],
      ["builtin", "skill-installer", false, "self_modifying", "none", null],
    ]);
    assert.equal(view.skills[1]!.description, "listed");
    assert.match(view.skills[1]!.contentHash!, /^[a-f0-9]{64}$/);
    assert.deepEqual(view.missing, ["absent-skill"]);
    assert.deepEqual(view.plugins, [{ name: "tools", enabled: true }]);
    assert.deepEqual(view.mcpServers, []);
    assert.ok(view.notes.some(note => note.includes("mcpServerStatus/list")));
    const failing = await roleRuntimeView(deps(l, { history: [revision("codex")], sessions: [session("codex", l.repo, "2026-11-02T00:00:00.000Z")],
      runtime: { listCapabilitiesFor: async () => { throw new Error("down"); }, latestObservedCapabilities: async () => null } }), principal, projectId, roleId);
    assert.equal(failing.skillsReportedBy, "files", "a failed list falls back to files");
  } finally { await l.cleanup(); }
});

test("a Claude Role shows its files with the latest Turn's report of built-ins, plugins and MCP servers", async () => {
  const l = await layout();
  try {
    const observed: RuntimeObservedCapabilities = { source: "claude.init", observedAtUtc: "2026-11-09T00:30:00.000Z", planHash: "f".repeat(64),
      discoveredSkills: ["simplify", "repo-claude", "evoloop:evoloop-workflow", "project:repo-agents"], allowedSkills: [],
      missingSkills: ["personal:gone"], plugins: ["evoloop", "project"], pluginErrors: [], mcpServers: ["claude.ai Gmail"],
      contextMode: "project", instructions: null };
    const latest = session("claude", l.repo, "2026-11-03T00:00:00.000Z");
    const read: string[] = [];
    const view = await roleRuntimeView(deps(l, { history: [revision("claude")], sessions: [latest],
      runtime: { listCapabilitiesFor: async () => { throw new Error("not for Claude"); },
        latestObservedCapabilities: async value => { read.push(value.id); return observed; } } }), principal, projectId, roleId);
    assert.deepEqual(read, [latest.id]);
    assert.equal(view.skillsReportedBy, "claude.init");
    assert.deepEqual(view.skills.map(item => [item.source, item.name, item.selected, item.delivery]), [
      ["evoloop", "evoloop-workflow", true, "role_context"],
      ["project", "repo-agents", true, "role_context"],
      ["project", "repo-claude", true, "native"],
      ["personal", "mine", false, "none"],
      ["builtin", "simplify", true, "native"],
    ], "project .claude/skills are native in project mode; built-ins come from the report");
    assert.deepEqual(view.plugins, [{ name: "evoloop", enabled: true }, { name: "project", enabled: true }]);
    assert.deepEqual(view.mcpServers, [{ name: "claude.ai Gmail", auth: null }]);
    assert.ok(view.notes.some(note => note.includes("personal:gone")));
    assert.ok(view.notes.some(note => note.includes("下一个 Turn 生效")), "a plan that changed since the Turn is pointed out");
    const undriven = await roleRuntimeView(deps(l, { history: [revision("claude")], sessions: [latest], available: ["codex"],
      runtime: { listCapabilitiesFor: async () => null, latestObservedCapabilities: async () => observed } }), principal, projectId, roleId);
    assert.equal(undriven.providerAvailable, false);
    assert.equal(undriven.skillsReportedBy, "files");
    assert.ok(undriven.notes[0]!.includes("未驱动 claude"));
  } finally { await l.cleanup(); }
});

test("the Role runtime route reads the live view for project readers and says when it is not offered", async () => {
  const l = await layout();
  const token = "reader-token-role-runtime-0000000000", foreign = "foreign-token-role-runtime-000000000";
  const base = deps(l, { grantCwds: [l.repo] });
  const empty = async () => [];
  const service = { ...base.service, listRoleRevisions: empty, listRoleReviews: empty, listRoleHandoffs: empty, listRoleSessionBindings: empty,
    listSchedules: empty, listScheduleRevisions: empty, listScheduleOccurrences: empty,
    listRoles: async () => ({ items: [], nextCursor: null }), getRole: async (p: Principal, project: string) => {
    if (!p.projectIds.includes(project)) throw new DomainError("FORBIDDEN", "project read required");
    return {} as never;
  } } as unknown as RoleRuntimeViewDeps["service"];
  const credentials = [{ token, actorId: "reader", projectIds: [projectId], permissions: ["read" as const] },
    { token: foreign, actorId: "other", projectIds: ["00000000-0000-4000-8000-000000000099"], permissions: ["read" as const] }];
  const url = `/api/projects/${projectId}/roles/${roleId.toUpperCase()}/runtime`;
  const app = await buildServer({ service: service as unknown as WorkflowService, credentials,
    roleRuntimeView: (who, project, role) => roleRuntimeView({ ...base, service }, who, project, role) });
  const bare = await buildServer({ service: service as unknown as WorkflowService, credentials });
  try {
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${foreign}` } })).statusCode, 403);
    const response = await app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().roleId, roleId, "the Role id is read in lower case");
    assert.deepEqual(response.json().skills.map((item: { name: string }) => item.name), ["evoloop-workflow", "repo-agents", "mine"]);
    assert.equal((await app.inject({ url: url.replace("/roles/", "/roles/not-a-uuid-"), headers: { authorization: `Bearer ${token}` } })).statusCode, 400);
    const unavailable = await bare.inject({ url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(unavailable.json().code, "CAPABILITY_UNAVAILABLE");
  } finally { await app.close(); await bare.close(); await l.cleanup(); }
});

test("a Role without a Session starts in its own grant's directory whoever is looking; the skills show to every reader, the path only to a reviewer or a holder of the grant (#fa93783c)", async () => {
  const l = await layout();
  try {
    const reader: Principal = { actorId: "plain-reader", projectIds: [projectId], permissions: ["read"] };
    const holder: Principal = { actorId: "grant-holder", projectIds: [projectId], permissions: ["read", "write"] };
    const grants = [{ actorId: "grant-holder", cwd: l.repo }];
    // 1. A project reader with no grant: the project skill is listed, the directory is "configured" and its path is not sent.
    const seen = await roleRuntimeView(deps(l, { grants }), reader, projectId, roleId);
    assert.deepEqual(seen.workDirectory, { cwd: null, source: "grant", grantCount: 1, hidden: true });
    assert.ok(seen.skills.some(item => item.source === "project" && item.name === "repo-agents"), "the project skill's name shows to every reader");
    assert.ok(!JSON.stringify(seen).includes(l.repo), "the machine's path is nowhere in what the reader gets");
    assert.ok(!seen.notes.some(note => note.includes("还没有会话")), "not the old 'no Session or directory' note");
    // 2. A reviewer, and the holder of a grant of this Role: the path, as before.
    assert.deepEqual((await roleRuntimeView(deps(l, { grants }), principal, projectId, roleId)).workDirectory, { cwd: l.repo, source: "grant", grantCount: 1 });
    assert.deepEqual((await roleRuntimeView(deps(l, { grants }), holder, projectId, roleId)).workDirectory, { cwd: l.repo, source: "grant", grantCount: 1 });
    // The holder of a grant of ANOTHER Role's directory is not a holder of this one: the grants are this Role's.
    assert.equal((await roleRuntimeView(deps(l, { grants: [{ actorId: "someone-else", cwd: l.repo }] }), holder, projectId, roleId)).workDirectory?.hidden, true);
    // Several directories: the first, and how many there are.
    const many = await roleRuntimeView(deps(l, { grants: [{ actorId: "grant-holder", cwd: l.repo }, { actorId: "other", cwd: join(l.root, "zzz") }] }), reader, projectId, roleId);
    assert.deepEqual(many.workDirectory, { cwd: null, source: "grant", grantCount: 2, hidden: true });
    const manyShown = await roleRuntimeView(deps(l, { grants: [{ actorId: "grant-holder", cwd: l.repo }, { actorId: "other", cwd: join(l.root, "zzz") }] }), principal, projectId, roleId);
    assert.equal(manyShown.workDirectory?.cwd, l.repo, "the first of the sorted directories");
    assert.equal(manyShown.workDirectory?.grantCount, 2);
    // 3. A Role with no runtime grant at all: a clear reason, not blank, for every reader.
    for (const who of [reader, principal]) {
      const none = await roleRuntimeView(deps(l, { grants: [] }), who, projectId, roleId);
      assert.equal(none.workDirectory, null);
      assert.ok(none.notes.some(note => note.includes("没有任何运行授权")), "says why there is no directory and no project skill");
    }
    // A Role that already has a Session keeps its rule: the Session's directory, whoever is looking.
    const withSession = await roleRuntimeView(deps(l, { grants, sessions: [session("codex", l.repo, "2026-11-09T00:30:00.000Z")] }), reader, projectId, roleId);
    assert.deepEqual(withSession.workDirectory, { cwd: l.repo, source: "session" });
  } finally { await l.cleanup(); }
});
