import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import { leaseFencedUnitOfWork } from '../src/lease.ts';

test('manual stop transaction pins the current coordinator generation before mutation',async()=>{
  const calls:string[]=[];
  let current='first',held=true;
  const uow={read:async()=>null,transaction:async(_projectId:string,action:(tx:unknown)=>Promise<unknown>)=>{
    calls.push('begin');const result=await action({assertCoordinatorLeaseEpoch:async(nonce:string)=>{
      calls.push('fence');if(nonce!==current)throw new Error('LEASE_LOST');}});
    calls.push('commit');return result;
  }} as unknown as UnitOfWork;
  const guarded=leaseFencedUnitOfWork(uow,{nonce:'first',canWrite:()=>held});
  assert.equal(await guarded.transaction('project',async()=>{calls.push('change');return 'ok';}),'ok');
  assert.deepEqual(calls,['begin','fence','change','commit']);
  current='second';calls.length=0;
  await assert.rejects(guarded.transaction('project',async()=>{calls.push('change');}),/LEASE_LOST/);
  assert.deepEqual(calls,['begin','fence']);
  current='first';calls.length=0;
  await assert.rejects(guarded.transaction('project',async()=>{calls.push('change');held=false;}),/Coordinator lease lost/);
  assert.deepEqual(calls,['begin','fence','change']);
});
