import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Transaction, UnitOfWork } from '@evoloop/contracts/ports';
import type { RuntimeSessionRecord } from '@evoloop/contracts';
import type { NativeExecutionEnvironment, NativeExecutionTransaction } from '@evoloop/contracts/native-execution';
import { permitNativeStartup } from '../src/runtime/native-admission.ts';
import { RuntimeWorkflowService } from '../src/runtime/service.ts';

const intent = {kind:'message' as const,projectId:'project',sessionId:'session',operationId:'original-operation',messageId:'original-message'};
function transaction(environment: NativeExecutionEnvironment | null, admit: NativeExecutionTransaction['permitNativeStartup']): Transaction {
  return {nativeExecution:{getNativeExecutionEnvironment:async()=>environment,permitNativeStartup:admit}} as Transaction;
}
test('legacy admission cannot be mistaken for an adopted verified environment', async()=>{
  await permitNativeStartup({} as Transaction,intent);
  await assert.rejects(()=>permitNativeStartup({} as Transaction,intent,1),{code:'NATIVE_CONTROL_UNAVAILABLE'});
  let calls=0;
  const tx=transaction(null,async()=>{calls++;});
  await permitNativeStartup(tx,intent);
  await assert.rejects(()=>permitNativeStartup(tx,intent,1),{code:'NATIVE_CONTROL_UNAVAILABLE'});
  assert.equal(calls,0);
});
test('adopted control requires an explicit epoch instead of reading the latest and granting it', async()=>{
  let calls=0;
  const tx=transaction({epoch:9,mode:'unknown'} as NativeExecutionEnvironment,async()=>{calls++;});
  for(const epoch of [undefined,NaN,0,-1,1.5])
    await assert.rejects(()=>permitNativeStartup(tx,intent,epoch),{code:'NATIVE_EPOCH_REQUIRED'});
  assert.equal(calls,0);
});
test('the original operation and observed epoch reach the transactional fence without replacement', async()=>{
  const tx=transaction({epoch:10,mode:'message_verified'} as NativeExecutionEnvironment,async permit=>{
    assert.deepEqual(permit,{...intent,expectedEpoch:9});
    throw Object.assign(new Error('stale epoch'),{code:'NATIVE_ENVIRONMENT_CHANGED'});
  });
  await assert.rejects(()=>permitNativeStartup(tx,intent,9),{code:'NATIVE_ENVIRONMENT_CHANGED'});
});
test('creating a reserved Session locks its identity without rejecting its already requested business work',async()=>{
  const log:string[]=[];
  const session={id:'session',projectId:'project',operationId:'original-create',state:'reserved',version:1} as RuntimeSessionRecord;
  const tx={
    lockRuntimeSession:async()=>{log.push('session-row');return session;},
    sessionMessages:{assertSessionVacant:async()=>{throw new Error('A requested Run is not an active native Turn');}},
    recovery:{lockRecoveryGate:async()=>{log.push('session-gate');}},
    nativeExecution:{getNativeExecutionEnvironment:async()=>({epoch:3,mode:'business_verified'}),
      permitNativeStartup:async permit=>{assert.equal(permit.operationId,'original-create');assert.equal(permit.expectedEpoch,3);log.push('global-permit');}},
    updateRuntimeSession:async next=>{assert.equal(next.state,'creating');log.push('creating');},
    appendRuntimeEvent:async()=>{log.push('event');},
  } as unknown as Transaction;
  const uow={transaction:async(_project,work)=>work(tx)} as UnitOfWork;
  const service=new RuntimeWorkflowService({uow,clock:{now:()=>new Date(0).toISOString()},ids:{next:()=> 'event'}});
  await service.beginSessionCreate('project','session',3);
  assert.deepEqual(log,['session-gate','session-row','global-permit','creating','event']);
});
