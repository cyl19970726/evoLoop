import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WorkflowService } from '@evoloop/core';
import { AllocationRelationsService } from '@evoloop/core/allocation-relations';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import type { WorkerGuardFacts } from '../src/workers/guard.ts';
import { buildServer } from '../src/server.ts';

test('installed worker guard cannot be bypassed by allocation or Discussion kind filters', async () => {
  const projectId = randomUUID(), roleId = randomUUID(), loopId = randomUUID();
  const token = 'reader-token'.repeat(4), workerToken = 'worker-token'.repeat(4);
  let reads = 0;
  const kinds: Array<string | undefined> = [];
  const empty = { items: [], nextCursor: null };
  const workflow = { listRoleRevisions: async () => [], listRoleReviews: async () => [], listRoleHandoffs: async () => [],
    listRoleSessionBindings: async () => [], listSchedules: async () => [], listScheduleRevisions: async () => [],
    listScheduleOccurrences: async () => [], listDiscussions: async (_who: unknown, _project: string, _limit: number,
      _cursor: string | undefined, kind?: string) => { kinds.push(kind); return empty; } } as unknown as WorkflowService;
  const uow = { read: async (_project: string, action: (r: unknown) => Promise<unknown>) => {
    reads++; return action({ getProject: async () => ({ id: projectId }), allocationRelations: () => ({ list: async () => ({
      ...empty, resetRequired: false, canonicalSessionKey: null,
      metadata: { generatedAt: new Date().toISOString(), sourceObservedAt: null, partial: false, limitations: [] } }) }) });
  } } as UnitOfWork;
  const worker = { principal: { actorId: 'worker-scoped-reader', projectIds: [projectId], permissions: ['read', 'write'] as Array<'read' | 'write'> },
    scope: { projectId, loopId, taskId: randomUUID(), runId: randomUUID(), sessionId: randomUUID(), roleId,
      kind: 'business' as const, allowedRoleIds: [roleId] } };
  const app = await buildServer({ service: workflow, credentials: [{ token, actorId: 'reader', projectIds: [projectId], permissions: ['read'] }],
    allocationRelations: new AllocationRelationsService({ uow }), workers: {
      authenticate: async header => header === `Bearer ${workerToken}` ? worker : null,
      facts: () => ({ loop: async () => ({ projectId, state: 'active', goalId: randomUUID(), stageId: null,
        cognitiveRoleId: 'cognition', allowedBusinessRoleIds: [roleId] }) }) as WorkerGuardFacts,
    } });
  const prefix = `/api/projects/${projectId}`;
  try {
    for (const suffix of [`/allocation-relations?roleId=${roleId}`, '/discussions?kind=allocation']) {
      const denied = await app.inject({ url: prefix + suffix, headers: { authorization: `Bearer ${workerToken}` } });
      assert.equal(denied.statusCode, 403, denied.body);
    }
    assert.equal(reads, 0); assert.deepEqual(kinds, []);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ url: `${prefix}/allocation-relations?roleId=${roleId}`, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: `${prefix}/discussions?kind=allocation`, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: `${prefix}/discussions`, headers })).statusCode, 200);
    assert.deepEqual(kinds, ['allocation', undefined]);
    assert.equal((await app.inject({ url: `${prefix}/discussions?kind=arbitrary`, headers })).statusCode, 400);
    assert.deepEqual(kinds, ['allocation', undefined], 'invalid kind must not touch the reader');
  } finally { await app.close(); }
});
