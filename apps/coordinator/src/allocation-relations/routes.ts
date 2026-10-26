import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '@evoloop/contracts/ports';
import type { AllocationRelationsService } from '@evoloop/core/allocation-relations';

export function registerAllocationRelationRoutes(app: FastifyInstance, service: AllocationRelationsService): void {
  app.get('/api/projects/:projectId/allocation-relations', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    const principal = request.principal;
    if (!principal) throw new DomainError('FORBIDDEN', 'Project read access is required');
    const page = await service.list(principal, projectId, request.query);
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 256 * 1024)
      throw new DomainError('RESULT_TOO_LARGE', 'Allocation relation page exceeds the response limit');
    return page;
  });
}
