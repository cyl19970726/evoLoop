// Project configuration reads: the caller needs read permission on the project, sees only that project's
// repositories, capabilities and members, and never a server path, token or secret.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowService } from "@evoloop/core";
import type { Reader, UnitOfWork } from "@evoloop/contracts/ports";
import { projectCapabilityKeys, type ProjectCapability } from "@evoloop/contracts/project-configuration";
import { buildServer } from "../src/server.ts";
import { authConfigSchema, hasCurrentStudyReviewer, projectMembers } from "../src/auth.ts";
import { loadIntegrations } from "../src/configuration.ts";
import { localProjectConfiguration, observedProjectCapabilities, projectCapabilities,
  type IntegrationConfiguration, type ServiceFacts } from "../src/project-configuration/local.ts";
import type { ProjectConfigurationSource } from "../src/project-configuration/routes.ts";

const projectA = "00000000-0000-4000-8000-00000000000a";
const projectB = "00000000-0000-4000-8000-00000000000b";
const missingProject = "00000000-0000-4000-8000-00000000000c";
const roleId = "00000000-0000-4000-8000-0000000000e1";
const token = (letter: string) => letter.repeat(40);
const credentials = authConfigSchema.parse([
  { token: token("a"), actorId: "owner", projectIds: [projectA, projectB], permissions: ["read", "write", "review"], identityKind: "human" },
  { token: token("b"), actorId: "reader", projectIds: [projectA], permissions: ["read"] },
  // Rotation: the same actor with an older, narrower credential for project A only.
  { token: token("c"), actorId: "rotating", projectIds: [projectA, projectB], permissions: ["read", "write", "review"] },
  { token: token("d"), actorId: "rotating", projectIds: [projectA], permissions: ["read", "write"] },
  { token: token("e"), actorId: "outsider", projectIds: [projectB], permissions: ["read", "write", "review"], identityKind: "human" },
  { token: token("f"), actorId: "writer-only", projectIds: [projectA], permissions: ["write"] },
  { token: token("g"), actorId: "ghost", projectIds: [missingProject], permissions: ["read"] },
]);
const auth = (letter: string) => ({ authorization: `Bearer ${token(letter)}` });

/** Real core authorization over a reader that knows projects A and B only. */
function workflow(): WorkflowService {
  const uow = { read: async <T>(projectId: string, action: (reader: Reader) => Promise<T>) => action({
    getProject: async () => projectId === projectA || projectId === projectB ? { id: projectId, title: "Project" } : null,
  } as unknown as Reader) } as UnitOfWork;
  return new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: value => value } });
}

const secrets = ["/srv/checkouts/a", "/srv/checkouts/b", "feishu-app-secret", "feishu-app-token", "openviking.internal",
  "/srv/knowledge", "/srv/work/a", "/srv/gateway/bin", "/srv/gateway/config.json", "/srv/workers"];
const integrationFile = {
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
  runtime: { enabled: true, grants: [{ projectId: projectA, actorId: "owner", roleId, authorizationScope: "scope", cwd: "/srv/work/a" }] },
  orchestration: { enabled: true, controllerActorId: "owner", workerRoot: "/srv/workers" },
  sessionMessages: { enabled: true, grants: [], connectorReceivers: [{ projectId: projectA, bindingId: randomUUID(), sessionId: randomUUID(),
    mode: "standard", senderActorId: "owner", receiverActorId: "owner", receiverRoleId: roleId, cwd: "/srv/work/a",
    policyHash: "0".repeat(64), maxTurns: 10, enabled: true }] },
  messageConnectors: { enabled: true, gateway: { executable: "/srv/gateway/bin", configPath: "/srv/gateway/config.json" } },
};
const facts: Omit<ServiceFacts, "identities"> = { runtimeAvailable: true, managedLoops: true, connectorIngress: true, documents: true };

async function withConfiguration(run: (path: string, loaded: IntegrationConfiguration) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "evoloop-project-configuration-")), path = join(dir, "integrations.json");
  try {
    await writeFile(path, JSON.stringify(integrationFile));
    await run(path, await loadIntegrations(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function server(projectConfiguration?: ProjectConfigurationSource) {
  return buildServer({ credentials, service: workflow(), ...(projectConfiguration ? { projectConfiguration } : {}) });
}
const states = (items: ProjectCapability[]) => Object.fromEntries(items.map(item => [item.key, [item.scope, item.state, item.reason]]));

test("project configuration reads require read permission on an existing project", async () => {
  await withConfiguration(async (path, loaded) => {
    const app = await server(localProjectConfiguration({ loaded, identities: credentials, current: () => loadIntegrations(path), facts: () => facts }));
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

test("repositories list only this project's identity and paths, never the checkout root", async () => {
  await withConfiguration(async (path, loaded) => {
    const app = await server(localProjectConfiguration({ loaded, identities: credentials, current: () => loadIntegrations(path), facts: () => facts }));
    try {
      const a = await app.inject({ url: `/api/projects/${projectA}/repositories`, headers: auth("b") });
      assert.deepEqual(a.json(), { projectId: projectA, status: "available", items: [{ repositoryId: "evoloop", allowedPaths: ["docs/", "README.md"] }] });
      assert.equal(a.body.includes("/srv/"), false);
      const b = await app.inject({ url: `/api/projects/${projectB}/repositories`, headers: auth("a") });
      assert.deepEqual(b.json().items, [{ repositoryId: "other-repo", allowedPaths: ["src/"] }]);
    } finally { await app.close(); }
  });
  // A source that carries more than the contract still answers with the contract fields only.
  const app = await server({ repositories: async () => [{ repositoryId: "r", allowedPaths: ["docs/"], root: "/srv/leak" } as never] });
  try {
    const response = await app.inject({ url: `/api/projects/${projectA}/repositories`, headers: auth("a") });
    assert.deepEqual(response.json().items, [{ repositoryId: "r", allowedPaths: ["docs/"] }]);
  } finally { await app.close(); }
});

test("capabilities are judged per project and mark service-wide settings", async () => {
  await withConfiguration(async (path, loaded) => {
    const app = await server(localProjectConfiguration({ loaded, identities: credentials, current: () => loadIntegrations(path), facts: () => facts }));
    try {
      const a = await app.inject({ url: `/api/projects/${projectA}/capabilities`, headers: auth("b") });
      assert.equal(a.statusCode, 200);
      assert.equal(a.json().status, "available");
      assert.deepEqual(a.json().items.map((item: ProjectCapability) => item.key), [...projectCapabilityKeys]);
      assert.deepEqual(states(a.json().items), {
        gitSources: ["project", "configured", null],
        knowledge: ["project", "not_configured", "project_not_configured"],
        scheduling: ["project", "configured", null],
        taskTiming: ["project", "not_configured", "project_not_configured"],
        orchestration: ["project", "configured", null],
        runtime: ["project", "configured", null],
        feishu: ["project", "not_configured", "project_not_configured"],
        wechat: ["project", "configured", null],
        documentOriginals: ["service", "configured", null],
      });
      const b = await app.inject({ url: `/api/projects/${projectB}/capabilities`, headers: auth("a") });
      assert.deepEqual(states(b.json().items), {
        gitSources: ["project", "configured", null],
        knowledge: ["project", "configured", null],
        scheduling: ["project", "not_configured", "project_not_configured"],
        taskTiming: ["project", "configured", null],
        orchestration: ["project", "not_configured", "project_not_configured"],
        runtime: ["project", "not_configured", "project_not_configured"],
        feishu: ["project", "configured", null],
        wechat: ["project", "not_configured", "project_not_configured"],
        documentOriginals: ["service", "configured", null],
      });
      for (const body of [a.body, b.body]) for (const secret of [...secrets, "password", "owner", ...credentials.map(c => c.token)])
        assert.equal(body.includes(secret), false, `capabilities leak ${secret}`);
    } finally { await app.close(); }
  });
});

test("capabilities say why something is off, and stay unknown when the file disagrees or cannot be read", async () => {
  await withConfiguration(async (_path, loaded) => {
    const identities = credentials;
    const off = projectCapabilities({ ...loaded, knowledge: undefined, scheduling: undefined, feishu: undefined, runtime: undefined,
      orchestration: undefined, sessionMessages: undefined, messageConnectors: undefined, repositories: [] },
    { ...facts, identities, documents: false }, projectA);
    assert.deepEqual(states(off), {
      gitSources: ["project", "not_configured", "project_not_configured"],
      knowledge: ["project", "not_configured", "service_not_enabled"],
      scheduling: ["project", "not_configured", "service_not_enabled"],
      taskTiming: ["project", "not_configured", "service_not_enabled"],
      orchestration: ["project", "not_configured", "service_not_enabled"],
      runtime: ["project", "not_configured", "service_not_enabled"],
      feishu: ["project", "not_configured", "service_not_enabled"],
      wechat: ["project", "not_configured", "service_not_enabled"],
      documentOriginals: ["service", "not_configured", "service_not_enabled"],
    });
    const stopped = states(projectCapabilities(loaded, { ...facts, identities, runtimeAvailable: false, managedLoops: false, connectorIngress: false }, projectA));
    assert.deepEqual(stopped.runtime, ["project", "configured", "runtime_unavailable"]);
    assert.deepEqual(stopped.orchestration, ["project", "not_configured", "service_not_enabled"], "managed loops were not set up at start");
    assert.deepEqual(stopped.wechat, ["project", "not_configured", "service_not_enabled"], "no gateway ingress at start");
    // A grant written as a task-timing scope counts for daily copies, not for ordinary schedules.
    const timingScope = states(projectCapabilities({ ...loaded, scheduling: { ...loaded.scheduling!, taskTimingGrants: [],
      grants: [{ projectId: projectA, actorId: "owner", scopeId: `task-timing:${randomUUID()}`, roleId }] } }, { ...facts, identities }, projectA));
    assert.deepEqual([timingScope.scheduling, timingScope.taskTiming],
      [["project", "not_configured", "project_not_configured"], ["project", "configured", null]]);

    const loadedItems = projectCapabilities(loaded, { ...facts, identities }, projectA);
    assert.deepEqual(observedProjectCapabilities(loadedItems, loadedItems), loadedItems);
    const unreadable = states(observedProjectCapabilities(loadedItems, null));
    for (const key of projectCapabilityKeys.filter(key => key !== "documentOriginals"))
      assert.deepEqual(unreadable[key]!.slice(1), ["unknown", "configuration_unreadable"], key);
    assert.deepEqual(unreadable.documentOriginals, ["service", "configured", null]);
    const changed = states(observedProjectCapabilities(loadedItems,
      projectCapabilities({ ...loaded, repositories: [] }, { ...facts, identities }, projectA)));
    assert.deepEqual(changed.gitSources, ["project", "unknown", "configuration_changed"]);
    assert.deepEqual(changed.runtime, ["project", "configured", null]);
  });
  // Through the route: an integration file that became invalid after start.
  await withConfiguration(async (path, loaded) => {
    await writeFile(path, "{");
    const app = await server(localProjectConfiguration({ loaded, identities: credentials, current: () => loadIntegrations(path), facts: () => facts }));
    try {
      const items = (await app.inject({ url: `/api/projects/${projectA}/capabilities`, headers: auth("a") })).json().items as ProjectCapability[];
      assert.deepEqual(items.find(item => item.key === "gitSources"), { key: "gitSources", scope: "project", state: "unknown", reason: "configuration_unreadable" });
    } finally { await app.close(); }
  });
});

test("members list this project's actors with merged permissions and never a token", async () => {
  await withConfiguration(async (path, loaded) => {
    const app = await server(localProjectConfiguration({ loaded, identities: credentials, current: () => loadIntegrations(path), facts: () => facts }));
    try {
      const a = await app.inject({ url: `/api/projects/${projectA}/members`, headers: auth("b") });
      assert.deepEqual(a.json(), { projectId: projectA, status: "available", source: "local_identities", items: [
        { actorId: "owner", identityKind: "human", permissions: ["read", "write", "review"] },
        { actorId: "reader", identityKind: "agent", permissions: ["read"] },
        { actorId: "rotating", identityKind: "agent", permissions: ["read", "write"] },
        { actorId: "writer-only", identityKind: "agent", permissions: ["write"] },
      ] });
      const b = await app.inject({ url: `/api/projects/${projectB}/members`, headers: auth("e") });
      assert.deepEqual(b.json().items.map((item: { actorId: string }) => item.actorId), ["outsider", "owner", "rotating"]);
      assert.deepEqual(b.json().items.find((item: { actorId: string }) => item.actorId === "rotating").permissions, ["read", "write", "review"],
        "the narrower credential is for project A only");
      for (const body of [a.body, b.body]) {
        for (const entry of credentials) {
          assert.equal(body.includes(entry.token), false);
          assert.equal(body.includes(entry.token.slice(0, 8)), false, "no token prefix");
        }
        assert.equal(/token|projectIds/i.test(body), false);
      }
      assert.equal(a.body.includes("outsider"), false, "another project's member is not listed");
      assert.equal(a.body.includes("ghost"), false);
    } finally { await app.close(); }
  });
});

test("member permissions follow the current study reviewer rule and never combine partial grants", () => {
  const base = { projectIds: [projectA], identityKind: "human" as const };
  const cases: Array<{ name: string; entries: Array<Array<"read" | "write" | "review">>; permissions: string[] }> = [
    { name: "one complete credential", entries: [["read", "write", "review"]], permissions: ["read", "write", "review"] },
    { name: "equivalent rotation", entries: [["read", "write", "review"], ["review", "read", "write"]], permissions: ["read", "write", "review"] },
    { name: "rotation with a narrower token", entries: [["read", "write", "review"], ["read"]], permissions: ["read"] },
    { name: "partial grants that would add up to full", entries: [["read", "write"], ["review"]], permissions: [] },
    { name: "overlapping partial grants", entries: [["read", "write"], ["read", "review"]], permissions: ["read"] },
  ];
  for (const item of cases) {
    const config = authConfigSchema.parse(item.entries.map((permissions, index) =>
      ({ ...base, token: `${index}`.repeat(40), actorId: "acceptor", permissions })));
    const members = projectMembers(config, projectA);
    assert.deepEqual(members, [{ actorId: "acceptor", identityKind: "human", permissions: item.permissions }], item.name);
    assert.equal(hasCurrentStudyReviewer(config, projectA, "acceptor"),
      ["read", "write", "review"].every(permission => members[0]!.permissions.includes(permission as "read")), item.name);
  }
  assert.deepEqual(projectMembers(credentials, randomUUID()), [], "no configured actor is an empty member list, not a guess");
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
