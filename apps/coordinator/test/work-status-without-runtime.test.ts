import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { WorkflowService } from '@evoloop/core';
import type { OrchestrationService } from '@evoloop/core/orchestration';
import { DomainError } from '@evoloop/contracts/ports';
import { buildServer } from '../src/server.ts';
import { readWorkStatuses } from '../src/orchestration/work-status.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), taskId = id(2), token = 'r'.repeat(40), workerToken = 'w'.repeat(40);
const path = `/api/projects/${projectId}/orchestration/work-status?taskIds=${taskId}`;
const auth = { authorization: `Bearer ${token}` };
const workManagementQueries = { listRoleRevisions: async () => [], listRoleReviews: async () => [],
  listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [], listSchedules: async () => [],
  listScheduleRevisions: async () => [], listScheduleOccurrences: async () => [] };

test('ordinary Task work status reads without managed Loop, runtime or runner', async () => {
  let projectReads = 0, databaseReads = 0, broken = false;
  const workflow = { ...workManagementQueries,
    getProject: async (principal: { projectIds: string[]; permissions: string[] }, project: string) => {
      projectReads++;
      if (!principal.projectIds.includes(project) || !principal.permissions.includes('read'))
        throw new DomainError('FORBIDDEN', 'Project read required');
      return { id: project };
    } } as unknown as WorkflowService;
  const pool = { query: async (sql: string, params: unknown[]) => {
    databaseReads++;
    if (broken) throw new Error('private database connection string');
    assert.match(sql, /FROM task t/);
    assert.match(sql, /LEFT JOIN LATERAL \(SELECT x\.\* FROM orchestration_dispatch/);
    assert.deepEqual(params, [projectId, [taskId]]);
    return { rows: [{ task_id: taskId, purpose: null, dispatch_id: null, dispatch_state: null,
      run_id: null, run_state: null, unsettled_run_state: null, loop_state: null,
      goal_outcome: null, stage_deliverable: null, source_kind: null, source_task_id: null,
      source_task_title: null, decision_kind: null, decision_reason: null, use_required: null,
      delivery_id: null, technical_result: null, observation_result: null, observer_kind: null,
      has_closure: false, ready_for_acceptance: false }] };
  } } as unknown as Pool;
  const options = { credentials: [{ token, actorId: 'reader', projectIds: [projectId], permissions: ['read'] }],
    service: workflow,
    workStatuses: (principal: Parameters<typeof readWorkStatuses>[2], project: string, taskIds: string[]) =>
      readWorkStatuses(pool, workflow, principal, project, taskIds),
    workers: { authenticate: async (header: string | undefined) => header === `Bearer ${workerToken}` ?
      { principal: { actorId: 'worker-fixture', projectIds: [projectId], permissions: ['read'] },
        scope: { projectId, loopId: id(3), taskId, runId: id(4), sessionId: id(5), roleId: id(6),
          kind: 'business', allowedRoleIds: [] } } : null,
      facts: () => ({ loop: async () => ({ projectId, state: 'active', goalId: id(7), stageId: null,
        cognitiveRoleId: id(8), allowedBusinessRoleIds: [id(6)] }) }) },
  } as unknown as Parameters<typeof buildServer>[0];
  const app = await buildServer(options);
  try {
    assert.equal((await app.inject({ url: path })).statusCode, 401);
    const read = await app.inject({ url: path, headers: auth });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.deepEqual(read.json().items.map((item: { taskId: string; cognition: boolean; dispatchId: string | null }) =>
      ({ taskId: item.taskId, cognition: item.cognition, dispatchId: item.dispatchId })),
      [{ taskId, cognition: false, dispatchId: null }]);
    assert.equal(databaseReads, 1);
    assert.equal((await app.inject({ url: path, headers: { authorization: `Bearer ${workerToken}` } })).statusCode, 403);
    assert.equal((await app.inject({ url: `/api/projects/${id(9)}/orchestration/work-status?taskIds=${taskId}`, headers: auth })).statusCode, 403);
    for (const suffix of [`taskIds=${taskId},${taskId}`, 'taskIds=not-a-uuid',
      `taskIds=${Array.from({ length: 51 }, (_, i) => id(i + 10)).join(',')}`])
      assert.equal((await app.inject({ url: `/api/projects/${projectId}/orchestration/work-status?${suffix}`, headers: auth })).statusCode, 400);
    assert.equal(databaseReads, 1);
    assert.equal(projectReads, 2); // Foreign request and successful read; invalid/worker requests never enter the reader.
    assert.equal((await app.inject({ url: `/api/projects/${projectId}/orchestration/loops`, headers: auth })).statusCode, 404);
    broken = true;
    const failed = await app.inject({ url: path, headers: auth });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().code, 'RESULT_UNCONFIRMED');
    assert.equal(failed.body.includes('private database connection string'), false);
  } finally { await app.close(); }
});

test('managed route options retain the original work-status read with one registered path', async () => {
  let reads = 0;
  const app = await buildServer({
    credentials: [{ token, actorId: 'reader', projectIds: [projectId], permissions: ['read'] }],
    service: workManagementQueries as unknown as WorkflowService,
    orchestration: { service: { listLoops: async () => ({ items: [], nextCursor: null }) } as unknown as OrchestrationService,
      workStatuses: async (_principal, project, taskIds) => {
        reads++; assert.equal(project, projectId); assert.deepEqual(taskIds, [taskId]);
        return { items: [{ taskId, cognition: false }] };
      } },
  });
  try {
    const result = await app.inject({ url: path, headers: auth });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { items: [{ taskId, cognition: false }] });
    assert.equal(reads, 1);
    assert.equal((await app.inject({ url: `/api/projects/${projectId}/orchestration/loops`, headers: auth })).statusCode, 200);
  } finally { await app.close(); }
});
