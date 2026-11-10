// Project configuration reads: the caller needs read permission on the project, sees only that project's
// repositories, capabilities and members, never a server path, token or secret, and every conclusion is the one the
// service's own check reaches on the same configuration.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowService } from "@evoloop/core";
import type { Reader, UnitOfWork } from "@evoloop/contracts/ports";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { VersionedConnectorRoute } from "@evoloop/contracts/message-connectors";
import { projectCapabilityKeys, type ProjectCapability } from "@evoloop/contracts/project-configuration";
import { GitDocumentSource } from "@evoloop/adapter-git-documents";
import { buildServer } from "../src/server.ts";
import { authConfigSchema, authenticate, hasCurrentStudyReviewer, isProjectWriter, type AuthConfig } from "../src/auth.ts";
import { hasTaskTimingGrant, knowledgeServesProject, loadIntegrations } from "../src/configuration.ts";
import { CollaborationRunner } from "../src/collaboration/runner.ts";
import { qualifyStandardConnectorRoute } from "../src/message-connectors/qualification.ts";
import { SchedulingPump } from "../src/scheduling/pump.ts";
import { localProjectConfiguration, projectCapabilities, projectMembers, type Integrations } from "../src/project-configuration/local.ts";
import type { ProjectConfigurationSource } from "../src/project-configuration/routes.ts";

const projectA = "00000000-0000-4000-8000-00000000000a";
const projectB = "00000000-0000-4000-8000-00000000000b";
const missingProject = "00000000-0000-4000-8000-00000000000c";
const roleId = "00000000-0000-4000-8000-0000000000e1";
const token = (letter: string) => letter.repeat(40);
const identities = authConfigSchema.parse([
  { token: token("a"), actorId: "owner", projectIds: [projectA, projectB], permissions: ["read", "write", "review"], identityKind: "human" },
  { token: token("b"), actorId: "reader", projectIds: [projectA], permissions: ["read"] },
  // Rotation: the same actor with an older, narrower credential for project A only.
  { token: token("c"), actorId: "rotating", projectIds: [projectA, projectB], permissions: ["read", "write", "review"] },
  { token: token("d"), actorId: "rotating", projectIds: [projectA], permissions: ["read"] },
  { token: token("e"), actorId: "outsider", projectIds: [projectB], permissions: ["read", "write", "review"], identityKind: "human" },
  { token: token("f"), actorId: "writer-only", projectIds: [projectA], permissions: ["write"] },
  { token: token("g"), actorId: "ghost", projectIds: [missingProject], permissions: ["read"] },
  { token: token("h"), actorId: "loop-controller", projectIds: [projectA], permissions: ["read", "write", "review"] },
  { token: token("i"), actorId: "no-review", projectIds: [projectA], permissions: ["read", "write"] },
]);
const auth = (letter: string) => ({ authorization: `Bearer ${token(letter)}` });
const later = "2099-01-01T00:00:00.000Z";

/** Real core authorization over a reader that knows projects A and B only. */
function workflow(): WorkflowService {
  const uow = { read: async <T>(projectId: string, action: (reader: Reader) => Promise<T>) => action({
    getProject: async () => projectId === projectA || projectId === projectB ? { id: projectId, title: "Project" } : null,
  } as unknown as Reader) } as UnitOfWork;
  return new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: value => value } });
}

const secrets = ["/srv/checkouts", "feishu-app-secret", "feishu-app-token", "openviking.internal", "password",
  "/srv/knowledge", "/srv/gateway", "/srv/workers", "/srv/work", "loop-controller"];
const receiver = (fields: Record<string, unknown> = {}) => ({ projectId: projectA, bindingId: randomUUID(), sessionId: randomUUID(),
  senderActorId: "owner", receiverActorId: "owner", receiverRoleId: roleId, cwd: "/srv/work", policyHash: "0".repeat(64),
  maxTurns: 10, enabled: true, ...fields });
const file = (cwd: string) => ({
  repositories: [
    { projectId: projectA, repositoryId: "evoloop", root: "/srv/checkouts/a", allowedPaths: ["docs/", "README.md"] },
    { projectId: projectB, repositoryId: "other-repo", root: "/srv/checkouts/b", allowedPaths: ["src/"] },
  ],
  knowledge: { enabled: true, baseUrl: "http://user:password@openviking.internal:1933", manifestRoot: "/srv/knowledge",
    maintainerId: "maintainer", projectIds: [projectB] },
  scheduling: { enabled: true, grants: [{ projectId: projectA, actorId: "owner", scopeId: "daily-check", roleId }],
    taskTimingGrants: [{ projectId: projectB, actorId: "owner", roleId }] },
  feishu: { enabled: true, appId: "feishu-app-id", appSecret: "feishu-app-secret", appToken: "feishu-app-token", tableId: "table",
    fields: { entityId: "e", localVersion: "v", operationId: "o", title: "t", status: "s" },
    grants: [{ projectId: projectB, actorId: "owner", scope: "project" }] },
  runtime: { enabled: true, grants: [
    { projectId: projectA, actorId: "owner", roleId, authorizationScope: "scope", cwd },
    { projectId: projectA, actorId: "loop-controller", roleId, authorizationScope: "loop", cwd },
  ] },
  orchestration: { enabled: true, controllerActorId: "loop-controller", workerRoot: "/srv/workers" },
  sessionMessages: { enabled: true, grants: [], connectorReceivers: [receiver({ mode: "standard" })] },
  messageConnectors: { enabled: true, gateway: { executable: "/srv/gateway/bin", configPath: "/srv/gateway/config.json" } },
});
type File = ReturnType<typeof file>;

interface Fixture { cwd: string; path: string; loaded: Integrations; reload(content: unknown): Promise<void> }
async function withFixture(edit: (base: File) => unknown, run: (fixture: Fixture) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "evoloop-project-configuration-")));
  const path = join(dir, "integrations.json");
  try {
    await writeFile(path, JSON.stringify(edit(file(dir))));
    const loaded = await loadIntegrations(path);
    await run({ cwd: dir, path, loaded, reload: content => writeFile(path, typeof content === "string" ? content : JSON.stringify(content)) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const same = (base: File) => base;
const sourceFor = (fixture: Fixture, current: () => Promise<AuthConfig> = async () => identities, runtimeAvailable = true) =>
  localProjectConfiguration({ loaded: fixture.loaded, identities, current: () => loadIntegrations(fixture.path),
    currentIdentities: current, facts: () => ({ runtimeAvailable, documents: true }) });
async function server(projectConfiguration?: ProjectConfigurationSource) {
  return buildServer({ credentials: identities, service: workflow(), ...(projectConfiguration ? { projectConfiguration } : {}) });
}
/** The principal HTTP authentication gives the caller who signs in with this token letter. */
const principalOf = (letter: string) => authenticate(`Bearer ${token(letter)}`, identities)!;
async function capabilities(fixture: Fixture, projectId: string, caller = "a",
  current: { identities?: AuthConfig | null; runtimeAvailable?: boolean; loadedIdentities?: AuthConfig } = {}) {
  let integrations: Integrations | null = null;
  try { integrations = await loadIntegrations(fixture.path); } catch { /* unreadable */ }
  const items = await projectCapabilities({ loaded: { integrations: fixture.loaded, identities: current.loadedIdentities ?? identities },
    current: { integrations, identities: current.identities === undefined ? identities : current.identities },
    projectId, caller: principalOf(caller), nowUtc: new Date().toISOString(), runtimeAvailable: current.runtimeAvailable ?? true, documents: true });
  return Object.fromEntries(items.map(item => [item.key, item])) as Record<string, ProjectCapability>;
}
const brief = (item: ProjectCapability) => [item.state, item.reason,
  ...(item.callerGranted === undefined ? [] : [item.callerGranted, item.callerReason])];

test("project configuration reads require read permission on an existing project", async () => {
  await withFixture(same, async fixture => {
    const app = await server(sourceFor(fixture));
    try {
      for (const view of ["repositories", "capabilities", "members"]) {
        assert.equal((await app.inject({ url: `/api/projects/${projectA}/${view}` })).statusCode, 401, view);
        const outsider = await app.inject({ url: `/api/projects/${projectA}/${view}`, headers: auth("e") });
        assert.equal(outsider.statusCode, 403, `another project's member cannot read ${view}`);
        assert.equal(outsider.json().code, "FORBIDDEN");
        assert.equal((await app.inject({ url: `/api/projects/${projectA}/${view}`, headers: auth("f") })).statusCode, 403,
          `${view} needs read, not only write`);
        assert.equal((await app.inject({ url: `/api/projects/${missingProject}/${view}`, headers: auth("g") })).statusCode, 404);
        assert.equal((await app.inject({ url: `/api/projects/not-a-project/${view}`, headers: auth("a") })).statusCode, 400);
        assert.equal((await app.inject({ url: `/api/projects/${projectA}/${view}`, headers: auth("b") })).statusCode, 200,
          `a read-only member reads ${view}`);
      }
    } finally { await app.close(); }
  });
});

test("repositories list what the Git source accepts for this project, never the checkout root", async () => {
  await withFixture(same, async fixture => {
    const app = await server(sourceFor(fixture));
    try {
      const a = await app.inject({ url: `/api/projects/${projectA}/repositories`, headers: auth("b") });
      assert.deepEqual(a.json(), { projectId: projectA, status: "available", items: [{ repositoryId: "evoloop", allowedPaths: ["docs/", "README.md"] }] });
      assert.equal(a.body.includes("/srv/"), false);
      assert.deepEqual((await app.inject({ url: `/api/projects/${projectB}/repositories`, headers: auth("a") })).json().items,
        [{ repositoryId: "other-repo", allowedPaths: ["src/"] }]);
    } finally { await app.close(); }
  });
  // An absolute or escaping allowed path, or a repository registered twice: the Git source refuses the whole list.
  for (const bad of [
    { projectId: projectA, repositoryId: "leaky", root: "/srv/checkouts/a", allowedPaths: ["/srv/checkouts/a/docs/"] },
    { projectId: projectA, repositoryId: "escape", root: "/srv/checkouts/a", allowedPaths: ["../secrets/"] },
    { projectId: projectA, repositoryId: "evoloop", root: "/srv/checkouts/c", allowedPaths: ["src/"] },
  ]) await withFixture(base => ({ ...base, repositories: [...base.repositories, bad] }), async fixture => {
    assert.throws(() => new GitDocumentSource(fixture.loaded.repositories, async () => true), /repository registration/);
    const app = await server(sourceFor(fixture));
    try {
      const body = (await app.inject({ url: `/api/projects/${projectA}/repositories`, headers: auth("a") })).body;
      assert.equal(body.includes("/srv/"), false, "no server path, even inside allowedPaths");
      assert.equal(body.includes("leaky") || body.includes("escape"), false, "an entry the Git source refuses is left out");
      assert.deepEqual(JSON.parse(body), { projectId: projectA, status: "unavailable", reason: "registration_invalid",
        items: bad.repositoryId === "evoloop" ? [] : [{ repositoryId: "evoloop", allowedPaths: ["docs/", "README.md"] }] },
        "this project's entries are listed but marked unreadable; a duplicated identity is not guessed");
      // Another project's bad entry makes this project's entries unreadable too.
      assert.deepEqual((await app.inject({ url: `/api/projects/${projectB}/repositories`, headers: auth("a") })).json(),
        { projectId: projectB, status: "unavailable", reason: "registration_invalid", items: [{ repositoryId: "other-repo", allowedPaths: ["src/"] }] });
    } finally { await app.close(); }
    for (const projectId of [projectA, projectB])
      assert.deepEqual(brief((await capabilities(fixture, projectId)).gitSources!), ["not_configured", "repository_registration_invalid"],
        "no fixed Git source is readable for any project");
  });
  const app = await server({ repositories: async () => ({ accepted: true, items: [{ repositoryId: "r", allowedPaths: ["docs/"], root: "/srv/leak" } as never] }) });
  try {
    assert.deepEqual((await app.inject({ url: `/api/projects/${projectA}/repositories`, headers: auth("a") })).json().items,
      [{ repositoryId: "r", allowedPaths: ["docs/"] }], "a source carrying more answers with contract fields only");
  } finally { await app.close(); }
});

test("capabilities are judged per project and caller, and mark when they are read", async () => {
  await withFixture(same, async fixture => {
    const app = await server(sourceFor(fixture));
    try {
      const a = await app.inject({ url: `/api/projects/${projectA}/capabilities`, headers: auth("a") });
      assert.equal(a.json().status, "available");
      const items = a.json().items as ProjectCapability[];
      assert.deepEqual(items.map(item => item.key), [...projectCapabilityKeys]);
      assert.deepEqual(Object.fromEntries(items.map(item => [item.key, [item.scope, item.readAt, ...brief(item), item.pending]])), {
        gitSources: ["project", "start", "configured", null, null],
        knowledge: ["project", "start", "not_configured", "project_not_configured", null],
        scheduling: ["project", "start_and_use", "configured", null, true, null, null],
        taskTiming: ["project", "start_and_use", "not_configured", "project_not_configured", false, "caller_has_no_grant", null],
        orchestration: ["project", "start", "configured", null, null],
        runtime: ["project", "start_and_use", "configured", null, true, null, null],
        feishu: ["project", "start", "not_configured", "project_not_configured", false, "caller_has_no_grant", null],
        wechat: ["project", "start_and_use", "configured", null, null],
        documentOriginals: ["service", "start", "configured", null, null],
      });
      const b = await app.inject({ url: `/api/projects/${projectB}/capabilities`, headers: auth("a") });
      assert.deepEqual(Object.fromEntries((b.json().items as ProjectCapability[]).map(item => [item.key, brief(item)])), {
        gitSources: ["configured", null], knowledge: ["configured", null],
        scheduling: ["not_configured", "project_not_configured", false, "caller_has_no_grant"], taskTiming: ["configured", null, true, null],
        orchestration: ["not_configured", "controller_not_in_project"],
        runtime: ["not_configured", "project_not_configured", false, "caller_has_no_grant"],
        feishu: ["configured", null, true, null], wechat: ["not_configured", "project_not_configured"], documentOriginals: ["configured", null],
      });
      // The project has grants; this caller holds none of them.
      const reader = (await app.inject({ url: `/api/projects/${projectA}/capabilities`, headers: auth("b") })).json().items as ProjectCapability[];
      assert.deepEqual(reader.filter(item => item.callerGranted !== undefined).map(item => [item.key, item.state, item.callerGranted, item.callerReason]),
        [["scheduling", "configured", false, "caller_has_no_grant"], ["taskTiming", "not_configured", false, "caller_has_no_grant"],
          ["runtime", "configured", false, "caller_has_no_grant"], ["feishu", "not_configured", false, "caller_has_no_grant"]]);
      for (const body of [a.body, b.body]) for (const secret of [...secrets, fixture.cwd, ...identities.map(entry => entry.token)])
        assert.equal(body.includes(secret), false, `capabilities leak ${secret}`);
    } finally { await app.close(); }
  });
});

test("WeChat counts only standard receivers, as route qualification does", async () => {
  const session = { id: randomUUID(), projectId: projectA, roleId, cwd: "/srv/work", state: "ready", sandbox: "danger-full-access",
    approvalPolicy: "never", nativeThreadId: "thread-1", nativeSessionId: "native-1", authorizationScope: "scope" } as unknown as RuntimeSessionRecord;
  for (const mode of [undefined, "restricted", "standard"] as const) {
    const grant = receiver({ sessionId: session.id, ...(mode ? { mode } : {}) });
    await withFixture(base => ({ ...base, sessionMessages: { ...base.sessionMessages, connectorReceivers: [grant] } }), async fixture => {
      const route = { projectId: projectA, bindingId: grant.bindingId, mode: "standard", targetSessionId: session.id,
        senderActorId: "owner", targetActorId: "owner", policyHash: grant.policyHash, targetThreadId: "thread-1", owner: "o",
        epoch: 1, sessionRef: "ref", source: { conversationId: "c" } } as unknown as VersionedConnectorRoute;
      const qualified = await qualifyStandardConnectorRoute(route, session, fixture.loaded, { projectWriter: async () => true,
        businessActor: async () => true, sessionAuthority: async () => true, cwdCurrent: async () => true, nativeReady: async () => true,
        gatewayBinding: async () => ({ conversation_id: "c", owner: "o", epoch: 1, control: "active", owner_session_ref: "ref", thread_id: "thread-1" }) });
      const wechat = (await capabilities(fixture, projectA)).wechat!;
      assert.equal(qualified, mode === "standard", `qualification of a ${mode ?? "default"} receiver`);
      assert.equal(wechat.state === "configured", qualified, `capability agrees for a ${mode ?? "default"} receiver`);
    });
  }
  await withFixture(base => ({ ...base, messageConnectors: { ...base.messageConnectors, enabled: false } }), async fixture =>
    assert.deepEqual(brief((await capabilities(fixture, projectA)).wechat!), ["not_configured", "message_connectors_disabled"]));
  await withFixture(base => ({ ...base, sessionMessages: { ...base.sessionMessages, enabled: false } }), async fixture =>
    assert.deepEqual(brief((await capabilities(fixture, projectA)).wechat!), ["not_configured", "session_messages_disabled"]));
  await withFixture(base => { const { messageConnectors: _, ...rest } = base; return rest; }, async fixture =>
    assert.deepEqual(brief((await capabilities(fixture, projectA)).wechat!), ["not_configured", "gateway_not_configured"]));
});

test("orchestration and runtime count only grants and templates the controller can act on", async () => {
  const template = (fields: Record<string, unknown>) => ({ id: randomUUID(), revision: 1, projectId: projectA, goalId: randomUUID(),
    loopId: randomUUID(), existingRoleIds: [], newRoleAllocation: null, firstTaskId: randomUUID(), actorId: "loop-controller",
    authorizationScopeId: "s", allowedChoices: ["temporary-assignment"], model: "m", expiresAtUtc: later, ...fields });
  const onlyTemplates = (templates: (cwd: string) => unknown[]) => (base: File) => ({ ...base,
    runtime: { enabled: true, grants: [], delegationTemplates: templates(base.runtime.grants[0]!.cwd) } });
  // An expired template, or another actor's, is no usable delegation; nor does a template make the controller act.
  for (const fields of [{ expiresAtUtc: "2020-01-01T00:00:00Z" }, { actorId: "owner" }])
    await withFixture(onlyTemplates(cwd => [template({ cwd, ...fields })]), async fixture => {
      const items = await capabilities(fixture, projectA);
      assert.deepEqual(brief(items.orchestration!), ["not_configured", "project_not_configured"]);
      assert.deepEqual(brief(items.runtime!), ["not_configured", "project_not_configured", false, "caller_has_no_grant"]);
    });
  await withFixture(onlyTemplates(cwd => [template({ cwd })]), async fixture => {
    const items = await capabilities(fixture, projectA, "h");
    assert.ok(await fixture.loaded.getDelegationTemplate(projectA, fixture.loaded.runtime!.delegationTemplates[0]!.id));
    assert.deepEqual(brief(items.runtime!), ["configured", null, true, null], "the controller's own current template");
    assert.deepEqual(brief(items.orchestration!), ["not_configured", "project_not_configured"], "loops still need a controller grant");
    assert.equal((await capabilities(fixture, projectA, "a")).runtime!.callerGranted, false);
  });
  await withFixture(base => ({ ...base, orchestration: { ...base.orchestration, enabled: false },
    runtime: { enabled: true, grants: [], delegationTemplates: [template({ cwd: base.runtime.grants[0]!.cwd })] } }), async fixture => {
    const items = await capabilities(fixture, projectA, "h");
    assert.deepEqual(brief(items.runtime!), ["not_configured", "project_not_configured", false, "caller_has_no_grant"], "templates need orchestration");
    assert.deepEqual(brief(items.orchestration!), ["not_configured", "orchestration_disabled"]);
  });
  // Static grants: the reservation check (hasRuntimeGrant and allowedRuntimeCwd) on the same configuration.
  await withFixture(same, async fixture => {
    for (const grant of fixture.loaded.runtime!.grants) assert.equal(fixture.loaded.hasRuntimeGrant(grant) &&
      await fixture.loaded.allowedRuntimeCwd(projectA, grant.cwd), true);
  });
  await withFixture(base => ({ ...base, runtime: { enabled: true, grants: base.runtime.grants.map(grant => ({ ...grant, cwd: "/srv/missing" })) } }),
    async fixture => {
      assert.equal(await fixture.loaded.allowedRuntimeCwd(projectA, "/srv/missing"), false);
      const items = await capabilities(fixture, projectA);
      assert.deepEqual(brief(items.runtime!), ["not_configured", "grant_directory_unavailable", false, "caller_has_no_grant"]);
      assert.deepEqual(brief(items.orchestration!), ["not_configured", "grant_directory_unavailable"]);
    });
  await withFixture(base => ({ ...base, runtime: { enabled: true, grants: [...base.runtime.grants,
    { ...base.runtime.grants[1]!, authorizationScope: "second" }] } }), async fixture =>
    assert.deepEqual(brief((await capabilities(fixture, projectA)).orchestration!), ["not_configured", "controller_grants_ambiguous"]));
  await withFixture(same, async fixture =>
    assert.deepEqual(brief((await capabilities(fixture, projectA, "a", { runtimeAvailable: false })).runtime!),
      ["configured", "runtime_unavailable", true, null]));
  // The controller's permissions show only in projects the controller is in.
  await withFixture(same, async fixture => {
    const weak = identities.map(entry => entry.actorId === "loop-controller" ? { ...entry, permissions: ["read", "write"] as typeof entry.permissions } : entry);
    assert.deepEqual(brief((await capabilities(fixture, projectA, "a", { loadedIdentities: weak })).orchestration!), ["not_configured", "controller_not_authorized"]);
    assert.deepEqual(brief((await capabilities(fixture, projectB, "a", { loadedIdentities: weak })).orchestration!), ["not_configured", "controller_not_in_project"]);
  });
});

test("scheduling, daily copies, Feishu and knowledge agree with the checks the service runs", async () => {
  const store = { listActive: async () => [], listQueued: async () => [] } as never;
  const pumpState = async (grants: Array<{ projectId: string; actorId: string; scopeId: string; roleId: string }>) =>
    (await new SchedulingPump({ store, canWrite: () => true, credentials: () => identities, grants: () => grants, enabled: () => true }).tickOnce()).state;
  // A schedule grant whose holder lacks review: the pump has no authority, and the capability says why.
  await withFixture(base => ({ ...base, scheduling: { ...base.scheduling, grants: [{ projectId: projectA, actorId: "no-review", scopeId: "daily", roleId }] } }),
    async fixture => {
      assert.equal(await pumpState(fixture.loaded.scheduling!.grants), "no-authority");
      assert.deepEqual(brief((await capabilities(fixture, projectA, "i")).scheduling!),
        ["not_configured", "grant_holder_not_authorized", false, "caller_lacks_review"]);
    });
  await withFixture(same, async fixture => {
    assert.equal(await pumpState(fixture.loaded.scheduling!.grants), "completed");
    assert.equal((await capabilities(fixture, projectA)).scheduling!.state, "configured");
    // Each tick reads the integration file again (main.ts taskTimingGrants); unreadable, the tick fails, schedules too.
    await fixture.reload("{");
    const pump = new SchedulingPump({ store, canWrite: () => true, credentials: () => identities, grants: () => fixture.loaded.scheduling!.grants,
      enabled: () => true, taskTimingGrants: async () => (await loadIntegrations(fixture.path)).scheduling?.taskTimingGrants ?? [] });
    await assert.rejects(pump.tickOnce(), /Invalid integration configuration/);
    assert.deepEqual(brief((await capabilities(fixture, projectA)).scheduling!).slice(0, 2), ["unknown", "configuration_unreadable"]);
  });
  // Daily copies: only a task-timing scope ending in a UUID counts, as hasTaskTimingGrant.
  for (const [scopeId, counted] of [["task-timing:not-a-uuid", false], [`task-timing:${randomUUID()}`, true]] as const)
    await withFixture(base => ({ ...base, scheduling: { enabled: true, taskTimingGrants: [],
      grants: [{ projectId: projectA, actorId: "owner", scopeId, roleId }] } }), async fixture => {
      assert.equal(hasTaskTimingGrant(fixture.loaded.scheduling, projectA, "owner", roleId, scopeId), counted);
      const timing = (await capabilities(fixture, projectA)).taskTiming!;
      assert.deepEqual([timing.state === "configured", timing.callerGranted], [counted, counted], scopeId);
    });
  // A daily-copy grant whose actor no longer has read, write and review in the identity file is not acted on.
  await withFixture(base => ({ ...base, scheduling: { enabled: true, grants: [], taskTimingGrants: [{ projectId: projectA, actorId: "rotating", roleId }] } }),
    async fixture => {
      const now = identities.filter(entry => !(entry.actorId === "rotating" && entry.permissions.includes("review")));
      assert.deepEqual(brief((await capabilities(fixture, projectA, "c", { identities: now })).taskTiming!),
        ["not_configured", "grant_holder_not_authorized", false, "caller_not_current_writer"]);
      assert.equal((await capabilities(fixture, projectA, "c")).taskTiming!.state, "configured");
    });
  // Feishu: CollaborationRunner.status, over the same configuration and identities.
  for (const grants of [[{ projectId: projectA, actorId: "owner", scope: "project" }], [{ projectId: projectA, actorId: "reader", scope: "project" }], []])
    await withFixture(base => ({ ...base, feishu: { ...base.feishu, grants } }), async fixture => {
      const feishu = fixture.loaded.feishu!;
      const runner = new CollaborationRunner({ store: {} as never, workflow: {} as never, connector: {} as never, consumerId: "feishu",
        principals: identities, canWrite: () => true, allowProjection: async () => true,
        hasGrant: (projectId, actorId) => feishu.enabled && feishu.grants.some(g => g.projectId === projectId && g.actorId === actorId) });
      const item = (await capabilities(fixture, projectA)).feishu!;
      assert.equal(item.state === "configured", runner.status(projectA).configured, JSON.stringify(grants));
      if (grants[0]?.actorId === "reader") assert.equal(item.reason, "grant_holder_not_authorized");
    });
  await withFixture(same, async fixture => {
    for (const projectId of [projectA, projectB])
      assert.equal((await capabilities(fixture, projectId)).knowledge!.state === "configured", knowledgeServesProject(fixture.loaded.knowledge, projectId));
  });
});

test("a caller holding a grant still needs the token permissions the request requires", async () => {
  // no-review signs in with a read-write token; reader with a read-only one.
  await withFixture(base => ({ ...base,
    scheduling: { enabled: true, grants: [{ projectId: projectA, actorId: "no-review", scopeId: "daily", roleId }],
      taskTimingGrants: [{ projectId: projectA, actorId: "no-review", roleId }] },
    runtime: { enabled: true, grants: [{ ...base.runtime.grants[0]!, actorId: "no-review" }] },
    feishu: { ...base.feishu, grants: [{ projectId: projectA, actorId: "no-review", scope: "project" }, { projectId: projectA, actorId: "reader", scope: "project" }] },
  }), async fixture => {
    const asNoReview = await capabilities(fixture, projectA, "i");
    // schedule.create and runtime.session.reserve need review (server.ts, before any grant); daily copies (core execute)
    // and Feishu actions (collaboration routes) need write and review.
    for (const key of ["scheduling", "runtime", "taskTiming", "feishu"])
      assert.deepEqual([asNoReview[key]!.callerGranted, asNoReview[key]!.callerReason], [false, "caller_lacks_review"], key);
    const asReader = await capabilities(fixture, projectA, "b");
    assert.deepEqual([asReader.feishu!.callerGranted, asReader.feishu!.callerReason], [false, "caller_lacks_write_and_review"]);
    assert.deepEqual([asReader.scheduling!.callerGranted, asReader.scheduling!.callerReason], [false, "caller_has_no_grant"]);
  });
});

test("what is in effect comes first; a restart's change is pending, not unknown", async () => {
  await withFixture(base => ({ ...base, runtime: { ...base.runtime, grants: [base.runtime.grants[1]!] } }), async fixture => {
    // A runtime grant added after start is read on use, so it is in effect now.
    await fixture.reload(file(fixture.cwd));
    const runtime = (await capabilities(fixture, projectA)).runtime!;
    assert.deepEqual([...brief(runtime), runtime.pending], ["configured", null, true, null, null]);
  });
  await withFixture(base => ({ ...base, knowledge: { ...base.knowledge, enabled: false }, repositories: [] }), async fixture => {
    // Knowledge and repositories are read at start: the loaded state stays in effect until a restart.
    await fixture.reload(file(fixture.cwd));
    const items = await capabilities(fixture, projectA);
    assert.deepEqual(brief(items.gitSources!), ["not_configured", "project_not_configured"]);
    assert.deepEqual(items.gitSources!.pending, { state: "configured", reason: null });
    assert.deepEqual(brief(items.knowledge!), ["not_configured", "knowledge_disabled"]);
    assert.deepEqual(items.knowledge!.pending, { state: "not_configured", reason: "project_not_configured" });
  });
  await withFixture(same, async fixture => {
    // WeChat switches are read on use: turning them off takes effect now.
    await fixture.reload({ ...file(fixture.cwd), messageConnectors: { ...file(fixture.cwd).messageConnectors, enabled: false } });
    const wechat = (await capabilities(fixture, projectA)).wechat!;
    assert.deepEqual([...brief(wechat), wechat.pending], ["not_configured", "message_connectors_disabled", null]);
  });
  await withFixture(same, async fixture => {
    await fixture.reload("{");
    const items = await capabilities(fixture, projectA);
    assert.deepEqual([...brief(items.gitSources!), items.gitSources!.pending], ["configured", null, { state: "unknown", reason: "configuration_unreadable" }]);
    assert.deepEqual(brief(items.wechat!), ["unknown", "configuration_unreadable"], "read on use, and the file cannot be read");
    assert.deepEqual(brief(items.scheduling!), ["unknown", "configuration_unreadable", true, null], "every tick reads the file again");
    const app = await server(sourceFor(fixture));
    try {
      const gitSources = ((await app.inject({ url: `/api/projects/${projectA}/capabilities`, headers: auth("a") })).json().items as ProjectCapability[])
        .find(item => item.key === "gitSources");
      assert.deepEqual(gitSources?.pending, { state: "unknown", reason: "configuration_unreadable" });
    } finally { await app.close(); }
  });
});

test("members say what each actor may do by the service's own checks, and never a token", async () => {
  await withFixture(same, async fixture => {
    const app = await server(sourceFor(fixture));
    try {
      const a = await app.inject({ url: `/api/projects/${projectA}/members`, headers: auth("b") });
      assert.deepEqual(a.json(), { projectId: projectA, status: "available", source: "local_identities", identityFile: "unchanged", items: [
        { actorId: "loop-controller", identityKind: "agent", canRead: true, canWrite: true, canReview: true, pending: null },
        { actorId: "no-review", identityKind: "agent", canRead: true, canWrite: true, canReview: false, pending: null },
        { actorId: "owner", identityKind: "human", canRead: true, canWrite: true, canReview: true, pending: null },
        { actorId: "reader", identityKind: "agent", canRead: true, canWrite: false, canReview: false, pending: null },
        // Rotation to a narrower token: one credential still reads and writes; review needs every credential complete.
        { actorId: "rotating", identityKind: "agent", canRead: true, canWrite: true, canReview: false, pending: null },
        { actorId: "writer-only", identityKind: "agent", canRead: false, canWrite: false, canReview: false, pending: null },
      ] });
      const b = await app.inject({ url: `/api/projects/${projectB}/members`, headers: auth("e") });
      assert.deepEqual(b.json().items.map((item: { actorId: string }) => item.actorId), ["outsider", "owner", "rotating"]);
      for (const body of [a.body, b.body]) {
        for (const entry of identities) {
          assert.equal(body.includes(entry.token), false);
          assert.equal(body.includes(entry.token.slice(0, 8)), false, "no token prefix");
        }
        assert.equal(/token|projectIds/i.test(body), false);
      }
      assert.equal(a.body.includes("outsider") || a.body.includes("ghost"), false, "another project's member is not listed");
    } finally { await app.close(); }
  });
  // Each ability is the service's check on the same identities.
  const { items } = projectMembers(identities, identities, projectA);
  for (const member of items) {
    const tokens = identities.filter(entry => entry.actorId === member.actorId).map(entry => entry.token);
    assert.equal(member.canRead, tokens.some(value => {
      const principal = authenticate(`Bearer ${value}`, identities);
      return !!principal && principal.projectIds.includes(projectA) && principal.permissions.includes("read");
    }), `${member.actorId} sign-in`);
    // Unchanged file: the loaded token and currentProjectWriter agree.
    assert.equal(member.canWrite, isProjectWriter(identities, projectA, member.actorId), `${member.actorId} currentProjectWriter`);
    assert.equal(member.canReview, hasCurrentStudyReviewer(identities, projectA, member.actorId), `${member.actorId} reviewer`);
  }
});

test("a changed identity file is marked, with what is in effect now and what a restart changes", async () => {
  const now = authConfigSchema.parse([
    ...identities.filter(entry => entry.actorId !== "reader" && entry.token !== token("d")),
    { token: token("j"), actorId: "newcomer", projectIds: [projectA], permissions: ["read", "write", "review"], identityKind: "human" },
  ]);
  const view = projectMembers(identities, now, projectA);
  assert.equal(view.identityFile, "changed");
  const by = Object.fromEntries(view.items.map(item => [item.actorId, item]));
  assert.deepEqual(by.newcomer, { actorId: "newcomer", identityKind: "human", canRead: false, canWrite: false, canReview: false,
    pending: { identityKind: "human", canRead: true, canWrite: true, canReview: true } }, "no token yet: nothing before a restart");
  assert.deepEqual(by.reader, { actorId: "reader", identityKind: "agent", canRead: true, canWrite: false, canReview: false,
    pending: { identityKind: "agent", canRead: false, canWrite: false, canReview: false } }, "removed: still signs in until a restart");
  assert.deepEqual(by.rotating!.pending, { identityKind: "agent", canRead: true, canWrite: true, canReview: true }, "the narrower token is gone");
  assert.equal(by.owner!.pending, null);
  // Rotating a token without changing what it grants is not a change for this view.
  const rotated = identities.map(entry => entry.actorId === "owner" ? { ...entry, token: token("k") } : entry);
  assert.equal(projectMembers(identities, rotated, projectA).identityFile, "unchanged");
  const unreadable = projectMembers(identities, null, projectA);
  assert.equal(unreadable.identityFile, "unreadable");
  assert.ok(unreadable.items.every(item => item.pending === null &&
    item.canWrite === (isProjectWriter(identities, projectA, item.actorId) ? null : false)),
    "without a loaded write token the answer is no; with one, the writer check reads the file and cannot answer");
  // Write added only in the file: the token signed in with still lacks it, so a write (such as recording acceptance)
  // is refused until a restart.
  const acceptorLoaded = authConfigSchema.parse([{ token: token("x"), actorId: "acceptor", projectIds: [projectA], permissions: ["read"], identityKind: "human" }]);
  const acceptorNow = authConfigSchema.parse([{ token: token("x"), actorId: "acceptor", projectIds: [projectA], permissions: ["read", "write"], identityKind: "human" }]);
  const acceptor = projectMembers(acceptorLoaded, acceptorNow, projectA);
  assert.equal(authenticate(`Bearer ${token("x")}`, acceptorLoaded)!.permissions.includes("write"), false);
  assert.equal(isProjectWriter(acceptorNow, projectA, "acceptor"), true, "currentProjectWriter alone would say yes");
  assert.deepEqual(acceptor, { identityFile: "changed", items: [{ actorId: "acceptor", identityKind: "human", canRead: true, canWrite: false,
    canReview: false, pending: { identityKind: "human", canRead: true, canWrite: true, canReview: false } }] });
  await withFixture(same, async fixture => {
    const app = await server(sourceFor(fixture, async () => { throw new Error("identity file is not valid JSON"); }));
    try {
      const body = (await app.inject({ url: `/api/projects/${projectA}/members`, headers: auth("a") })).json();
      assert.equal(body.identityFile, "unreadable");
      assert.equal(body.items.find((item: { actorId: string }) => item.actorId === "owner").canRead, true);
    } finally { await app.close(); }
  });
});

test("without a source, or when it fails, each view says unavailable instead of an empty list", async () => {
  const app = await server();
  try {
    for (const view of ["repositories", "capabilities", "members"]) {
      const response = await app.inject({ url: `/api/projects/${projectA}/${view}`, headers: auth("a") });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { projectId: projectA, status: "unavailable", reason: "not_provided" }, view);
    }
  } finally { await app.close(); }
  const failing = await server({
    members: { kind: "hub", list: async () => { throw new Error("hub offline at https://hub.internal with key sk-secret"); } },
    capabilities: async () => { throw new Error("unreadable"); },
  });
  try {
    const members = await failing.inject({ url: `/api/projects/${projectA}/members`, headers: auth("a") });
    assert.deepEqual(members.json(), { projectId: projectA, status: "unavailable", reason: "read_failed" });
    assert.equal(members.body.includes("sk-secret"), false);
    assert.deepEqual((await failing.inject({ url: `/api/projects/${projectA}/capabilities`, headers: auth("a") })).json(),
      { projectId: projectA, status: "unavailable", reason: "read_failed" });
    assert.equal((await failing.inject({ url: `/api/projects/${projectA}/members`, headers: auth("e") })).statusCode, 403,
      "authorization is checked before the source");
  } finally { await failing.close(); }
});
