import type { Principal, RuntimeSessionRecord } from '@evoloop/contracts';
import type { RuntimeBinding, RuntimePort } from '@evoloop/contracts/runtime';
import type { NativeWorkspacePage, NativeWorkspaceReadOptions, WorkspaceRuntimeUpdate } from '@evoloop/contracts/session-timeline';
import { DomainError, type UnitOfWork } from '@evoloop/contracts/ports';
import { RuntimeServerError } from '@evoloop/adapter-codex-app-server';
import { bindingOf } from '../runtime/runner.js';
import type { WorkspaceHistoryOwner } from './index.js';

/** Open this adapter explicitly; this wrapper never starts a runner, recovery pump, or model Turn. */
export type ReadOnlyWorkspaceAdapter=Pick<RuntimePort,'inspect'|'readWorkspaceHistory'|'onWorkspaceUpdate'> & {
  open():Promise<void>;close():Promise<void>;isReady():boolean;
  registerBinding(binding:RuntimeBinding):Promise<void>;
  onDisconnect(listener:(reason:string)=>void):()=>void;
};
export class ReadOnlyWorkspaceOwner implements WorkspaceHistoryOwner {
  private opened=false;
  constructor(private readonly deps:{uow:UnitOfWork;adapter:ReadOnlyWorkspaceAdapter;
    /** Current exact owner grant, cwd and binding policy; fail closed on uncertainty. */
    authorize(principal:Principal,session:RuntimeSessionRecord):Promise<boolean>}){}
  async open(){await this.deps.adapter.open();this.opened=true}
  async close(){this.opened=false;await this.deps.adapter.close()}
  nativeAdapter():Pick<RuntimePort,'readWorkspaceHistory'|'onWorkspaceUpdate'>{
    return this.deps.adapter.readWorkspaceHistory
      ? {readWorkspaceHistory:this.deps.adapter.readWorkspaceHistory.bind(this.deps.adapter)}:{};
  }
  status(){return {available:this.opened&&this.deps.adapter.isReady()}}
  onWorkspaceUpdate(_listener:(event:WorkspaceRuntimeUpdate)=>void){return ()=>{}}
  onWorkspaceDisconnect(listener:(reason:string)=>void){return this.deps.adapter.onDisconnect(listener)}
  async workspaceBinding(principal:Principal,projectId:string,sessionId:string):Promise<RuntimeBinding>{
    if(!principal.actorId||!principal.projectIds.includes(projectId)||!principal.permissions.includes('read'))
      throw new DomainError('FORBIDDEN','Project read access is required');
    const session=await this.deps.uow.read(projectId,r=>r.getRuntimeSession(sessionId));
    if(!session||session.id!==sessionId||session.projectId!==projectId||!session.nativeThreadId||!session.nativeSessionId||
      !await this.deps.authorize(principal,session))
      throw new DomainError('FORBIDDEN','Exact owned Session binding is unavailable');
    return bindingOf(session);
  }
  async workspaceHistory(principal:Principal,projectId:string,sessionId:string,
    options:NativeWorkspaceReadOptions):Promise<NativeWorkspacePage>{
    if(!this.status().available||!this.deps.adapter.readWorkspaceHistory)
      throw new DomainError('RUNTIME_READ_UNAVAILABLE','Read-only native history connection is unavailable');
    const binding=await this.workspaceBinding(principal,projectId,sessionId);
    try{
      await this.deps.adapter.registerBinding(binding);
      await this.deps.adapter.inspect(binding);
      return await this.deps.adapter.readWorkspaceHistory(binding,options);
    }catch(error){
      if(error instanceof DomainError&&error.code==='FORBIDDEN')throw error;
      if(error instanceof RuntimeServerError&&error.category==='permission_denied')
        throw new DomainError('FORBIDDEN','Native history access was denied');
      await this.workspaceBinding(principal,projectId,sessionId);
      throw new DomainError('RUNTIME_READ_UNAVAILABLE','Exact native history read failed; saved messages remain available');
    }
  }
}
