import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import type { Principal } from '@evoloop/contracts';
import { DomainError, type UnitOfWork } from '@evoloop/contracts/ports';
import { AllocationRelationsService } from '@evoloop/core/allocation-relations';
import type { WorkflowService } from '@evoloop/core';
import { authConfigSchema } from '../src/auth.ts';
import { buildServer } from '../src/server.ts';
import { registerAllocationRelationRoutes } from '../src/allocation-relations/routes.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), roleId = id(2);
const page = { items: [], nextCursor: 'next', resetRequired: false, canonicalSessionKey: null,
  metadata: { generatedAt: new Date(0).toISOString(), sourceObservedAt: null, partial: false, limitations: [] } };

test('GET allocation relations uses the project principal and preserves pagination metadata', async () => {
  let unavailable = false, broken = false, oversized = false, reads = 0;
  const uow = { read: async (_project: string, action: (reader: unknown) => Promise<unknown>) => {
    reads++;
    if (broken) throw new Error('private database connection string');
    return action({ getProject: async () => ({ id: projectId }),
      allocationRelations: unavailable ? undefined : (_scope: string) => ({ list: async () => oversized ?
        { ...page, metadata: { ...page.metadata, limitations: ['x'.repeat(256 * 1024)] } } : page }) });
  } } as unknown as UnitOfWork;
  const app = Fastify();
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.headers.authorization) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    request.principal = { actorId: 'reader', projectIds: [projectId], permissions: ['read'] } as Principal;
  });
  app.addHook('preValidation', async (request, reply) => {
    if (request.headers.authorization === 'worker') return reply.code(403).send({ code: 'FORBIDDEN' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_INPUT' });
    if (error instanceof DomainError) return reply.code(error.code === 'FORBIDDEN' ? 403 : 409).send({ code: error.code });
    return reply.code(503).send({ code: 'RESULT_UNCONFIRMED' });
  });
  registerAllocationRelationRoutes(app, new AllocationRelationsService({ uow }));
  try {
    const path = `/api/projects/${projectId}/allocation-relations?roleId=${roleId}`;
    const denied = await app.inject({ url: path });
    assert.equal(denied.statusCode, 401); assert.equal(reads, 0);
    const worker = await app.inject({ url: path, headers: { authorization: 'worker' } });
    assert.equal(worker.statusCode, 403); assert.equal(reads, 0);
    const crossProject = await app.inject({ url: `/api/projects/${id(9)}/allocation-relations?roleId=${roleId}`,
      headers: { authorization: 'reader' } });
    assert.equal(crossProject.statusCode, 403); assert.equal(reads, 0);
    const malformed = await app.inject({ url: `${path}&discussionId=${id(3)}`, headers: { authorization: 'reader' } });
    assert.equal(malformed.statusCode, 400); assert.equal(reads, 0);
    const success = await app.inject({ url: path, headers: { authorization: 'reader' } });
    assert.equal(success.statusCode, 200);
    assert.equal(success.headers['cache-control'], 'no-store');
    assert.deepEqual(success.json(), page);
    oversized = true;
    const tooLarge = await app.inject({ url: path, headers: { authorization: 'reader' } });
    assert.equal(tooLarge.statusCode, 409); assert.equal(tooLarge.json().code, 'RESULT_TOO_LARGE');
    oversized = false;
    unavailable = true;
    const capability = await app.inject({ url: path, headers: { authorization: 'reader' } });
    assert.equal(capability.statusCode, 409); assert.equal(capability.json().code, 'CAPABILITY_UNAVAILABLE');
    unavailable = false; broken = true;
    const failure = await app.inject({ url: path, headers: { authorization: 'reader' } });
    assert.equal(failure.statusCode, 503); assert.equal(failure.json().code, 'RESULT_UNCONFIRMED');
    assert.equal(failure.body.includes('private database connection string'), false);
  } finally { await app.close(); }
});

test('installed server guard rejects anonymous and foreign project reads before relation storage', async () => {
  const token = 'r'.repeat(40), credentials = authConfigSchema.parse([
    { token, actorId: 'reader', projectIds: [projectId], permissions: ['read'] },
  ]);
  let reads = 0;
  const uow = { read: async (_project: string, action: (reader: unknown) => Promise<unknown>) => {
    reads++; return action({ getProject: async () => ({ id: projectId }),
      allocationRelations: () => ({ list: async () => page }) });
  } } as unknown as UnitOfWork;
  const service = { listRoleRevisions: async () => [], listRoleReviews: async () => [],
    listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [],
    listSchedules: async () => [], listScheduleRevisions: async () => [],
    listScheduleOccurrences: async () => [] } as unknown as WorkflowService;
  const app = await buildServer({ credentials, service, allocationRelations: new AllocationRelationsService({ uow }) });
  try {
    const path = `/api/projects/${projectId}/allocation-relations?roleId=${roleId}`;
    assert.equal((await app.inject({ url: path })).statusCode, 401);
    assert.equal((await app.inject({ url: `/api/projects/${id(9)}/allocation-relations?roleId=${roleId}`,
      headers: { authorization: `Bearer ${token}` } })).statusCode, 403);
    assert.equal(reads, 0);
    const allowed = await app.inject({ url: path, headers: { authorization: `Bearer ${token}` } });
    assert.equal(allowed.statusCode, 200); assert.deepEqual(allowed.json(), page);
    assert.equal(allowed.headers['cache-control'], 'no-store');
  } finally { await app.close(); }
});
