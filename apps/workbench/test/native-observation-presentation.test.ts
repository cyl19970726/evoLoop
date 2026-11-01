import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeObservationPresentation } from '../src/sessions/nativeObservationPresentation';

test('protected native diff preserves the content indicator without receiving the raw patch',()=>{
  const projectId='00000000-0000-4000-8000-000000000001';
  const sessionId='00000000-0000-4000-8000-000000000002';
  const observedAt='2026-11-02T00:00:00.000Z';
  const view={projectId,sessionId,threadId:'native-thread',version:1,observedAt,lastEventAt:observedAt,
    freshness:'stale',staleReason:'disconnected',status:'active',
    currentTurn:{id:'turn-1',status:'inProgress',source:null,startedAt:null},
    items:[],plan:null,diff:{turnId:'turn-1',text:'',contentProtected:true,truncated:false,observedAt},usage:null};
  const protectedResult=nativeObservationPresentation(view,projectId,sessionId);
  assert.equal(protectedResult.error,null);
  assert.equal(protectedResult.progress?.diff?.hasContent,true);
  assert.equal(nativeObservationPresentation({...view,diff:{...view.diff,contentProtected:false}},projectId,sessionId)
    .progress?.diff?.hasContent,false);
  assert.match(nativeObservationPresentation({...view,diff:{...view.diff,contentProtected:'yes'}},projectId,sessionId)
    .error??'',/无法核实/);
});
