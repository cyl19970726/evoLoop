import assert from 'node:assert/strict';
import test from 'node:test';
import type { Principal } from '@evoloop/contracts';
import type { AllocationTracePage } from '@evoloop/contracts/allocation-relations';
import { DomainError, type UnitOfWork } from '@evoloop/contracts/ports';
import { z } from 'zod';
import { AllocationRelationsService } from '../src/allocation-relations/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), roleId = id(2);
const principal: Principal = { actorId: 'reader', projectIds: [projectId], permissions: ['write', 'read', 'write'] };
const empty: AllocationTracePage = { items: [], nextCursor: 'next-page', resetRequired: false,
  canonicalSessionKey: null, metadata: { generatedAt: new Date(0).toISOString(), sourceObservedAt: null,
    partial: false, limitations: ['Only registered paths appear.'] } };

test('one read transaction verifies project and passes a bounded exact query with stable actor scope', async () => {
  const calls: string[] = [];
  const uow = { read: async (project: string, action: (reader: unknown) => Promise<unknown>) => {
    assert.equal(project, projectId); calls.push('read');
    return action({ getProject: async () => { calls.push('project'); return { id: projectId }; },
      allocationRelations: (scope: string) => { calls.push('scope');
        assert.deepEqual(JSON.parse(scope), { actorId: 'reader', permissions: ['read', 'write'] });
        return { list: async (query: unknown) => { calls.push('list'); assert.deepEqual(query, { roleId, limit: 20 }); return empty; } }; } });
  }, transaction: async () => { throw new Error('read path must not write'); } } as unknown as UnitOfWork;
  const result = await new AllocationRelationsService({ uow }).list(principal, projectId, { roleId });
  assert.equal(result.nextCursor, 'next-page'); assert.equal(result.resetRequired, false);
  assert.deepEqual(calls, ['read', 'project', 'scope', 'list']);
});

test('missing, combined, malformed and oversized filters fail before storage access', async () => {
  let reads = 0;
  const uow = { read: async () => { reads++; throw new Error('should not read'); } } as unknown as UnitOfWork;
  const service = new AllocationRelationsService({ uow });
  for (const query of [{}, { roleId, discussionId: id(3) }, { roleId: 'bad' },
    { sessionKey: `desktop:${id(4)}` }, { sessionKey: `owned:${id(4)}`, limit: 51 },
    { discussionId: id(3), cursor: 'x'.repeat(4097) }, { roleId, extra: 'injected' }])
    await assert.rejects(() => service.list(principal, projectId, query), z.ZodError);
  assert.equal(reads, 0);
});

test('authorization and project existence precede capability access without leaking other projects', async () => {
  let reads = 0, factories = 0;
  const uow = { read: async (_project: string, action: (reader: unknown) => Promise<unknown>) => {
    reads++; return action({ getProject: async () => null,
      allocationRelations: () => { factories++; throw new Error('must not reveal capability'); } });
  } } as unknown as UnitOfWork;
  const service = new AllocationRelationsService({ uow });
  await assert.rejects(() => service.list({ ...principal, projectIds: [] }, projectId, { roleId }),
    (error: unknown) => error instanceof DomainError && error.code === 'FORBIDDEN');
  await assert.rejects(() => service.list({ ...principal, actorId: '' }, projectId, { roleId }),
    (error: unknown) => error instanceof DomainError && error.code === 'FORBIDDEN');
  assert.equal(reads, 0);
  await assert.rejects(() => service.list(principal, projectId, { roleId }),
    (error: unknown) => error instanceof DomainError && error.code === 'NOT_FOUND');
  assert.equal(factories, 0);
  const missing = { read: async (_project: string, action: (reader: unknown) => Promise<unknown>) =>
    action({ getProject: async () => ({ id: projectId }) }) } as unknown as UnitOfWork;
  await assert.rejects(() => new AllocationRelationsService({ uow: missing }).list(principal, projectId, { roleId }),
    (error: unknown) => error instanceof DomainError && error.code === 'CAPABILITY_UNAVAILABLE');
});
