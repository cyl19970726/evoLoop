import type { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Principal } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";
import { OrchestrationService } from "@evoloop/core/orchestration";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import type { AuthConfig } from "../auth.js";
import type { loadIntegrations } from "../configuration.js";
import type { RuntimeRunner } from "../runtime/runner.js";
import { WorkerCredentialBroker } from "../workers/credentials.js";
import { workerGuardFacts } from "../workers/facts.js";
import { ManagedLoopRunner } from "./runner.js";
import { createWorkerSealer } from "./seal.js";
import { readWorkStatuses } from "./work-status.js";
import { readPlanningSources } from "./planning-sources.js";

/** Follow formal Task feedback one dispatch at a time without expanding an entire Loop. */
export async function readTaskContext(pool: Pool, workflow: Pick<WorkflowService, "getTask">,
  principal: Principal, projectId: string, taskId: string, limit: number, cursor?: string) {
  await workflow.getTask(principal, projectId, taskId);
  const result = await pool.query(`WITH RECURSIVE direct AS (
      SELECT loop_id,dispatch_id,data->>'sourceEventId' AS source_id,data->>'parentDispatchId' AS parent_id
      FROM orchestration_dispatch WHERE project_id=$1 AND task_id=$2
    ), observed AS (
      SELECT e.event_id FROM outbox_event e
      JOIN operation_journal j ON j.project_id=e.project_id AND j.operation_id=e.operation_id
        AND j.command_type='observation.record' AND j.result->>'status'='applied'
      JOIN consumer_observation o ON o.project_id=e.project_id AND o.task_id=e.entity_id
        AND o.observation_id::text=j.result->>'revisionId' AND o.actor_id=j.actor_id
      JOIN delivery delivery ON delivery.project_id=o.project_id AND delivery.delivery_id=o.delivery_id
        AND delivery.task_id=o.task_id
      WHERE e.project_id=$1 AND e.entity_id=$2 AND e.kind='observation.record'
    ), roots_raw AS (
      SELECT d.loop_id,d.dispatch_id,d.source_id,d.parent_id FROM direct d
      UNION SELECT x.loop_id,x.dispatch_id,x.data->>'sourceEventId',x.data->>'parentDispatchId'
        FROM observed o JOIN orchestration_dispatch x ON x.project_id=$1
          AND x.data->>'sourceEventId'=o.event_id::text
    ), loop_page AS (
      SELECT DISTINCT loop_id FROM roots_raw WHERE ($3::uuid IS NULL OR loop_id>$3)
      ORDER BY loop_id LIMIT $4
    ), roots AS (
      SELECT r.* FROM roots_raw r JOIN loop_page p ON p.loop_id=r.loop_id
    ), chain AS (
      SELECT r.loop_id,r.dispatch_id FROM roots r
      UNION
      SELECT x.loop_id,x.dispatch_id FROM chain c
      JOIN orchestration_dispatch x ON x.project_id=$1 AND x.loop_id=c.loop_id
        AND (x.data->>'parentDispatchId'=c.dispatch_id::text OR EXISTS (
          SELECT 1 FROM orchestration_event e WHERE e.project_id=$1 AND e.loop_id=c.loop_id
            AND e.entity_id=c.dispatch_id AND e.event_id::text=x.data->>'sourceEventId'
            AND (e.kind='dispatch.gap' OR (e.kind='worker.outcome'
              AND e.detail->>'outcome' IN ('delivered','failed','waiting','no_action')))))
    ), upstream AS (
      SELECT p.loop_id,p.dispatch_id,p.data->>'sourceEventId' AS source_id,
        NULL::text AS parent_id
      FROM roots r JOIN orchestration_dispatch p ON p.project_id=$1 AND p.loop_id=r.loop_id
        AND p.dispatch_id::text=r.parent_id
    ), visible AS (
      SELECT c.loop_id,c.dispatch_id,d.data->>'sourceEventId' AS source_id,
        d.data->>'parentDispatchId' AS parent_id
      FROM chain c JOIN orchestration_dispatch d ON d.project_id=$1 AND d.loop_id=c.loop_id
        AND d.dispatch_id=c.dispatch_id
      UNION SELECT loop_id,dispatch_id,source_id,parent_id FROM upstream
    ), sources AS (
      SELECT c.loop_id,d.data->>'sourceEventId' AS source_id
      FROM chain c JOIN orchestration_dispatch d ON d.project_id=$1 AND d.loop_id=c.loop_id
        AND d.dispatch_id=c.dispatch_id
      UNION SELECT e.loop_id,e.event_id::text FROM chain c
        JOIN orchestration_event e ON e.project_id=$1 AND e.loop_id=c.loop_id
          AND e.entity_id=c.dispatch_id AND (e.kind='dispatch.gap' OR
            (e.kind='worker.outcome' AND e.detail->>'outcome' IN ('delivered','failed','waiting','no_action')))
    )
    SELECT page.loop_id,array_remove(array_agg(DISTINCT sources.source_id),NULL) AS sources,
      array_remove(array_agg(DISTINCT visible.dispatch_id::text),NULL) AS dispatches,
      array_remove(array_agg(DISTINCT visible.parent_id),NULL) AS parents
    FROM loop_page page LEFT JOIN sources ON sources.loop_id=page.loop_id
      LEFT JOIN visible ON visible.loop_id=page.loop_id
    GROUP BY page.loop_id ORDER BY page.loop_id`, [projectId, taskId, cursor ?? null, limit + 1]);
  const items = result.rows.slice(0, limit).map(row => ({loopId: row.loop_id as string,
    sourceEventIds: row.sources as string[], dispatchIds: row.dispatches as string[],
    parentDispatchIds: row.parents as string[]}));
  return {items,nextCursor:result.rows.length>limit ? items.at(-1)!.loopId : null};
}

export function setupManagedLoops(options: {
  pool: Pool; workflow: WorkflowService; runtime: RuntimeRunner | null;
  integrations: Awaited<ReturnType<typeof loadIntegrations>>; credentials: AuthConfig;
  canWrite(): boolean; now(): string; apiUrl: string; projectRoot: string; cliMain: string;
}) {
  const config = options.integrations.orchestration;
  if (!config?.enabled) return null;
  if (!options.runtime || !options.integrations.runtime?.enabled) throw new Error("Managed loops require configured runtime");
  const root = resolve(config.workerRoot), checkout = resolve(options.projectRoot);
  if (!isAbsolute(config.workerRoot) || root === checkout || root.startsWith(checkout + sep))
    throw new Error("Worker credentials require an external private directory");
  const entry = options.credentials.find(value => value.actorId === config.controllerActorId);
  if (!entry || !["read", "write", "review"].every(permission => entry.permissions.includes(permission as "read" | "write" | "review")))
    throw new Error("Managed loop controller requires one configured reviewer identity");
  const controllerPrincipal: Principal = {actorId: entry.actorId, projectIds: [...entry.projectIds], permissions: [...entry.permissions]};
  const grants = options.integrations.runtime.grants.filter(value => value.actorId === entry.actorId && entry.projectIds.includes(value.projectId));
  const broker = new WorkerCredentialBroker({workerRoot: root, apiUrl: options.apiUrl,
    cliMain: options.cliMain, nodeExecutable: process.execPath, ttlMs: config.credentialTtlMs,
    receiptDirectory: scope => {
      const matches = grants.filter(value => value.projectId === scope.projectId && value.roleId === scope.roleId);
      if (matches.length !== 1) throw new Error("Worker receipt workspace is ambiguous");
      return join(matches[0]!.cwd, ".local/worker-receipts", scope.runId);
    }});
  const controller = async (projectId: string, roleId: string) => {
    const matches = grants.filter(value => value.projectId === projectId && value.roleId === roleId);
    if (matches.length !== 1) return null;
    const grant = matches[0]!;
    if (!await options.integrations.allowedRuntimeCwd(projectId, grant.cwd)) return null;
    return {principal: controllerPrincipal, authorizationScopeId: grant.authorizationScope, cwd: grant.cwd,
      ...(grant.model ? {model: grant.model} : {}), sandbox: grant.sandbox, approvalPolicy: grant.approvalPolicy,
      skillPath: join(checkout, ".agents/skills/evoloop-workflow/SKILL.md")};
  };
  const store = new PgOrchestrationStore(options.pool, {
    wasActorRole: (projectId, actorId, loopId, roleId) => broker.wasActorRole(projectId, actorId, loopId, roleId),
    getAuthorizationFact: async (projectId, scopeId) => {
      const matches = grants.filter(value => value.projectId === projectId && value.authorizationScope === scopeId);
      const grant = matches.length === 1 ? matches[0]! : null;
      return grant ? {projectId, scopeId, actorId: grant.actorId, roleId: grant.roleId,
        active: await options.integrations.allowedRuntimeCwd(projectId, grant.cwd)} : null;
    },
    canActAsRole: async (projectId, actorId, roleId) => {
      if (grants.some(value => value.projectId === projectId && value.actorId === actorId && value.roleId === roleId)) return true;
      const identity = await broker.identityForActor(actorId);
      return identity?.scope.projectId === projectId && identity.scope.roleId === roleId;
    },
  });
  const orchestration = new OrchestrationService({store, now: options.now, nextId: randomUUID,
    hash: value => createHash("sha256").update(value).digest("hex")});
  const seal = createWorkerSealer({workflow: options.workflow, orchestration, credential: broker,
    controller: async (projectId, roleId) => (await controller(projectId, roleId))?.principal ?? null, now: options.now});
  const runner = new ManagedLoopRunner({projects: entry.projectIds, reader: projectId => entry.projectIds.includes(projectId) ? controllerPrincipal : null,
    controller, workflow: options.workflow, orchestration, runtime: options.runtime,
    credential: {lookup: runId => broker.lookup(runId), issue: async scope => {
      const loop = await orchestration.getLoop(controllerPrincipal, scope.projectId, scope.loopId);
      if (loop?.state !== "active") throw new Error("Loop no longer active; no new credential issued");
      return broker.issue(scope);
    }}, sealSubmission: seal, now: options.now, canWrite: options.canWrite});
  return {runner, broker, service: orchestration,
    start: () => runner.start(config.pollIntervalMs), stop: () => runner.stop(),
    workers: {authenticate: (header: string | undefined) => broker.authenticate(header),
      facts: (identity: Parameters<typeof workerGuardFacts>[1]) => workerGuardFacts(options.pool, identity)},
    routes: {service: orchestration, status: () => runner.status(),
      planningSources: (principal: Principal, projectId: string, taskId: string, revisionId: string, loopId?: string) =>
        readPlanningSources(options.pool, principal, projectId, taskId, revisionId, loopId),
      taskContext: (principal: Principal, projectId: string, taskId: string, limit: number, cursor?: string) =>
        readTaskContext(options.pool, options.workflow, principal, projectId, taskId, limit, cursor),
      workStatuses: (principal: Principal, projectId: string, taskIds: string[]) =>
        readWorkStatuses(options.pool, options.workflow, principal, projectId, taskIds),
      listTasks: async (principal: Principal, projectId: string, loopId: string, limit: number, cursor?: string) => {
        const loop = await orchestration.getLoop(principal, projectId, loopId);
        if (!loop) return {items: [], nextCursor: null};
        const result = await options.pool.query(`SELECT t.task_id FROM task t JOIN LATERAL
          (SELECT proposal.stage_id FROM task_proposal proposal JOIN task_revision r
            ON r.project_id=proposal.project_id AND r.task_id=proposal.task_id AND r.revision_id=proposal.task_revision_id
            WHERE proposal.project_id=t.project_id AND proposal.task_id=t.task_id ORDER BY r.version DESC LIMIT 1) p ON true
          JOIN project_stage s ON s.project_id=t.project_id AND s.stage_id=p.stage_id
          WHERE t.project_id=$1 AND s.goal_id=$2 AND ($3::uuid IS NULL OR s.stage_id=$3)
          AND ($4::uuid IS NULL OR t.task_id>$4) ORDER BY t.task_id LIMIT $5`,
          [projectId, loop.goalId, loop.stageId, cursor ?? null, limit + 1]);
        const ids = result.rows.slice(0, limit).map(value => value.task_id as string);
        return {items: await Promise.all(ids.map(id => options.workflow.getTask(principal, projectId, id))),
          nextCursor: result.rows.length > limit ? ids.at(-1)! : null};
      }},
  };
}
