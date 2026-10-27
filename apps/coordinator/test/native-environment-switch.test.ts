import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeExecutionEnvironment, NativeExecutionOwner, NativeExecutionTransaction,
  NativeExecutionTransition } from '@evoloop/contracts/native-execution';
import { NativeEnvironmentSwitcher, type NativeEnvironmentSwitchHost } from '../src/runtime/native-environment-switch.ts';

const policy = 'a'.repeat(64);
const targetPolicy = 'b'.repeat(64);
const owner: NativeExecutionOwner = {nonce:'new-child',pid:123,startIdentity:'process-start-123'};
const input = (purpose:'message'|'business'='message',expectedEpoch=1): NativeExecutionTransition => ({
  expectedEpoch,operationId:'switch-original',purpose,projectId:'project',sessionId:'session',
  nativeThreadId:'original-thread',messageId:purpose==='message'?'original-message':null,
  expectedPolicyHash:targetPolicy,reason:'Test bounded switch',
});
function fixture(overrides: Partial<NativeEnvironmentSwitchHost>={}, maxDrainWaitMs=1000) {
  const log:string[]=[];
  let row={epoch:1,mode:'business_verified',previousMode:null,ownerNonce:'old-child'} as NativeExecutionEnvironment;
  let savedOwner: NativeExecutionOwner | null=null;
  const store:Partial<NativeExecutionTransaction>={
    beginTransition:async target=>{
      assert.equal(target.expectedEpoch,row.epoch);
      log.push('transition');
      row={...row,epoch:row.epoch+1,previousMode:row.mode,mode:'transition',targetPurpose:target.purpose};return row;
    },
    cancelPreparation:async()=>{log.push('cancel');row={...row,mode:row.previousMode!};return row;},
    markNativeAttempt:async()=>{log.push('native-intent');return row;},
    recordOldOwnerExit:async()=>{log.push('exit-recorded');return row;},
    recordSpawnedOwner:async(_epoch,_op,identity)=>{log.push('owner-recorded');savedOwner=identity;return row;},
    verifyEnvironment:async(_epoch,_op,identity,hash,_evidence,verifiedTarget)=>{
      assert.deepEqual(identity,savedOwner);assert.equal(hash,policy);assert.equal(verifiedTarget,targetPolicy);log.push('verified');
      row={...row,mode:row.targetPurpose==='message'?'message_verified':'business_verified'};return row;
    },
    markEnvironmentUnknown:async()=>{log.push('unknown');row={...row,mode:'unknown'};return row;},
  };
  const host:NativeEnvironmentSwitchHost={
    pauseNewStartup:()=>{log.push('pause-new');return()=>{log.push('resume-new');};},
    drainAdmitted:async()=>{log.push('admitted-settled');return true;},
    closeCurrent:async()=>{log.push('child-exit');return 'exit://old-child';},
    startAndVerify:async(_target,recordOwner)=>{
      log.push('spawn');await recordOwner(owner);log.push('cold-resume-and-qualify');
      return {owner,targetPolicyHash:targetPolicy,policyHash:policy,evidenceRef:'qualification://new-child'};
    },...overrides,
  };
  const switcher=new NativeEnvironmentSwitcher({control:async work=>work(store as NativeExecutionTransaction),
    host,maxDrainWaitMs,now:()=>100});
  return {switcher,log,row:()=>row};
}
test('admitted work settles before exit; new child is recorded before cold resume; business restore releases admission',async()=>{
  const f=fixture();
  const ready=await f.switcher.prepare(input());
  assert.equal(ready.kind,'ready');assert.equal(ready.environment.mode,'message_verified');
  assert.deepEqual(f.log,['transition','pause-new','admitted-settled','native-intent','child-exit',
    'exit-recorded','spawn','owner-recorded','cold-resume-and-qualify','verified']);
  await f.switcher.prepare(input('business',2));
  assert.equal(f.row().mode,'business_verified');
  assert.equal(f.log.filter(x=>x==='pause-new').length,1);
  assert.equal(f.log.at(-1),'resume-new');
});
test('drain timeout restores business admission without closing child or creating a message operation',async()=>{
  const f=fixture({drainAdmitted:async()=>false});
  assert.equal((await f.switcher.prepare(input())).kind,'waiting');
  assert.deepEqual(f.log,['transition','pause-new','cancel','resume-new']);
  assert.equal(f.row().mode,'business_verified');
});
test('the configured deadline is enforced even when drain observation does not complete',async()=>{
  let signal:AbortSignal|undefined;
  const f=fixture({drainAdmitted:async(_deadline,s)=>{signal=s;return new Promise<boolean>(()=>{});}},5);
  assert.equal((await f.switcher.prepare(input())).kind,'waiting');
  assert.equal(signal?.aborted,true);assert.equal(f.log.includes('child-exit'),false);
});
test('a close acknowledgement loss persists unknown without spawning a replacement or reopening admission',async()=>{
  const f=fixture({closeCurrent:async()=>{throw new Error('exit unconfirmed');}});
  await assert.rejects(()=>f.switcher.prepare(input()),/exit unconfirmed/);
  assert.deepEqual(f.log,['transition','pause-new','admitted-settled','native-intent','unknown']);
  assert.equal(f.row().mode,'unknown');
});
test('a spawned child with an unconfirmed resume is not replaced or automatically restored',async()=>{
  let spawned=0;
  const f=fixture({startAndVerify:async(_target,record)=>{spawned++;await record(owner);throw new Error('resume unknown');}});
  await assert.rejects(()=>f.switcher.prepare(input()),/resume unknown/);
  assert.equal(spawned,1);assert.equal(f.row().mode,'unknown');
  assert.equal(f.log.includes('resume-new'),false);assert.equal(f.log.includes('verified'),false);
});
test('verification cannot silently skip persisted owner registration',async()=>{
  const f=fixture({startAndVerify:async()=>({owner,targetPolicyHash:targetPolicy,policyHash:policy,evidenceRef:'invalid://unrecorded'})});
  await assert.rejects(()=>f.switcher.prepare(input()),/owner was not persisted/);
  assert.equal(f.row().mode,'unknown');assert.equal(f.log.includes('verified'),false);
});
test('an observed fingerprint cannot verify a different target policy',async()=>{
  const f=fixture({startAndVerify:async(_target,record)=>{
    await record(owner);return {owner,targetPolicyHash:'c'.repeat(64),policyHash:policy,evidenceRef:'invalid://wrong-target'};
  }});
  await assert.rejects(()=>f.switcher.prepare(input()),/original target policy/);
  assert.equal(f.row().mode,'unknown');assert.equal(f.log.includes('verified'),false);
});
test('concurrent switch requests are rejected instead of queuing another process change',async()=>{
  let settle!:(value:boolean)=>void;
  const f=fixture({drainAdmitted:()=>new Promise<boolean>(resolve=>{settle=resolve;})});
  const first=f.switcher.prepare(input());
  await assert.rejects(()=>f.switcher.prepare(input()),{code:'NATIVE_SWITCH_BUSY'});
  await new Promise(resolve=>setImmediate(resolve));settle(true);await first;
  assert.equal(f.log.filter(x=>x==='transition').length,1);
});
