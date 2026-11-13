import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeBinding } from '@evoloop/contracts/runtime';
import { WorkspaceHistoryReader } from '../src/workspace-read.js';
import { mapWorkspaceEvent, mapWorkspaceItem } from '../src/workspace-map.js';

const binding:RuntimeBinding={sessionId:'session',roleId:'role',projectId:'project',nativeThreadId:'thread',nativeSessionId:'thread',cwd:'/project',authorizationScope:'scope',owner:'evoloop-codex-app-server'};
const meta=(mode='paginated')=>({thread:{id:'thread',sessionId:'thread',cwd:'/project',historyMode:mode}});
const msg=(id:string,phase?:string)=>({type:'agentMessage',id,text:`text ${id}`,phase});
const wrap=(turnId:string,item:unknown,startedAtMs?:number)=>({turnId,item,startedAtMs});
const fake=(rpc:(method:string,params:any)=>unknown,experimental=false)=>new WorkspaceHistoryReader(async(m,p)=>rpc(m,p),()=>experimental);

test('standard pages span 21 turns and over 100 items without skipping source IDs',async()=>{
  const rows=Array.from({length:21},(_,t)=>Array.from({length:t===20?121:1},(_,i)=>wrap(`turn-${t}`,msg(`${t}-${i}`),1700000000000+t*1000+i))).flat();
  let reads=0;
  const reader=fake((method,p)=>{
    if(method==='thread/read')return meta();
    if(method==='thread/items/list'){
      reads++;const offset=p.cursor?Number(p.cursor):0;
      const descending=[...rows].reverse();const data=descending.slice(offset,offset+p.limit);
      return {data,nextCursor:offset+data.length<descending.length?String(offset+data.length):null};
    }
    if(method==='thread/turns/list')return {data:Array.from({length:21},(_,t)=>({id:`turn-${t}`,status:'completed',startedAt:1700000000+t,completedAt:1700000100+t,items:[]})),nextCursor:null};
    throw new Error(method);
  });
  const ids:string[]=[];let cursor:string|null=null;let pages=0;
  do{const page=await reader.read(binding,{limit:50,...(cursor?{cursor}:{})});ids.push(...page.entries.map(e=>e.nativeItemId!));cursor=page.nextCursor;pages++;assert.equal(page.method,'items');assert.equal(page.itemEnumerationComplete,cursor===null);}while(cursor);
  assert.equal(ids.length,141);assert.equal(new Set(ids).size,141);assert.equal(reads,pages);assert.ok(pages>=3);
  await assert.rejects(()=>reader.read({...binding,sessionId:'other'},{cursor:'bogus'}),/invalid cursor/);
});

test('complete Item enumeration is independent of a long public reply preview',async()=>{
  const operationId='11111111-1111-1111-1111-111111111111';
  const reader=fake(method=>{
    if(method==='thread/read')return meta();
    if(method==='thread/items/list')return {data:[
      wrap('turn',{id:'answer',type:'agentMessage',phase:'final_answer',text:'x'.repeat(5000)}),
      wrap('turn',{id:'input',type:'userMessage',content:[{type:'text',text:`[evoloop-message-operation:${operationId}]\nprivate envelope`}]}),
    ],nextCursor:null};
    if(method==='thread/turns/list')return {data:[{id:'turn',status:'completed',startedAt:1,completedAt:2}],nextCursor:null};
    assert.fail(method);
  });
  const page=await reader.read(binding,{turnId:'turn'});
  assert.equal(page.partial,true);
  assert.equal(page.itemEnumerationComplete,true);
  assert.equal(page.nextCursor,null);
  assert.deepEqual(page.limitations,[]);
  assert.equal(page.turns[0]?.state,'completed');
  const [input,answer]=page.entries;
  if(input?.kind!=='message'||answer?.kind!=='message')assert.fail('expected input and reply');
  assert.deepEqual(input.inputReference,{kind:'operation-marker',source:'message',operationId});
  assert.equal(input.body,'');
  assert.equal(answer.body.length,4096);
  assert.equal(answer.truncated,true);
});

test('exact Turn metadata follows standard cursors beyond the newest 100 within a 1000 Turn bound',async t=>{
  for(const target of [100,999,1000])await t.test(`Turn at offset ${target}`,async()=>{
    const metadata=Array.from({length:1001},(_,i)=>({id:`turn-${i}`,status:'completed',startedAt:1,completedAt:2}));
    const cursors:Array<string|null>=[];
    const reader=fake((method,p)=>{
      if(method==='thread/read')return meta();
      if(method==='thread/items/list'){
        assert.equal(p.turnId,`turn-${target}`);
        return {data:[wrap(p.turnId,{id:'input',type:'userMessage',clientId:'operation',content:[]})],nextCursor:null};
      }
      if(method==='thread/turns/list'){
        assert.deepEqual({limit:p.limit,sortDirection:p.sortDirection,itemsView:p.itemsView},{limit:100,sortDirection:'desc',itemsView:'notLoaded'});
        cursors.push(p.cursor??null);
        const offset=p.cursor?Number(p.cursor):0;
        return {data:metadata.slice(offset,offset+p.limit),nextCursor:offset+p.limit<metadata.length?String(offset+p.limit):null};
      }
      assert.fail(method);
    });
    const page=await reader.read(binding,{turnId:`turn-${target}`});
    assert.equal(cursors.length,Math.min(Math.floor(target/100)+1,10));
    assert.deepEqual(cursors,[null,...Array.from({length:cursors.length-1},(_,i)=>String((i+1)*100))]);
    assert.equal(page.nextCursor,null);
    assert.equal(page.itemEnumerationComplete,true);
    if(target<1000){
      assert.equal(page.partial,false);
      assert.deepEqual(page.limitations,[]);
      assert.equal(page.turns.length,1);
      assert.equal(page.turns[0]?.id,`turn-${target}`);
      assert.equal(page.turns[0]?.state,'completed');
      assert.equal(page.turns[0]?.completedAt,'1970-01-01T00:00:02.000Z');
    }else{
      assert.deepEqual(page.turns,[]);
      assert.equal(page.partial,true);
      assert.match(page.limitations.join(' '),/10 pages.*100/);
    }
  });
});

test('ordinary Thread pages keep one metadata page and metadata cursor or storage failures propagate',async()=>{
  let metadataReads=0;
  const reader=fake(method=>{
    if(method==='thread/read')return meta();
    if(method==='thread/items/list')return {data:[wrap('old',msg('answer'))],nextCursor:null};
    if(method==='thread/turns/list'){
      metadataReads++;
      return {data:Array.from({length:100},(_,i)=>({id:`recent-${i}`,status:'completed'})),nextCursor:'older'};
    }
    assert.fail(method);
  });
  const page=await reader.read(binding);
  assert.equal(metadataReads,1);
  assert.equal(page.itemEnumerationComplete,true);
  assert.equal(page.partial,true);
  assert.deepEqual(page.turns,[]);
  assert.match(page.limitations.join(' '),/bounded page/);
  for(const failure of ['cursor','storage']){
    const broken=fake((method,p)=>{
      if(method==='thread/read')return meta();
      if(method==='thread/items/list')return {data:[wrap('old',msg('answer'))],nextCursor:null};
      if(method==='thread/turns/list'){
        if(failure==='storage')throw new Error('metadata storage rejected');
        return {data:[{id:'recent',status:'completed'}],nextCursor:p.cursor??'repeat'};
      }
      assert.fail(method);
    });
    await assert.rejects(()=>broken.read(binding,{turnId:'old'}),failure==='cursor'?/invalid turns metadata cursor/:/metadata storage rejected/);
  }
});

test('timeline accepts pinned boundary snake fields and camel wire uncertainty with strict identity',async()=>{
  const page={data:[{type:'turnStarted',position:1,turn_id:'turn-1',started_at:1700000000},
    {type:'item',position:1,turnId:'turn-1',item:msg('m','partial_answer')},
    {type:'turnCompleted',position:3,turnId:'turn-1',status:'completed',completedAt:1700000001}],nextCursor:null,activeRealtimeSessionAtPageStart:null};
  const reader=fake((method)=>method==='thread/read'?meta():method==='thread/timeline/list'?page:assert.fail(method),true);
  const result=await reader.read(binding);
  assert.equal(result.method,'timeline');assert.equal(result.entries[0]?.kind,'message');assert.equal(result.turns[0]?.startedAt,'2023-11-14T22:13:20.000Z');
  assert.equal(result.turns[0]?.state,'unknown');
  assert.deepEqual(result.entries[0]?.order,{kind:'timeline-position',key:'native:thread:turn-1:m',position:1,generation:null});
  assert.deepEqual(result.turns[0]?.order,{kind:'turn-boundary',key:'boundary:thread:turn-1:start',position:1,generation:null});
  assert.equal(result.turns[1]?.completedAt,'2023-11-14T22:13:21.000Z');
  assert.equal(result.itemEnumerationComplete,true);
  page.data[1]={type:'item',position:2,turnId:'wrong',item:msg('m','partial_answer')} as any;
  assert.equal((await reader.read(binding)).entries[0]?.turnId,'wrong');
  page.data[1]={type:'item',position:2,turnId:'',item:msg('m','partial_answer')} as any;
  await assert.rejects(()=>reader.read(binding),/invalid timeline item/);
});

test('experimental unsupported store falls to standard; permission and malformed cursor propagate',async()=>{
  const methods:string[]=[];
  const make=(code:number)=>fake((method,p)=>{methods.push(method);if(method==='thread/read')return meta();
    if(method==='thread/timeline/list')throw Object.assign(new Error('rejected'),{code});
    if(method==='thread/items/list')return {data:[wrap('turn',msg('m'))],nextCursor:null};
    if(method==='thread/turns/list')return {data:[{id:'turn',status:'completed',items:[]}],nextCursor:null};
    assert.fail(method);},true);
  const fallback=await make(-32601).read(binding);
  assert.equal(fallback.method,'items');assert.equal(fallback.itemEnumerationComplete,true);
  assert.deepEqual(methods.slice(0,3),['thread/read','thread/timeline/list','thread/items/list']);
  await assert.rejects(()=>make(-32600).read(binding),/rejected/);
  await assert.rejects(()=>make(-32601).read(binding,{cursor:'invalid'}),/invalid cursor/);
});

test('legacy full-turn fallback verifies full view and continues a 121 item turn',async()=>{
  const turn={id:'turn',status:'completed',itemsView:'full',items:Array.from({length:121},(_,i)=>msg(`m-${i}`))};
  const calls:string[]=[];
  const reader=fake((method)=>{calls.push(method);if(method==='thread/read')return meta('legacy');
    if(method==='thread/items/list')throw Object.assign(new Error('unsupported'),{code:-32601});
    if(method==='thread/turns/list')return {data:[turn],nextCursor:null};assert.fail(method);});
  let cursor:string|null=null;let ids:string[]=[];const pages:string[][]=[];
  do{const p=await reader.read(binding,{limit:50,...(cursor?{cursor}:{})});assert.equal(p.method,'turns-full');
    const pageIds=p.entries.map(x=>x.nativeItemId!);pages.push(pageIds);ids=[...pageIds,...ids];cursor=p.nextCursor;assert.equal(p.itemEnumerationComplete,cursor===null);}while(cursor);
  assert.deepEqual(pages.map(page=>[page[0],page.at(-1)]),[['m-71','m-120'],['m-21','m-70'],['m-0','m-20']]);
  assert.deepEqual(ids,Array.from({length:121},(_,i)=>`m-${i}`));
  assert.equal(calls.filter(x=>x==='thread/items/list').length,1);
  turn.itemsView='summary';await assert.rejects(()=>reader.read(binding),/legacy full items unavailable/);
});

test('mapper preserves public phases and withholds private input and tool payloads',()=>{
  for(const [phase,expected] of [['commentary','commentary'],['partial_answer','partial_answer'],['final_answer','final_answer'],[undefined,'unknown']]){
    const item=mapWorkspaceItem(msg('a',phase),'turn',binding,'2026-01-01T00:00:00.000Z');
    assert.equal(item?.kind,'message');if(item?.kind==='message')assert.equal(item.phase,expected);
  }
  const input=mapWorkspaceItem({id:'u',type:'userMessage',clientId:'client',content:[{type:'text',text:'handoff credential SECRET'}]},'turn',binding,'now');
  assert.equal(input?.kind,'message');if(input?.kind==='message'){assert.equal(input.body,'');assert.equal(input.clientId,'client');}
  const operation='a0000000-0000-4000-8000-000000000003';
  for(const source of ['run','message'] as const){
    const marked=mapWorkspaceItem({id:source,type:'userMessage',clientId:null,content:[{type:'text',text:`[evoloop-${source}-operation:${operation}]\nsecret envelope`}]},'turn',binding,'now');
    if(marked?.kind==='message'){
      assert.deepEqual(marked.inputReference,{kind:'operation-marker',source,operationId:operation});
      assert.equal(marked.body,'');assert.equal(JSON.stringify(marked).includes('secret envelope'),false);
    }else assert.fail('expected marked input');
  }
  for(const content of [`before [evoloop-message-operation:${operation}]\nsecret`,`[evoloop-message-operation:${operation}] secret`,
    `[evoloop-message-operation:${operation.toUpperCase()}]\nsecret`,`[evoloop-message-operation:invalid]\nsecret`]){
    const unmarked=mapWorkspaceItem({id:'unmarked',type:'userMessage',content:[{type:'text',text:content}]},'turn',binding,'now');
    if(unmarked?.kind==='message')assert.equal(unmarked.inputReference,undefined);
  }
  const command={id:'c',type:'commandExecution',command:'cat /secret/token',cwd:'/secret',aggregatedOutput:'SECRET',commandActions:[{type:'read',name:'cat',path:'/project/src/a.ts',command:'cat SECRET'},{type:'search',query:'SECRET',path:'/outside',command:'rg SECRET'}],status:'failed',exitCode:2,durationMs:30};
  const summary=mapWorkspaceItem(command,'turn',binding,'now');assert.equal(summary?.kind,'tool');
  assert.equal(JSON.stringify(summary).includes('SECRET'),false);assert.equal(JSON.stringify(summary).includes('/outside'),false);
  if(summary?.kind==='tool'){assert.match(summary.summary,/Read file src\/a.ts/);assert.equal(summary.name,'Command');assert.equal(summary.exitCode,2);assert.equal(summary.durationMs,30);assert.equal(summary.state,'failed');}
  for(const [action,expected] of [
    [{type:'read',path:'/project/src/a.ts'},'Read file'],
    [{type:'listFiles',path:'/project/src'},'List files'],
    [{type:'search',path:'/project/src'},'Search'],
    [{type:'unknown',command:'private'},'Command'],
  ] as const){
    const mapped=mapWorkspaceItem({...command,id:`action-${expected}`,commandActions:[action]},'turn',binding,'now');
    if(mapped?.kind==='tool')assert.equal(mapped.name,expected);
    else assert.fail('expected tool');
  }
  const detail=mapWorkspaceItem(command,'turn',binding,'now',undefined,true);if(detail?.kind==='tool')assert.equal(detail.detail?.output,'SECRET');
  const secretPath=mapWorkspaceItem({...command,id:'secret-path',commandActions:[{type:'read',path:'/project/.env',command:'cat /project/.env'}]},'turn',binding,'now');
  assert.equal(JSON.stringify(secretPath).includes('.env'),false);
  const mcp=mapWorkspaceItem({id:'m',type:'mcpToolCall',server:'files',tool:'read',arguments:{secret:'SECRET'},result:{content:[{text:'SECRET'}]},status:'failed'},'turn',binding,'now');
  if(mcp?.kind==='tool'){assert.equal(mcp.name,'files/read');assert.equal(JSON.stringify(mcp).includes('SECRET'),false);}
  const dynamic=mapWorkspaceItem({id:'d',type:'dynamicToolCall',namespace:'app',tool:'fetch',success:false,status:'completed'},'turn',binding,'now');
  assert.equal(dynamic?.kind,'tool');
});

test('original detail is advertised only when native tool evidence exists',()=>{
  for(const type of ['webSearch','collabAgentToolCall','functionCallOutput']){
    const item={id:type,type,query:'private query',output:'private result',status:'completed'};
    for(const requested of [false,true]){
      const mapped=mapWorkspaceItem(item,'turn',binding,'now',undefined,requested);
      if(mapped?.kind!=='tool')assert.fail(`expected ${type} tool`);
      assert.equal(mapped.detailAvailable,false);
      assert.match(mapped.detailReason??'',/unsupported/);
      assert.equal('detail' in mapped,false);
      assert.equal(JSON.stringify(mapped).includes('private'),false);
    }
  }
  for(const item of [
    {id:'command',type:'commandExecution',command:'private command'},
    {id:'mcp',type:'mcpToolCall',error:'private error'},
    {id:'dynamic',type:'dynamicToolCall',contentItems:[{text:'private result'}]},
    {id:'change',type:'fileChange',changes:[{path:'/project/src/file.ts',diff:'private diff'}]},
  ]){
    const summary=mapWorkspaceItem(item,'turn',binding,'now');
    const selected=mapWorkspaceItem(item,'turn',binding,'now',undefined,true);
    if(summary?.kind!=='tool'||selected?.kind!=='tool')assert.fail(`expected ${item.type} tool`);
    assert.equal(summary.detailAvailable,true);
    assert.equal(summary.detailReason,null);
    assert.equal('detail' in summary,false);
    assert.equal(JSON.stringify(summary).includes('private'),false);
    assert.equal(selected.detailAvailable,true);
    assert.equal(JSON.stringify(selected.detail).includes('private'),true);
  }
  for(const item of [
    {id:'empty-command',type:'commandExecution',status:'completed'},
    {id:'empty-dynamic',type:'dynamicToolCall',contentItems:[]},
    {id:'empty-change',type:'fileChange',changes:[]},
  ]){
    const mapped=mapWorkspaceItem(item,'turn',binding,'now',undefined,true);
    if(mapped?.kind!=='tool')assert.fail(`expected ${item.type} tool`);
    assert.equal(mapped.detailAvailable,false);
    assert.match(mapped.detailReason??'',/did not provide/);
    assert.equal('detail' in mapped,false);
  }
});

test('live mapping uses same stable item identity and only public text deltas',()=>{
  const item=msg('a','commentary');const start=mapWorkspaceEvent('item/started',{threadId:'thread',turnId:'turn',item,startedAtMs:1700000000000},binding,'now');
  const done=mapWorkspaceEvent('item/completed',{threadId:'thread',turnId:'turn',item,completedAtMs:1700000001000},binding,'later');
  assert.equal(start?.kind,'entry');assert.equal(done?.kind,'entry');if(start?.kind==='entry'&&done?.kind==='entry')assert.equal(start.entry.id,done.entry.id);
  if(start?.kind==='entry')assert.equal(start.entry.state,'running');
  if(done?.kind==='entry')assert.equal(done.entry.state,'completed');
  const planStart=mapWorkspaceEvent('item/started',{threadId:'thread',turnId:'turn',item:{id:'plan',type:'plan',text:''}},binding,'now');
  const planDone=mapWorkspaceEvent('item/completed',{threadId:'thread',turnId:'turn',item:{id:'plan',type:'plan',text:'done'}},binding,'later');
  if(planStart?.kind==='entry'&&planDone?.kind==='entry'){
    assert.equal(planStart.entry.state,'running');assert.equal(planDone.entry.state,'completed');
    assert.equal(planStart.entry.id,planDone.entry.id);
  }else assert.fail('expected plan lifecycle');
  const planUpdate=mapWorkspaceEvent('turn/plan/updated',{threadId:'thread',turnId:'turn',explanation:'Next steps',
    plan:[{step:'Read docs',status:'completed'},{step:'Test',status:'inProgress'}]},binding,'now','connection-1');
  if(planUpdate?.kind==='entry'&&planUpdate.entry.kind==='plan'){
    assert.equal(planUpdate.entry.id,'plan:thread:turn');assert.equal(planUpdate.entry.nativeItemId,null);
    assert.match(planUpdate.entry.body,/Next steps/);assert.match(planUpdate.entry.body,/Test/);
    assert.deepEqual(planUpdate.entry.order,{kind:'live-item',key:'plan:thread:turn',position:null,generation:'connection-1'});
  }else assert.fail('expected public plan update');
  assert.equal(mapWorkspaceEvent('turn/reasoning/updated',{threadId:'thread',turnId:'turn',content:'private'},binding,'now'),null);
  assert.equal(mapWorkspaceEvent('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'a',delta:'hello'},binding,'now')?.kind,'text-delta');
  const largeDelta=mapWorkspaceEvent('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'a',delta:'x'.repeat(8191)+'😀tail'},binding,'now');
  if(largeDelta?.kind==='text-delta'){
    assert.equal(largeDelta.delta,'x'.repeat(8191));assert.equal(largeDelta.truncated,true);
    assert.equal(largeDelta.delta.includes('�'),false);
  }else assert.fail('expected public delta');
  assert.equal(mapWorkspaceEvent('item/commandExecution/outputDelta',{threadId:'thread',turnId:'turn',itemId:'c',delta:'SECRET'},binding,'now'),null);
  assert.equal(mapWorkspaceEvent('item/agentMessage/delta',{threadId:'foreign',turnId:'turn',itemId:'a',delta:'secret'},binding,'now'),null);
  for(const status of ['active','idle'])
    assert.equal(mapWorkspaceEvent('thread/status/changed',{threadId:'thread',status},binding,'now'),null);
  assert.equal(mapWorkspaceEvent('turn/completed',{threadId:'thread',turn:{id:'turn',status:'failed',completedAt:1700000001}},binding,'now')?.kind,'turn');
  const completedTurn=mapWorkspaceEvent('turn/completed',{threadId:'thread',turn:{id:'turn',status:'failed'}},binding,'now','connection-1');
  if(completedTurn?.kind==='turn')assert.deepEqual(completedTurn.turn.order,{kind:'turn-boundary',key:'boundary:thread:turn:complete',position:null,generation:'connection-1'});
});

test('UTF-8 previews stop at a complete code point and mark truncation',()=>{
  const item=mapWorkspaceItem({id:'utf8',type:'agentMessage',text:'x'.repeat(4095)+'😀tail'},'turn',binding,'now');
  if(item?.kind==='message'){
    assert.equal(item.body,'x'.repeat(4095));assert.equal(item.truncated,true);
    assert.equal(item.body.includes('�'),false);
  }else assert.fail('expected assistant message');
});

test('adapter reads on registered owner connection without resuming or starting a new Turn',async t=>{
  const {CodexAppServerAdapter}=await import('../src/index.js');
  const {resolve}=await import('node:path');
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[resolve(import.meta.dirname,'fixture.mjs'),'workspace-history'],expectedVersion:'codex-cli 0.166.0-alpha.5.1',requestTimeoutMs:2000});
  t.after(()=>adapter.close());await adapter.open();
  const owned=await adapter.create({sessionId:'session',roleId:'role',projectId:'project',cwd:'/tmp/evoloop-fixture',authorizationScope:'scope',sandbox:'danger-full-access',approvalPolicy:'never'});
  const before=await adapter.inspect(owned) as {observedTurnStarts:number;observedResumes:number};
  const updates:unknown[]=[];adapter.onWorkspaceUpdate(update=>updates.push(update));
  const statusEvents:string[]=[];adapter.onEvent(event=>{if(event.method==='thread/status/changed')statusEvents.push(String((event.params as {status?:string}).status));});
  const page=await adapter.readWorkspaceHistory(owned);
  const after=await adapter.inspect(owned) as {observedTurnStarts:number;observedResumes:number};
  assert.deepEqual([after.observedTurnStarts,after.observedResumes],[before.observedTurnStarts,before.observedResumes]);
  assert.equal(page.entries.length,2);assert.equal(page.entries[0]?.kind,'message');
  const input=page.entries.find(e=>e.nativeItemId==='input-1');if(input?.kind==='message'){assert.equal(input.body,'');assert.equal(input.clientId,'client-1');}
  assert.ok(updates.some(x=>(x as {kind:string}).kind==='text-delta'));
  assert.deepEqual(statusEvents,['active','idle']);
  assert.equal(updates.some(x=>(x as {kind:string}).kind==='reset'),false);
  const publicUpdates=updates.filter((x):x is {kind:string;entry?:{id:string;state:string};itemId?:string}=>!!x&&typeof x==='object');
  const started=publicUpdates.find(x=>x.kind==='entry'&&x.entry?.state==='running');
  const completed=publicUpdates.find(x=>x.kind==='entry'&&x.entry?.state==='completed');
  assert.equal(started?.entry?.id,completed?.entry?.id);
  assert.equal(publicUpdates.find(x=>x.kind==='text-delta')?.itemId,'message-1');
  assert.equal(JSON.stringify(updates).includes('private output'),false);
  await assert.rejects(()=>adapter.readWorkspaceHistory({...owned,sessionId:'foreign'}),/not registered/);
});

test('public item selection returns long assistant body without tool detail permission',async()=>{
  const long='public '.repeat(1200);
  const reader=fake((method)=>method==='thread/read'?meta():method==='thread/items/list'?{
    data:[wrap('turn', {id:'assistant',type:'agentMessage',phase:'final_answer',text:long})],nextCursor:null}:assert.fail(method));
  const selected=await reader.read(binding,{turnId:'turn',itemId:'assistant'});
  const entry=selected.entries[0];assert.equal(entry?.kind,'message');if(entry?.kind==='message'){assert.equal(entry.body,long);assert.equal(entry.truncated,false);}
  const toolReader=fake((method)=>method==='thread/read'?meta():method==='thread/items/list'?{
    data:[wrap('turn',{id:'tool',type:'commandExecution',command:'secret',aggregatedOutput:'private',commandActions:[],status:'completed'})],nextCursor:null}:assert.fail(method));
  const tool=await toolReader.read(binding,{turnId:'turn',itemId:'tool'});
  assert.equal(JSON.stringify(tool).includes('private'),false);
  const authorized=await toolReader.read(binding,{turnId:'turn',itemId:'tool',detail:true});
  assert.equal(JSON.stringify(authorized).includes('private'),true);
});

test('experimental selective read checks requested item and keeps native times',async()=>{
  const seen:string[]=[];
  const reader=fake((method,p)=>{seen.push(method);if(method==='thread/read')return meta();
    if(method==='thread/items/read'){assert.deepEqual(p.itemIds,['answer']);return {data:[wrap('turn',{id:'answer',type:'agentMessage',text:'complete',phase:null},1700000000123)]};}
    assert.fail(method);},true);
  const page=await reader.read(binding,{turnId:'turn',itemId:'answer'});
  assert.deepEqual(seen,['thread/read','thread/items/read']);
  assert.equal(page.entries[0]?.occurredAt,'2023-11-14T22:13:20.123Z');
  assert.equal(page.entries[0]?.kind,'message');if(page.entries[0]?.kind==='message')assert.equal(page.entries[0].phase,'unknown');
  const wrong=fake(method=>method==='thread/read'?meta():{data:[wrap('turn',{id:'wrong',type:'agentMessage',text:'wrong'})]},true);
  await assert.rejects(()=>wrong.read(binding,{turnId:'turn',itemId:'answer'}),/wrong identity/);
});

test('unknown kind remains visible and missing timestamps remain null',async()=>{
  const reader=fake(method=>method==='thread/read'?meta():method==='thread/items/list'?{
    data:[wrap('turn',{id:'new',type:'futureKind',secret:'SECRET'})],nextCursor:null}:method==='thread/turns/list'?{
    data:[{id:'turn',status:'newStatus',items:[]}],nextCursor:null}:assert.fail(method));
  const page=await reader.read(binding);
  assert.deepEqual(page.unsupportedKinds,['futureKind']);assert.equal(page.partial,true);
  assert.equal(page.itemEnumerationComplete,false);
  assert.equal(page.entries[0]?.occurredAt,null);assert.equal(page.turns[0]?.state,'unknown');
  assert.equal(JSON.stringify(page).includes('SECRET'),false);
});

test('source omissions and a bounded selective scan never claim complete Item enumeration',async()=>{
  const realtime=fake(method=>method==='thread/read'?meta():method==='thread/timeline/list'?{
    data:[{type:'realtime',position:1}],nextCursor:null}:assert.fail(method),true);
  const timeline=await realtime.read(binding);
  assert.equal(timeline.nextCursor,null);
  assert.equal(timeline.itemEnumerationComplete,false);
  assert.equal(timeline.partial,true);
  assert.deepEqual(timeline.unsupportedKinds,['realtime']);
  let scans=0;
  const selected=fake((method,p)=>{
    if(method==='thread/read')return meta();
    if(method==='thread/items/list'){
      scans++;
      assert.equal(p.limit,100);
      return {data:[wrap('turn',msg(`other-${scans}`))],nextCursor:String(scans)};
    }
    assert.fail(method);
  });
  const absent=await selected.read(binding,{turnId:'turn',itemId:'missing'});
  assert.equal(scans,10);
  assert.equal(absent.itemEnumerationComplete,false);
  assert.equal(absent.partial,true);
  assert.equal(absent.nextCursor,null);
  assert.deepEqual(absent.limitations,['selected item beyond bounded scan']);
});

test('repeating native cursor and empty continuation are rejected',async()=>{
  const repeated=fake((method,p)=>method==='thread/read'?meta():method==='thread/items/list'?{
    data:[wrap('turn',msg('a'))],nextCursor:p.cursor??'again'}:method==='thread/turns/list'?{
    data:[{id:'turn',status:'completed',items:[]}],nextCursor:null}:assert.fail(method));
  const first=await repeated.read(binding);
  await assert.rejects(()=>repeated.read(binding,{cursor:first.nextCursor!}),/invalid items page/);
  const empty=fake(method=>method==='thread/read'?meta():{data:[],nextCursor:'again'});
  await assert.rejects(()=>empty.read(binding),/invalid items page/);
});

test('dynamic experimental negotiation alone keeps workspace on standard Items',async t=>{
  const {CodexAppServerAdapter}=await import('../src/index.js');
  const {resolve}=await import('node:path');
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[resolve(import.meta.dirname,'fixture.mjs'),'workspace-history'],
    expectedVersion:'codex-cli 0.166.0-alpha.5.1',requestTimeoutMs:2000});
  adapter.onNativeInput(()=>{}); // Negotiates experimentalApi for input, not workspace history.
  t.after(()=>adapter.close());await adapter.open();
  const owned=await adapter.create({sessionId:'session',roleId:'role',projectId:'project',cwd:'/tmp/evoloop-fixture',authorizationScope:'scope',sandbox:'danger-full-access',approvalPolicy:'never'});
  assert.equal((await adapter.readWorkspaceHistory(owned)).method,'items');
});

for(const expectedVersion of ['codex-cli 0.166.0-alpha.5.1','codex-cli 0.166.0-alpha.6'] as const)
test(`${expectedVersion} explicit workspace opt-in negotiates experimental timeline on its owner connection`,async t=>{
  const {CodexAppServerAdapter,RuntimeProtocolError}=await import('../src/index.js');
  const {resolve}=await import('node:path');
  assert.throws(()=>new CodexAppServerAdapter({workspaceExperimental:true,expectedVersion:'codex-cli 0.164.0-alpha.11.1'}),RuntimeProtocolError);
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[resolve(import.meta.dirname,'fixture.mjs'),'workspace-timeline'],
    expectedVersion,workspaceExperimental:true,requestTimeoutMs:2000});
  t.after(()=>adapter.close());await adapter.open();
  const owned=await adapter.create({sessionId:'session',roleId:'role',projectId:'project',cwd:'/tmp/evoloop-fixture',authorizationScope:'scope',sandbox:'danger-full-access',approvalPolicy:'never'});
  const page=await adapter.readWorkspaceHistory(owned);
  assert.equal(page.method,'timeline');
  assert.equal(page.entries[0]?.order?.position,1);
  const notice=page.entries.find(entry=>entry.kind==='notice');
  assert.equal(notice?.id,'boundary:thread-owned:turn-1:complete');
  assert.equal(notice?.nativeItemId,null);
  assert.equal(notice?.order?.position,2);
  assert.equal(page.turns.at(-1)?.state,'failed');
});

test('reasoning Items show their summary, else readable native text, else an explicit unreadable entry',()=>{
  const summary=mapWorkspaceItem({id:'r1',type:'reasoning',summary:['**Plan** read files','then edit'],content:['raw chain']},'turn',binding,'now');
  assert.ok(summary?.kind==='reasoning');
  assert.deepEqual([summary.source,summary.readable,summary.body,summary.unavailableReason],['summary',true,'**Plan** read files\n\nthen edit',null]);
  assert.equal(JSON.stringify(summary).includes('raw chain'),false,'a summary is preferred over raw reasoning');
  const raw=mapWorkspaceItem({id:'r2',type:'reasoning',summary:[],content:['DeepSeek reasoning text']},'turn',binding,'now');
  assert.ok(raw?.kind==='reasoning');assert.deepEqual([raw.source,raw.readable,raw.body],['raw',true,'DeepSeek reasoning text']);
  for(const item of [{id:'r3',type:'reasoning'},{id:'r4',type:'reasoning',summary:['  '],content:[]}]){
    const hidden=mapWorkspaceItem(item,'turn',binding,'now');
    assert.ok(hidden?.kind==='reasoning');
    assert.deepEqual([hidden.source,hidden.readable,hidden.body],['none',false,'']);
    assert.match(hidden.unavailableReason??'',/没有可读的推理内容/);
  }
  const long=mapWorkspaceItem({id:'r5',type:'reasoning',summary:['x'.repeat(20000)]},'turn',binding,'now');
  assert.ok(long?.kind==='reasoning'&&long.truncated&&long.body.length===16000);
  const started=mapWorkspaceEvent('item/started',{threadId:binding.nativeThreadId,turnId:'turn',item:{id:'r6',type:'reasoning',summary:[],content:[]}},binding,'now');
  assert.ok(started?.kind==='entry'&&started.entry.kind==='reasoning');
  assert.equal(started.entry.state,'running');assert.equal(started.entry.unavailableReason,null,'a running Item is not yet unreadable');
  const completed=mapWorkspaceEvent('item/completed',{threadId:binding.nativeThreadId,turnId:'turn',item:{id:'r6',type:'reasoning',summary:['done'],content:[]}},binding,'now');
  assert.ok(completed?.kind==='entry'&&completed.entry.kind==='reasoning'&&completed.entry.body==='done'&&completed.entry.state==='completed');
});
