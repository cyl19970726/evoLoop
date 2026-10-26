import type { Principal } from '@evoloop/contracts';
import type { AllocationRelationQuery, AllocationTracePage } from '@evoloop/contracts/allocation-relations';
import { DomainError, type UnitOfWork } from '@evoloop/contracts/ports';
import { z } from 'zod';

const sessionKey = z.string().regex(/^(owned|external):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const page = { limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(4096).optional() };
/** Strict variants reject missing, combined, or unrelated filters. */
const querySchema = z.union([
  z.strictObject({ roleId: z.uuid(), ...page }),
  z.strictObject({ sessionKey, ...page }),
  z.strictObject({ discussionId: z.uuid(), ...page }),
]);

const scopeOf = (principal: Principal): string => JSON.stringify({ actorId: principal.actorId,
  permissions: [...new Set(principal.permissions)].sort() });

export class AllocationRelationsService {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  async list(principal: Principal, projectId: string, query: unknown): Promise<AllocationTracePage> {
    if (!principal.actorId || !principal.projectIds.includes(projectId) || !principal.permissions.includes('read'))
      throw new DomainError('FORBIDDEN', 'Project read access is required');
    const parsed = querySchema.parse(query) as AllocationRelationQuery;
    return this.deps.uow.read(projectId, async reader => {
      if (!await reader.getProject()) throw new DomainError('NOT_FOUND', 'Project was not found');
      const relations = reader.allocationRelations?.(scopeOf(principal));
      if (!relations) throw new DomainError('CAPABILITY_UNAVAILABLE', 'Allocation relations are unavailable');
      return relations.list(parsed);
    });
  }
}
