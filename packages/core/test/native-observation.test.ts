import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceNativeObservation } from '../src/native-observation/index.ts';
import type { NativeObservationRecord, NativeObservationEvent } from '@evoloop/contracts/native-observation';
const identity = {projectId:'project',sessionId:'session',threadId:'thread',connectionId:'connection',observedAt:'2026-10-27T00:00:00.000Z'};
const event = (method:string,params:unknown,extra:Partial<NativeObservationEvent>={}):NativeObservationEvent=>({...identity,method,params,...extra});
const reduce = (previous:NativeObservationRecord|null,method:string,params:unknown,extra:Partial<NativeObservationEvent>={})=>reduceNativeObservation(previous,event(method,params,extra));
const started=(turnId:string)=>({threadId:'thread',turn:{id:turnId,status:'inProgress',items:[]}});

test('exact identity and current Turn reject unrelated and older events',()=>{
  let row=reduce(null,'turn/started',started('one'))!;
  assert.equal(reduce(row,'turn/diff/updated',{threadId:'other',turnId:'one',diff:'no'}),null);
  assert.equal(reduce(row,'turn/diff/updated',{threadId:'thread',turnId:'one',diff:'no'},{sessionId:'other'}),null);
  row=reduce(row,'turn/started',started('two'))!;
  assert.equal(row.currentTurn?.id,'two');assert.equal(row.diff,null);
  assert.equal(reduce(row,'turn/diff/updated',{threadId:'thread',turnId:'one',diff:'old'}),null);
  assert.equal(reduce(row,'item/completed',{threadId:'thread',turnId:'one',item:{id:'old',type:'fileChange',status:'completed'}}),null);
  assert.equal(reduce(row,'thread/status/changed',{threadId:'thread',status:{type:'active',activeFlags:[]}})?.status,'active');
});

test('terminal item does not regress and reasoning and outputs never enter projection',()=>{
  let row=reduce(null,'turn/started',started('one'))!;
  row=reduce(row,'item/completed',{threadId:'thread',turnId:'one',item:{id:'i',type:'commandExecution',status:'completed',command:'secret',aggregatedOutput:'secret'}})!;
  row=reduce(row,'item/started',{threadId:'thread',turnId:'one',item:{id:'i',type:'commandExecution',status:'inProgress',command:'secret'}})!;
  assert.equal(row.items[0]?.status,'completed');assert.equal(JSON.stringify(row).includes('secret'),false);
  assert.equal(reduce(row,'item/completed',{threadId:'thread',turnId:'one',item:{id:'r',type:'reasoning',content:['private']}}),null);
});

test('absolute usage overwrites, preserves unknown and zero, and never double adds subsets',()=>{
  let row=reduce(null,'turn/started',started('one'))!;
  const params={threadId:'thread',turnId:'one',tokenUsage:{total:{inputTokens:100,cachedInputTokens:80,outputTokens:30,reasoningOutputTokens:10,totalTokens:130},last:{inputTokens:5,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:1,totalTokens:7},modelContextWindow:null}};
  row=reduce(row,'thread/tokenUsage/updated',params)!;
  row=reduce(row,'thread/tokenUsage/updated',params)!;
  assert.equal(row.usage?.total.totalTokens,130);assert.equal(row.usage?.last.cachedInputTokens,0);
  row=reduce(row,'thread/tokenUsage/updated',{threadId:'thread',turnId:'one',tokenUsage:{total:{inputTokens:-1},last:{}}})!;
  assert.equal(row.usage?.total.inputTokens,null);assert.equal(row.usage?.total.totalTokens,null);
});

test('UTF-8 limits and bounded item/plan/diff projection are honest',()=>{
  let row=reduce(null,'turn/started',started('one'))!;
  for(let n=0;n<12;n++)row=reduce(row,'item/completed',{threadId:'thread',turnId:'one',item:{id:`i${n}`,type:'mcpToolCall',tool:'x'.repeat(300),status:'completed',arguments:'hidden'}})!;
  assert.equal(row.items.length,10);assert.equal(row.items[0]?.id,'i2');assert.ok(row.items.every(i=>i.name.length<=240));
  row=reduce(row,'turn/plan/updated',{threadId:'thread',turnId:'one',plan:Array.from({length:22},()=>({step:'🙂'.repeat(100),status:'pending'})),explanation:'🙂'.repeat(200)})!;
  assert.equal(row.plan?.steps.length,20);assert.equal(row.plan?.truncated,true);
  assert.ok(new TextEncoder().encode(row.plan!.steps[0]!.step).byteLength<=240);
  row=reduce(row,'turn/diff/updated',{threadId:'thread',turnId:'one',diff:'🙂'.repeat(3000)})!;
  assert.equal(row.diff?.truncated,true);assert.ok(new TextEncoder().encode(row.diff!.text).byteLength<=8192);
  assert.ok(new TextEncoder().encode(JSON.stringify(row)).byteLength<=24576);
});

test('reducer preserves the previous snapshot when a Turn status changes',()=>{
  const first=reduce(null,'turn/started',{threadId:'thread',turn:{id:'one',status:'inProgress',startedAt:100,items:[]}})!;
  const firstCopy=structuredClone(first);
  const completed=reduce(first,'turn/completed',{threadId:'thread',turn:{id:'one',status:'completed',startedAt:100,items:[]}})!;
  assert.deepEqual(first,firstCopy);
  assert.equal(completed.currentTurn?.status,'completed');
  const beforeStart=reduce(null,'item/started',{threadId:'thread',turnId:'two',item:{id:'i',type:'fileChange',status:'inProgress'}})!;
  const beforeCopy=structuredClone(beforeStart);
  const startedAfterItem=reduce(beforeStart,'turn/started',{threadId:'thread',turn:{id:'two',status:'inProgress',startedAt:110,items:[]}})!;
  assert.deepEqual(beforeStart,beforeCopy);
  assert.equal(startedAfterItem.currentTurn?.startedAt,110);
});

test('native startedAt rejects an older late Turn start when both timestamps are known',()=>{
  const current=reduce(null,'turn/started',{threadId:'thread',turn:{id:'new',status:'inProgress',startedAt:200,items:[]}})!;
  assert.equal(reduce(current,'turn/started',{threadId:'thread',turn:{id:'old',status:'inProgress',startedAt:100,items:[]}}),null);
  assert.equal(current.currentTurn?.id,'new');
  const newer=reduce(current,'turn/started',{threadId:'thread',turn:{id:'newer',status:'inProgress',startedAt:201,items:[]}})!;
  assert.equal(newer.currentTurn?.id,'newer');
  assert.equal(newer.items.length,0);
});
