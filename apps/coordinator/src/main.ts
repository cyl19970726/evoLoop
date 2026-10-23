import { withObservedSources } from "./knowledge/observed-repository.js";
import { readExternalMaterials } from "./references/materials.js";
import { GitDocumentSource } from "@evoloop/adapter-git-documents";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { authConfigSchema } from "./auth.js";
import { buildServer } from "./server.js";
import { acquireCoordinatorLease } from "./lease.js";
import { RuntimeWorkflowService } from "@evoloop/core/runtime";
import { CodexAppServerAdapter } from "@evoloop/adapter-codex-app-server";
import { FeishuBitableConnector } from "@evoloop/connector-feishu";
import { PgOutboxDeliveryStore } from "@evoloop/adapter-postgres/delivery";
import { CollaborationRunner } from "./collaboration/runner.js";
import { PgSchedulingStore } from "@evoloop/adapter-postgres/scheduling";
import { SchedulingPump } from "./scheduling/pump.js";
import { readDocumentOriginal } from "./documents/read-original.js";
import { RuntimeRunner } from "./runtime/runner.js";
import { readEvaluationMaterial } from "./runtime/evaluation-sources.js";
import { evaluationPacketMediaType } from "./runtime/evaluation-materials.js";
import { loadIntegrations, runtimeThreadConfig } from "./configuration.js";
import { OpenVikingKnowledgeRepository } from "@evoloop/adapter-wiki-openviking";
import { DomainError } from "@evoloop/contracts/ports";
import type { Principal } from "@evoloop/contracts";
import { LocalBlobStore } from "@evoloop/adapter-local-blobs";
import { setupManagedLoops } from "./orchestration/setup.js";
import { managedRuntimeAdmission } from "./orchestration/admission.js";
import { workerGuardFacts } from "./workers/facts.js";

const databaseUrl = process.env.EVOLOOP_DATABASE_URL;
const authFile = process.env.EVOLOOP_AUTH_FILE;
if (!databaseUrl || !authFile) throw new Error("Set EVOLOOP_DATABASE_URL and EVOLOOP_AUTH_FILE. Run migrations separately before starting.");
let credentials: ReturnType<typeof authConfigSchema.parse>;
try { credentials = authConfigSchema.parse(JSON.parse(await readFile(authFile, "utf8"))); }
catch { throw new Error("Invalid identity file: check its JSON and credential schema; values are not logged."); }
const port = Number(process.env.EVOLOOP_PORT ?? "4318");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid EVOLOOP_PORT.");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, query_timeout: 15000 });
pool.on("error", () => { /* Requests receive explicit unavailable responses; credentials are never logged. */ });
const lease = await acquireCoordinatorLease(pool);
const integrations = await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
const uow = new PostgresUnitOfWork(pool);
const clock = { now: () => new Date().toISOString() };
const ids = { next: randomUUID };
const service = new WorkflowService({
  uow, clock, ids,
  hasher: { hash: value => createHash("sha256").update(value, "utf8").digest("hex") },
});
const trustedRuntime = new RuntimeWorkflowService({ uow, clock, ids });
const configuredBlobRoot = process.env.EVOLOOP_BLOB_ROOT;
if (configuredBlobRoot && !isAbsolute(configuredBlobRoot)) throw new Error("EVOLOOP_BLOB_ROOT must be an absolute external data directory.");
const blobRoot = resolve(configuredBlobRoot ?? `${homedir()}/.local/share/evoloop-pilot/blobs`);
if (blobRoot === process.cwd() || blobRoot.startsWith(process.cwd() + sep)) throw new Error("Document originals must stay outside the development checkout.");
const blobsForPrincipal = (principal: Principal) => new LocalBlobStore(blobRoot,
  async payload => principal.projectIds.includes(payload.projectId) && principal.permissions.includes("read"),
  async payload => {
    try {
      const record = await service.getRegisteredBlob(principal, payload.projectId, payload.id);
      if (record.projectId === payload.projectId && record.contentHash === payload.contentHash &&
          record.size === payload.size && record.mediaType === payload.mediaType) return true;
    } catch { /* Evaluation packets are registered on their immutable Run binding. */ }
    if (payload.mediaType !== evaluationPacketMediaType) return false;
    const runs = await service.listRuntimeRuns(principal, payload.projectId);
    return runs.some(run => run.projectId === payload.projectId && run.evaluationPacket?.payloadRef === payload.id &&
      run.evaluationPacket.contentHash === payload.contentHash);
  });
const gitForPrincipal = (principal:Principal) => new GitDocumentSource(integrations.repositories, async ref => principal.projectIds.includes(ref.projectId) && principal.permissions.includes("read"));
const knowledge = integrations.knowledge;
const repositoryForPrincipal = (principal: Principal, projectId: string) => {
  if (!knowledge?.enabled || !knowledge.projectIds.includes(projectId)) throw new DomainError("KNOWLEDGE_NOT_CONFIGURED", "当前项目尚未配置外置知识后端。");
  const allowed = (permission: "read" | "write" | "review") => principal.projectIds.includes(projectId) && principal.permissions.includes(permission);
  const raw = new OpenVikingKnowledgeRepository({ baseUrl: knowledge.baseUrl, manifestRoot: knowledge.manifestRoot,
    maintainerId: knowledge.maintainerId,
    mayRead: async p => p === projectId && allowed("read"),
    mayPropose: async candidate => candidate.projectId === projectId && candidate.actorId === principal.actorId && allowed("write"),
    mayReview: async (p, actor) => p === projectId && actor === principal.actorId && allowed("review"),
    mayPublish: async (p, actor) => lease.canWrite() && p === projectId && actor === principal.actorId && allowed("review"),
    mayReconcile: async (p, actor) => lease.canWrite() && p === projectId && actor === principal.actorId && allowed("review"),
  });
  return withObservedSources(raw, async (p, source) => {
    if (p !== projectId || !source.sourceKey.startsWith("document:") || source.state !== "reachable") return false;
    try {
      const documentId = source.sourceKey.slice(9);
      const detail = await service.getDocument(principal, projectId, documentId);
      if (detail.document.adoptedRevisionId !== source.originRevision) return false;
      const fixed = await service.getDocumentPayloadRevision(principal, projectId, documentId, source.originRevision);
      if (fixed.contentHash !== source.contentHash) return false;
      return (await readDocumentOriginal({uow,blobsForPrincipal},principal,fixed)).status === "available";
    } catch { return false; }
  });
};
const runtimeConfig = integrations.runtime;
const runSessionAvailable = async (projectId: string, run: import("@evoloop/contracts").RuntimeRunRecord,
  session: import("@evoloop/contracts").RuntimeSessionRecord) =>
  !!runtimeConfig?.enabled && run.projectId === projectId && session.projectId === projectId && session.state === "ready" &&
  integrations.hasRuntimeGrant({projectId, actorId: run.actorId, roleId: session.roleId,
    authorizationScope: session.authorizationScope, cwd: session.cwd, sandbox: session.sandbox}) &&
  await integrations.allowedRuntimeCwd(projectId, session.cwd);
const mayStartManaged = integrations.orchestration?.enabled ? managedRuntimeAdmission(pool) : async () => true;
const runtimeFactory = runtimeConfig?.enabled ? () => new CodexAppServerAdapter({
  ...(runtimeConfig.executable ? { executable: runtimeConfig.executable } : {}),
  verifyBinding: async binding => {
    try { await trustedRuntime.verifyBinding(binding.projectId, binding); return true; } catch { return false; }
  },
  threadConfig: spec => runtimeThreadConfig(runtimeConfig.grants, spec),
}) : null;
const runner = runtimeFactory ? new RuntimeRunner({ runtimeFactory, workflow: service, trusted: trustedRuntime,
  workerTraceAuthority: (identity, targetRunId) => workerGuardFacts(pool, identity).fixedRunTrace!(targetRunId),
  readExternalMaterials: (principal, projectId, taskId, revisionId) => readExternalMaterials(principal, projectId, taskId, revisionId, {uow,gitForPrincipal,knowledgeForPrincipal: repositoryForPrincipal,runSessionAvailable}),
  readDocumentOriginal: (principal, revision) => readDocumentOriginal({ uow, blobsForPrincipal }, principal, revision),
  readEvaluationMaterial: (principal, projectId, source) => readEvaluationMaterial(principal, projectId, source, {
    workflow: service, gitForPrincipal, knowledgeForPrincipal: repositoryForPrincipal,
    readDocumentOriginal: (reader, revision) => readDocumentOriginal({ uow, blobsForPrincipal }, reader, revision),
  }),
  blobsForPrincipal,
  principals: credentials, canWrite: lease.canWrite, allowedCwd: integrations.allowedRuntimeCwd,
  mayCreateSession: session => mayStartManaged(session.projectId, "session", session.id),
  mayDispatchRun: run => mayStartManaged(run.projectId, "run", run.id),
  hasGrant: integrations.hasRuntimeGrant }) : null;
if (runner) {
  try { await runner.start(); }
  catch { console.error("Codex runtime is unavailable; check the configured CLI version, protocol and project directories. No new dispatch was enabled."); }
}
const scheduling = new SchedulingPump({ store: new PgSchedulingStore(pool), canWrite: lease.canWrite,
  credentials: () => credentials, grants: () => integrations.scheduling?.grants ?? [],
  enabled: () => integrations.scheduling?.enabled ?? false,
  onError: () => console.error("Scheduling tick failed; inspect the saved schedule status before retrying."),
});
try { await scheduling.start(); } catch { console.error("Scheduling startup check failed; schedules were not assumed successful."); }
const deliveryStore = new PgOutboxDeliveryStore(pool);
const feishu = integrations.feishu;
const hasFeishuGrant = (projectId: string, actorId: string) => !!feishu?.enabled && feishu.grants.some(g => g.projectId === projectId && g.actorId === actorId && g.scope === "project");
const collaboration = new CollaborationRunner({ store: deliveryStore, workflow: service,
  connector: feishu?.enabled ? new FeishuBitableConnector(feishu) : null, consumerId: "feishu",
  principals: credentials, canWrite: lease.canWrite, hasGrant: hasFeishuGrant,
  allowProjection: async (projectId, principal, task) => hasFeishuGrant(projectId, principal.actorId) && principal.permissions.includes("read") && principal.permissions.includes("write") &&
    task.task.projectId === projectId,
  ...(feishu?.enabled && feishu.pollEnabled ? { pollIntervalMs: feishu.pollIntervalMs } : {}),
});
await collaboration.start();
const managed = setupManagedLoops({pool, workflow: service, runtime: runner, integrations, credentials,
  canWrite: lease.canWrite, now: clock.now, apiUrl: `http://127.0.0.1:${port}`,
  projectRoot: fileURLToPath(new URL("../../../", import.meta.url)),
  cliMain: fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url))});
const app = await buildServer({ service, credentials, canWrite: lease.canWrite,
  sourceConfiguration: principal => ({
    git: integrations.repositories.some(repository => !principal || principal.projectIds.includes(repository.projectId)),
    wiki: !!knowledge?.enabled && knowledge.projectIds.some(projectId => !principal || principal.projectIds.includes(projectId)),
  }),
  ...(managed ? {orchestration: managed.routes, workers: managed.workers} : {}),
  ...(runner ? { runtime: runner, readEvaluationPacket: (principal, projectId, runId) =>
    runner.readEvaluationPacket(principal, projectId, runId) } : {}), allowedRuntimeCwd: integrations.allowedRuntimeCwd,
  allowedRuntimeCwds: integrations.allowedRuntimeCwds, hasRuntimeGrant: integrations.hasRuntimeGrant,
  runtimeGrants: (projectId, actorId) => runtimeConfig?.enabled ? runtimeConfig.grants.filter(g => g.projectId === projectId && g.actorId === actorId) : [],
  references: {uow, gitForPrincipal, knowledgeForPrincipal: (principal, projectId) => repositoryForPrincipal(principal, projectId), runSessionAvailable},
  scheduling,
  schedulingGrants: (projectId, actorId) => integrations.scheduling?.enabled
    ? integrations.scheduling.grants.filter(g => g.projectId === projectId && g.actorId === actorId)
    : [],
  collaboration: { runner: collaboration, store: deliveryStore, consumerId: "feishu", hasGrant: hasFeishuGrant },
  documents: { uow, blobsForPrincipal },
  knowledge: { repositoryForPrincipal, blobsForPrincipal },
  webRoot: fileURLToPath(new URL("../../workbench/dist/", import.meta.url)) });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  try { await managed?.stop(); await collaboration.stop(); await scheduling.stop(); await app.close(); }
  finally {
    try { if (runner) await runner.stop(); }
    finally { try { await lease.release(); } finally { await pool.end(); } }
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try { await app.listen({ host: "127.0.0.1", port }); managed?.start(); console.log(`evoLoop local workbench: http://127.0.0.1:${port}`); }
catch (error) { await shutdown(); throw error; }
