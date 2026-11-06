import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { RuntimeRecordEvent, RuntimeSessionRecord } from '@evoloop/contracts';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import { RuntimeWorkflowService } from '../src/runtime/service.ts';

test('child loss has one project anchor and readback, including before native binding',async()=>{
  const projectId=randomUUID(),events:RuntimeRecordEvent[]=[];
  const bound={id:randomUUID(),state:'ready',nativeThreadId:randomUUID()} as RuntimeSessionRecord;
  const reserved={id:randomUUID(),state:'reserved',nativeThreadId:null} as RuntimeSessionRecord;
  const store={listRuntimeSessions:async()=>[bound,reserved],
    appendRuntimeEvent:async(value:RuntimeRecordEvent)=>{events.push(value);},
    listRuntimeHostEvents:async()=>events.toReversed()};
  const uow={transaction:async(_project:string,act:(tx:typeof store)=>Promise<unknown>)=>act(store),
    read:async(_project:string,act:(reader:typeof store)=>Promise<unknown>)=>act(store)} as unknown as UnitOfWork;
  const service=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
  const diagnostic={startId:randomUUID(),pid:1234,startedAtUtc:'2026-11-06T00:00:00.000Z',
    observedAtUtc:'2026-11-06T00:01:00.000Z',firstLossAtUtc:'2026-11-06T00:01:00.000Z',
    firstLossReason:'stdout_closed',stopReason:'process_exited',exitObserved:true,
    exitedAtUtc:'2026-11-06T00:01:01.000Z',exitCode:1,exitSignal:null,nativeTurnOutcome:'unknown' as const};
  await service.recordNativeChildDiagnostic(projectId,diagnostic);
  assert.equal(events.length,1);
  assert.equal(events[0]?.sessionId,bound.id);
  assert.equal(events[0]?.runId,null);
  assert.equal(events[0]?.kind,'native.childDiagnostic');
  assert.deepEqual(JSON.parse(events[0]!.detail),diagnostic);
  assert.deepEqual(await service.recentNativeChildDiagnostics(projectId),events);
  events.length=0;
  store.listRuntimeSessions=async()=>[reserved];
  await service.recordNativeChildDiagnostic(projectId,diagnostic);
  assert.equal(events.length,1);
  assert.equal(events[0]?.sessionId,reserved.id);
  await assert.rejects(service.recordNativeChildDiagnostic(projectId,{...diagnostic,privateMessage:'secret'} as typeof diagnostic),
    (error:unknown)=>error instanceof Error&&error.message.includes('invalid bounded fields'));
  await assert.rejects(service.recordNativeChildDiagnostic(projectId,{...diagnostic,pid:-1}),
    (error:unknown)=>error instanceof Error&&error.message.includes('invalid bounded fields'));
  assert.equal(events.length,1);
});
