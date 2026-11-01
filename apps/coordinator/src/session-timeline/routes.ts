import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '@evoloop/contracts/ports';
import type { SessionTimelineService } from './index.js';
import type { RuntimeRunner } from '../runtime/runner.js';

const path=z.strictObject({projectId:z.uuid(),key:z.string().regex(/^(?:owned|external):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)});
const who=(principal:import('@evoloop/contracts').Principal|null)=>{
  if(!principal)throw new DomainError('FORBIDDEN','Authentication required');return principal;
};
export function registerSessionTimelineRoutes(app:FastifyInstance,service:SessionTimelineService,runner?:RuntimeRunner){
  app.get('/api/projects/:projectId/session-work/:key/timeline',request=>{
    const {projectId,key}=path.parse(request.params);
    const q=z.strictObject({cursor:z.string().min(1).max(8192).optional(),
      messagesCursor:z.string().min(1).max(8192).optional(),limit:z.coerce.number().int().min(1).max(50).default(25),
      source:z.enum(['native','messages','both']).default('both'),
      turnId:z.string().min(1).max(256).optional(),itemId:z.string().min(1).max(256).optional()}).parse(request.query);
    if(request.workerIdentity)throw new DomainError('FORBIDDEN','Worker timeline scope requires an exact fixed Run Item');
    return service.page(who(request.principal),projectId,key,q);
  });
  app.get('/api/projects/:projectId/session-work/:key/timeline/items/:itemId',async request=>{
    const {projectId,key,itemId}=path.extend({itemId:z.string().min(1).max(256)}).parse(request.params);
    const q=z.strictObject({turnId:z.string().min(1).max(256),runId:z.uuid().optional()}).parse(request.query);
    const principal=who(request.principal);
    if(request.workerIdentity){
      if(!q.runId||!runner)throw new DomainError('FORBIDDEN','Exact fixed Run required');
      await runner.workerFixedRunMetadata(principal,projectId,q.runId,request.workerIdentity);
    }else if(q.runId)throw new DomainError('FORBIDDEN','Worker Run scope cannot be self-asserted');
    return service.item(principal,projectId,key,q.turnId,itemId,request.workerIdentity?q.runId:undefined);
  });
  app.get('/api/projects/:projectId/session-work/:key/timeline/updates',request=>{
    const {projectId,key}=path.parse(request.params);
    const q=z.strictObject({after:z.string().min(1).max(8192).optional(),
      waitMs:z.coerce.number().int().min(0).max(20000).default(15000)}).parse(request.query);
    if(request.workerIdentity)throw new DomainError('FORBIDDEN','Worker live scope unavailable');
    return service.updates(who(request.principal),projectId,key,q.after,q.waitMs);
  });
}
