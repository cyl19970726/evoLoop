import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { RuntimeBinding, RuntimeSessionRecord, RuntimeSessionSpec } from '@evoloop/contracts/runtime';
import type { ExecutionProfileRevision, SessionRecoveryGate } from '@evoloop/contracts/session-recovery';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import type { RuntimeRunRecord, Task, TaskProposal, Delivery } from '@evoloop/contracts';
import { RuntimeWorkflowService } from '../src/runtime/service.ts';

const projectId=randomUUID(),sessionId=randomUUID(),oldRevisionId=randomUUID(),revisionId=randomUUID(),
  operationId=randomUUID(),actorId='approved-controller';
const now=new Date().toISOString();
const oldRevision:ExecutionProfileRevision={projectId,sessionId,revisionId:oldRevisionId,version:1,
  model:'old-model',sandbox:'workspace-write',approvalPolicy:'on-request',cwd:'/tmp/owned-project',
  authorizationScope:'task:approved',provenance:'reserved',previousRevisionId:null,
  operationId:randomUUID(),actorId,reason:'initial',evidenceRef:null,createdAt:now};
const revision:ExecutionProfileRevision={...oldRevision,revisionId,version:2,model:'old-model',
  sandbox:'danger-full-access',approvalPolicy:'never',
  provenance:'revised',previousRevisionId:oldRevisionId,operationId};
const session:RuntimeSessionRecord={projectId,id:sessionId,roleId:'approved-role',cwd:revision.cwd,
  authorizationScope:revision.authorizationScope,model:revision.model,sandbox:revision.sandbox,
  approvalPolicy:revision.approvalPolicy,state:'ready',version:4,nativeThreadId:'owned-thread',
  nativeSessionId:'owned-tree',operationId:randomUUID(),actorId,createdAt:now,updatedAt:now,
  executionProfile:{revision,activeRevisionId:oldRevisionId,activationState:'attempting',
    activationOperationId:operationId,attemptedAt:now,activationEvidence:null}};
const binding:RuntimeBinding={sessionId,projectId,roleId:session.roleId,nativeThreadId:'owned-thread',
  nativeSessionId:'owned-tree',cwd:session.cwd,authorizationScope:session.authorizationScope,
  owner:'evoloop-codex-app-server',resumeProfile:{actorId,model:'old-model',sandbox:oldRevision.sandbox,
    approvalPolicy:oldRevision.approvalPolicy,executionProfileRevisionId:oldRevisionId}};
const target:RuntimeSessionSpec={actorId,projectId,sessionId,roleId:session.roleId,cwd:session.cwd,
  authorizationScope:session.authorizationScope,model:'old-model',sandbox:session.sandbox,
  approvalPolicy:session.approvalPolicy,executionProfileRevisionId:revisionId};

test('trusted activation proof requires the original Thread, last active revision and operation',async()=>{
  const service=new RuntimeWorkflowService({uow:{read:async(_project:string,action:(reader:unknown)=>Promise<unknown>)=>
    action({getRuntimeSession:async()=>session,recovery:{getExecutionProfileRevision:async()=>oldRevision}})} as UnitOfWork,
    clock:{now:()=>now},ids:{next:randomUUID}});
  assert.equal(await service.verifyExecutionProfileActivation(projectId,binding,target,revisionId,operationId),true);
  assert.equal(await service.verifyExecutionProfileActivation(projectId,{...binding,nativeThreadId:'foreign'},target,revisionId,operationId),false);
  assert.equal(await service.verifyExecutionProfileActivation(projectId,binding,{...target,model:'other-model'},revisionId,operationId),false);
  assert.equal(await service.verifyExecutionProfileActivation(projectId,binding,{...target,sandbox:'workspace-write'},revisionId,operationId),false);
  assert.equal(await service.verifyExecutionProfileActivation(projectId,binding,target,revisionId,randomUUID()),false);
  session.executionProfile!.activationState='active';session.executionProfile!.activeRevisionId=revisionId;
  assert.equal(await service.verifyExecutionProfileActivation(projectId,binding,target,revisionId,operationId),false);
});

test('a resolved native profile still waits for the explicit retry decision before a Run starts',async()=>{
  const gate:SessionRecoveryGate={projectId,sessionId,version:3,phase:'blocked',causeKind:'execution_profile',
    causeId:revisionId,causeState:'active',reason:'review required',queueId:null,claimId:null,
    retryRunId:randomUUID(),resumeMessageId:null,decisionOperationId:null,updatedAt:now};
  const service=new RuntimeWorkflowService({uow:{read:async(_project:string,action:(reader:unknown)=>Promise<unknown>)=>
    action({recovery:{getRecoveryGate:async()=>gate}})} as UnitOfWork,
    clock:{now:()=>now},ids:{next:randomUUID}});
  assert.equal(await service.canStartRecoveredRun(projectId,sessionId,gate.retryRunId!),false);
  gate.phase='retrying';
  assert.equal(await service.canStartRecoveredRun(projectId,sessionId,randomUUID()),false);
  assert.equal(await service.canStartRecoveredRun(projectId,sessionId,gate.retryRunId!),true);
});

test('binding registration cannot inherit a different business sandbox after profile activation',async()=>{
  const active={...session,executionProfile:{...session.executionProfile!,activationState:'active' as const,
    activeRevisionId:revisionId}};
  const service=new RuntimeWorkflowService({uow:{read:async(_project:string,action:(reader:unknown)=>Promise<unknown>)=>
    action({getRuntimeSession:async()=>active})} as UnitOfWork,
    clock:{now:()=>now},ids:{next:randomUUID}});
  const approved:RuntimeBinding={...binding,resumeProfile:{...binding.resumeProfile!,model:'old-model',
    sandbox:'danger-full-access',approvalPolicy:'never',
    executionProfileRevisionId:revisionId}};
  await service.verifyBinding(projectId,approved);
  await assert.rejects(()=>service.verifyBinding(projectId,binding),/registered native profile differs/);
  await assert.rejects(()=>service.verifyBinding(projectId,{...approved,
    resumeProfile:{...approved.resumeProfile!,sandbox:'read-only'}}),/registered native profile differs/);
});

test('a closed accepted Task must reopen before its source Run terminal result changes',async()=>{
  const runId=randomUUID(),taskId=randomUUID();
  const run={projectId,id:runId,taskId,nativeTurnId:'owned-turn',version:4,state:'completed'} as RuntimeRunRecord;
  const task={projectId,id:taskId,state:'done'} as Task;
  const policy={projectId,taskId,acceptanceMode:'independent_agent'} as TaskProposal;
  const delivery={projectId,taskId,runId,technicalResult:'passed',sourceRunVersion:4} as Delivery;
  const tx={getRuntimeRun:async()=>run,listRuntimeEvents:async()=>[],getTask:async()=>task,getTaskProposal:async()=>policy,
    listDeliveries:async()=>[delivery]};
  const service=new RuntimeWorkflowService({uow:{transaction:async(_project:string,action:(value:unknown)=>Promise<unknown>)=>
    action(tx)} as UnitOfWork,clock:{now:()=>now},ids:{next:randomUUID}});
  await assert.rejects(()=>service.reconcileTerminalObservation(projectId,runId,'owned-turn','failed',null,
    {itemsDigest:'a'.repeat(64),completedAtUtc:now},4,
    {actorId,projectIds:[projectId],permissions:['read','write','review']},'Native failure confirmed'),
  error=>error instanceof Error && 'code' in error && error.code==='TASK_REOPEN_REQUIRED');
  assert.equal(run.state,'completed');
});
