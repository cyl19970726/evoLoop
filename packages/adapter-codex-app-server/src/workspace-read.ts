import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeBinding } from '@evoloop/contracts/runtime';
import type { NativeWorkspacePage, NativeWorkspaceReadOptions, WorkspaceEntry, WorkspaceTurn } from '@evoloop/contracts/session-timeline';
import { mapWorkspaceItem, mapWorkspaceTurn } from './workspace-map.js';

type Rpc=(method:string,params:unknown)=>Promise<unknown>;
const obj=(v:unknown):Record<string,any>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:null;
const str=(v:unknown):string|null=>typeof v==='string'&&v.length>0?v:null;
const TURN_METADATA_PAGE_SIZE=100;
const EXACT_TURN_METADATA_MAX_PAGES=10;
type Cursor={v:1;scope:string;mode:'timeline'|'items'|'legacy';native:string|null;offset?:number};
export class WorkspaceHistoryReader{
  private readonly salt=randomUUID();
  constructor(private readonly rpc:Rpc,private readonly experimental:()=>boolean){}
  private scope(binding:RuntimeBinding,mode:string,options:NativeWorkspaceReadOptions):string{
    return createHash('sha256').update(JSON.stringify([this.salt,binding.projectId,binding.sessionId,binding.nativeThreadId,binding.nativeSessionId,binding.authorizationScope,mode,options.turnId??null,options.itemId??null,options.detail===true])).digest('hex');
  }
  private decode(value:string|undefined,binding:RuntimeBinding,options:NativeWorkspaceReadOptions):Cursor|null{
    if(!value)return null;
    if(value.length>16384)throw new Error('workspace history: invalid cursor');
    let c:Record<string,unknown>|null=null;
    try{c=obj(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));}catch{throw new Error('workspace history: invalid cursor');}
    if(!c||c.v!==1||!['timeline','items','legacy'].includes(String(c.mode))||c.scope!==this.scope(binding,String(c.mode),options)||
      c.native!==null&&typeof c.native!=='string'||c.offset!=null&&(!Number.isSafeInteger(c.offset)||Number(c.offset)<0))throw new Error('workspace history: invalid cursor');
    return c as Cursor;
  }
  private encode(binding:RuntimeBinding,options:NativeWorkspaceReadOptions,c:Omit<Cursor,'v'|'scope'>):string{
    return Buffer.from(JSON.stringify({v:1,scope:this.scope(binding,c.mode,options),...c})).toString('base64url');
  }
  private page(data:WorkspaceEntry[],turns:WorkspaceTurn[],nextCursor:string|null,observedAt:string,historyMode:NativeWorkspacePage['historyMode'],method:NativeWorkspacePage['method'],limitations:string[]=[],enumerationAvailable=limitations.length===0):NativeWorkspacePage{
    const unsupportedKinds=[...new Set(data.filter(e=>e.kind==='notice'&&e.label==='Unsupported native item').map(e=>e.nativeKind!).filter(Boolean))];
    return {entries:data,turns,nextCursor,observedAt,historyMode,method,
      itemEnumerationComplete:!nextCursor&&enumerationAvailable&&unsupportedKinds.length===0,
      partial:!!nextCursor||limitations.length>0||unsupportedKinds.length>0||data.some(e=>e.truncated),limitations,unsupportedKinds};
  }
  private entries(raw:unknown[],binding:RuntimeBinding,observedAt:string,expectedTurn?:string,detail=false,fullPublic=false):WorkspaceEntry[]{
    const mapped:WorkspaceEntry[]=[];
    for(const value of raw){
      const wrapper=obj(value),item=obj(wrapper?.item),turnId=str(wrapper?.turnId);
      if(!wrapper||!item||!str(item.id)||!str(item.type)||!turnId||expectedTurn&&turnId!==expectedTurn)throw new Error('workspace history: invalid item entry');
      const entry=mapWorkspaceItem(item,turnId,binding,observedAt,wrapper.startedAtMs??wrapper.completedAtMs,detail||fullPublic&&item.type==='agentMessage');
      if(entry)mapped.push(entry);
    }
    return mapped;
  }
  async read(binding:RuntimeBinding,options:NativeWorkspaceReadOptions={}):Promise<NativeWorkspacePage>{
    const limit=options.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('workspace history: limit must be 1–50');
    if(options.turnId!==undefined&&!str(options.turnId)||options.itemId!==undefined&&!str(options.itemId)||options.itemId&&!options.turnId)throw new Error('workspace history: invalid item selection');
    const cursor=this.decode(options.cursor,binding,options);
    const observedAt=new Date().toISOString();
    const meta=obj(await this.rpc('thread/read',{threadId:binding.nativeThreadId,includeTurns:false}));
    const thread=obj(meta?.thread);
    if(!thread||thread.id!==binding.nativeThreadId||thread.sessionId!==binding.nativeSessionId||thread.cwd!==binding.cwd)throw new Error('workspace history: thread does not match binding');
    const historyMode=thread.historyMode==='legacy'||thread.historyMode==='paginated'?thread.historyMode:'unknown';
    if(cursor?.mode==='timeline'&&(!this.experimental()||historyMode!=='paginated'))throw new Error('workspace history: cursor mode unavailable');
    if(options.itemId)return this.selected(binding,options,observedAt,historyMode);
    if(cursor?.mode==='legacy')return this.legacy(binding,options,cursor,observedAt,historyMode,limit);
    if(cursor?.mode==='timeline')return this.timeline(binding,options,cursor,observedAt,historyMode,limit);
    if(this.experimental()&&historyMode==='paginated'&&!options.turnId&&!cursor){
      try{return await this.timeline(binding,options,null,observedAt,historyMode,limit);}catch(error){
        // Only an unsupported method/store can fall back. Invalid cursors, permission and storage errors propagate.
        if(!obj(error)||obj(error)?.code!==-32601)throw error;
      }
    }
    return this.items(binding,options,cursor,observedAt,historyMode,limit);
  }
  private async timeline(binding:RuntimeBinding,options:NativeWorkspaceReadOptions,cursor:Cursor|null,observedAt:string,historyMode:NativeWorkspacePage['historyMode'],limit:number):Promise<NativeWorkspacePage>{
    const result=obj(await this.rpc('thread/timeline/list',{threadId:binding.nativeThreadId,limit,cursor:cursor?.native??null}));
    if(!result||!Array.isArray(result.data)||result.data.length>limit||result.nextCursor!==null&&!str(result.nextCursor)||
      result.nextCursor!=null&&(result.nextCursor===cursor?.native||result.data.length===0))throw new Error('workspace history: invalid timeline page');
    const entries:WorkspaceEntry[]=[],turns:WorkspaceTurn[]=[];
    let previousPosition=-1;
    for(const value of result.data){
      const row=obj(value);if(!row||!Number.isSafeInteger(row.position)||Number(row.position)<0)throw new Error('workspace history: invalid timeline entry');
      // Several boundary and item rows can share a rollout ordinal.
      if(row.position<previousPosition)throw new Error('workspace history: invalid timeline position');
      previousPosition=row.position;
      if(row.type==='item'){
        if(!str(row.turnId)||!obj(row.item)||!str(obj(row.item)?.id)||!str(obj(row.item)?.type))throw new Error('workspace history: invalid timeline item');
        const entry=mapWorkspaceItem(row.item,row.turnId as string,binding,observedAt);
        if(entry){entry.order={kind:'timeline-position',key:entry.id,position:row.position,generation:null};entries.push(entry);}
      }else if(row.type==='turnStarted'||row.type==='turnCompleted'){
        if(row.turn_id!=null&&row.turnId!=null&&row.turn_id!==row.turnId||
          row.started_at!=null&&row.startedAt!=null&&row.started_at!==row.startedAt||
          row.completed_at!=null&&row.completedAt!=null&&row.completed_at!==row.completedAt)
          throw new Error('workspace history: conflicting timeline field aliases');
        const id=str(row.turn_id)??str(row.turnId);if(!id)throw new Error('workspace history: invalid timeline turn boundary');
        const started=row.started_at??row.startedAt,completed=row.completed_at??row.completedAt;
        if(started!=null&&!Number.isSafeInteger(started)||completed!=null&&!Number.isSafeInteger(completed))throw new Error('workspace history: invalid timeline time');
        // A persisted start boundary does not prove the Turn is live on this connection.
        const turn=mapWorkspaceTurn({id,status:row.type==='turnStarted'?'unknown':row.status,startedAt:started,completedAt:completed});if(!turn)throw new Error('workspace history: invalid timeline turn');
        const boundary=`boundary:${binding.nativeThreadId}:${id}:${row.type==='turnStarted'?'start':'complete'}`;
        turn.order={kind:'turn-boundary',key:boundary,position:row.position,generation:null};
        turns.push(turn);
        if(row.type==='turnCompleted'&&(turn.state==='failed'||turn.state==='interrupted')){
          entries.push({id:boundary,turnId:id,nativeItemId:null,nativeKind:'turnCompleted',author:{kind:'system',id:null,label:'Turn'},origin:null,
            occurredAt:turn.completedAt,observedAt,freshness:'persisted',truncated:false,order:turn.order,
            kind:'notice',label:turn.state==='failed'?'Turn failed':'Turn interrupted',body:'',state:turn.state});
        }
      }else if(row.type==='realtime'){
        // Realtime payload has no owning Turn in this wire contract; preserve a limitation, not a fabricated association.
      }else throw new Error('workspace history: invalid timeline entry kind');
    }
    const next=str(result.nextCursor),hasRealtime=result.data.some(x=>obj(x)?.type==='realtime');
    const page=this.page(entries,turns,next?this.encode(binding,options,{mode:'timeline',native:next}):null,observedAt,historyMode,'timeline',
      hasRealtime?['realtime timeline entries have no turn association']:[]);
    if(hasRealtime)page.unsupportedKinds.push('realtime');
    return page;
  }
  private async items(binding:RuntimeBinding,options:NativeWorkspaceReadOptions,cursor:Cursor|null,observedAt:string,historyMode:NativeWorkspacePage['historyMode'],limit:number):Promise<NativeWorkspacePage>{
    // Cross-thread item pagination is canonical source order and retains turnId on each wrapper.
    const result:Record<string,unknown>|null=await this.rpc('thread/items/list',{threadId:binding.nativeThreadId,turnId:options.turnId??null,sortDirection:'desc',limit,cursor:cursor?.native??null}).then(obj).catch(error=>{
      if(obj(error)?.code===-32601&&historyMode==='legacy'&&!options.turnId)return null;
      throw error;
    });
    if(result===null)return this.legacy(binding,options,null,observedAt,historyMode,limit);
    if(!Array.isArray(result.data)||result.data.length>limit||result.nextCursor!==null&&!str(result.nextCursor)||
      result.nextCursor!=null&&(result.nextCursor===cursor?.native||result.data.length===0))throw new Error('workspace history: invalid items page');
    const entries=this.entries(result.data,binding,observedAt,options.turnId).reverse();
    const ids=options.turnId?[options.turnId]:[...new Set(result.data.map(x=>str(obj(x)?.turnId)).filter((x):x is string=>!!x))];
    const {turns,limitations}=await this.turnMetadata(binding,ids,!!options.turnId);
    const next=str(result.nextCursor);
    // Missing Turn metadata does not imply missing Items; callers must still verify the Turn's terminal state.
    return this.page(entries,turns,next?this.encode(binding,options,{mode:'items',native:next}):null,observedAt,historyMode,'items',limitations,true);
  }
  private async turnMetadata(binding:RuntimeBinding,ids:string[],exact:boolean):Promise<{turns:WorkspaceTurn[];limitations:string[]}>{
    const missing=new Set(ids),turns:WorkspaceTurn[]=[];
    if(!missing.size)return {turns,limitations:[]};
    // Exact Turn reads may inspect at most 10 × 100 metadata records. Ordinary Thread pages stay at one page.
    const maxPages=exact?EXACT_TURN_METADATA_MAX_PAGES:1;
    let cursor:string|null=null;
    const seen=new Set<string>();
    for(let page=0;page<maxPages;page++){
      const metadata=obj(await this.rpc('thread/turns/list',{threadId:binding.nativeThreadId,limit:TURN_METADATA_PAGE_SIZE,
        sortDirection:'desc',itemsView:'notLoaded',cursor}));
      if(!metadata||!Array.isArray(metadata.data)||metadata.data.length>TURN_METADATA_PAGE_SIZE||
        metadata.nextCursor!==null&&!str(metadata.nextCursor))throw new Error('workspace history: invalid turns metadata');
      const next=str(metadata.nextCursor);
      if(next&&(next===cursor||seen.has(next)||metadata.data.length===0))throw new Error('workspace history: invalid turns metadata cursor');
      const parsed:WorkspaceTurn[]=metadata.data.map((value:unknown)=>{
        const turn=mapWorkspaceTurn(value);if(!turn)throw new Error('workspace history: invalid turns metadata');
        return turn;
      });
      if(new Set(parsed.map(turn=>turn.id)).size!==parsed.length)throw new Error('workspace history: invalid turns metadata');
      for(const turn of parsed)if(missing.delete(turn.id)){
        turn.order={kind:'turn-boundary',key:`boundary:${binding.nativeThreadId}:${turn.id}:metadata`,position:null,generation:null};
        turns.push(turn);
      }
      if(!missing.size)return {turns,limitations:[]};
      if(!next)return {turns,limitations:['turn metadata unavailable for requested items']};
      seen.add(next);cursor=next;
    }
    return {turns,limitations:[exact?
      `turn metadata outside bounded scan (${EXACT_TURN_METADATA_MAX_PAGES} pages, ${TURN_METADATA_PAGE_SIZE} turns each)`:
      `turn metadata outside bounded page (${TURN_METADATA_PAGE_SIZE} turns)`]};
  }
  private async legacy(binding:RuntimeBinding,options:NativeWorkspaceReadOptions,cursor:Cursor|null,observedAt:string,historyMode:NativeWorkspacePage['historyMode'],limit:number):Promise<NativeWorkspacePage>{
    if(historyMode!=='legacy')throw new Error('workspace history: full-turn fallback requires legacy history');
    const result=obj(await this.rpc('thread/turns/list',{threadId:binding.nativeThreadId,limit:1,sortDirection:'desc',itemsView:'full',cursor:cursor?.native??null}));
    if(!result||!Array.isArray(result.data)||result.data.length>1||result.nextCursor!==null&&!str(result.nextCursor)||
      result.nextCursor!=null&&(result.nextCursor===cursor?.native||result.data.length===0))throw new Error('workspace history: invalid legacy page');
    const turn=obj(result.data[0]);if(!turn){if(result.nextCursor)throw new Error('workspace history: empty legacy page with continuation');return this.page([],[],null,observedAt,historyMode,'turns-full');}
    if(turn.itemsView!=='full'||!Array.isArray(turn.items)||!str(turn.id))throw new Error('workspace history: legacy full items unavailable');
    const offset=cursor?.offset??0;if(offset>turn.items.length)throw new Error('workspace history: invalid legacy offset');
    const items=turn.items.slice(Math.max(0,turn.items.length-offset-limit),turn.items.length-offset).map(item=>({turnId:turn.id,item}));
    // Full Turn items are already in canonical ascending order. Pages walk backward,
    // but entries within each page retain their original order.
    const entries=this.entries(items,binding,observedAt,turn.id as string);
    const nextOffset=offset+items.length;const next=nextOffset<turn.items.length?
      this.encode(binding,options,{mode:'legacy',native:cursor?.native??null,offset:nextOffset}):
      str(result.nextCursor)?this.encode(binding,options,{mode:'legacy',native:str(result.nextCursor),offset:0}):null;
    const mapped=mapWorkspaceTurn(turn);
    if(mapped)mapped.order={kind:'turn-boundary',key:`boundary:${binding.nativeThreadId}:${mapped.id}:metadata`,position:null,generation:null};
    return this.page(entries,mapped?[mapped]:[],next,observedAt,historyMode,'turns-full');
  }
  private async selected(binding:RuntimeBinding,options:NativeWorkspaceReadOptions,observedAt:string,historyMode:NativeWorkspacePage['historyMode']):Promise<NativeWorkspacePage>{
    if(options.cursor)throw new Error('workspace history: selection has no cursor');
    if(this.experimental()&&historyMode==='paginated'){
      try{const result=obj(await this.rpc('thread/items/read',{threadId:binding.nativeThreadId,turnId:options.turnId,itemIds:[options.itemId]}));
        if(!result||!Array.isArray(result.data)||result.data.length>1)throw new Error('workspace history: invalid item read');
        const entries=this.entries(result.data,binding,observedAt,options.turnId,options.detail===true,true);
        if(entries.some(x=>x.nativeItemId!==options.itemId))throw new Error('workspace history: item read returned wrong identity');
        this.checkSelectedBytes(entries);
        return this.page(entries,[],null,observedAt,historyMode,'items',entries.length?[]:['selected item unavailable']);
      }catch(error){if(obj(error)?.code!==-32601)throw error;}
    }
    // Standard protocol has no selective read. A bounded scan preserves scope and reports an incomplete selection.
    let cursor:string|null=null;let scanned=0;
    do{let result:Record<string,any>|null;
      try{result=obj(await this.rpc('thread/items/list',{threadId:binding.nativeThreadId,turnId:options.turnId,sortDirection:'desc',limit:100,cursor}));}
      catch(error){if(obj(error)?.code===-32601&&historyMode==='legacy')return this.legacySelected(binding,options,observedAt);throw error;}
      if(!result||!Array.isArray(result.data)||result.data.length>100||result.nextCursor!==null&&!str(result.nextCursor))throw new Error('workspace history: invalid item selection page');
      const found=result.data.filter(x=>obj(obj(x)?.item)?.id===options.itemId);
      if(found.length){const entries=this.entries(found,binding,observedAt,options.turnId,options.detail===true,true);this.checkSelectedBytes(entries);return this.page(entries,[],null,observedAt,historyMode,'items');}
      const next=str(result.nextCursor);if(next&&(next===cursor||result.data.length===0))throw new Error('workspace history: invalid item selection cursor');
      cursor=next;scanned++;
    }while(cursor&&scanned<10);
    return this.page([],[],null,observedAt,historyMode,'items',[cursor?'selected item beyond bounded scan':'selected item unavailable']);
  }
  private checkSelectedBytes(entries:WorkspaceEntry[]):void{
    if(Buffer.byteLength(JSON.stringify(entries),'utf8')>1_000_000)throw new Error('workspace history: selected item exceeds byte limit');
  }
  private async legacySelected(binding:RuntimeBinding,options:NativeWorkspaceReadOptions,observedAt:string):Promise<NativeWorkspacePage>{
    let cursor:string|null=null;
    for(let scanned=0;scanned<25;scanned++){
      const result=obj(await this.rpc('thread/turns/list',{threadId:binding.nativeThreadId,limit:1,sortDirection:'desc',itemsView:'full',cursor}));
      if(!result||!Array.isArray(result.data)||result.data.length>1||result.nextCursor!==null&&!str(result.nextCursor))throw new Error('workspace history: invalid legacy selection page');
      const turn=obj(result.data[0]);if(!turn)break;
      if(turn.itemsView!=='full'||!Array.isArray(turn.items)||!str(turn.id))throw new Error('workspace history: legacy full items unavailable');
      if(turn.id===options.turnId){const item=turn.items.find((value:unknown)=>obj(value)?.id===options.itemId);
        const entries=item?this.entries([{turnId:turn.id,item}],binding,observedAt,turn.id,options.detail===true,true):[];
        this.checkSelectedBytes(entries);return this.page(entries,[],null,observedAt,'legacy','turns-full',entries.length?[]:['selected item unavailable']);}
      const next=str(result.nextCursor);if(!next)break;if(next===cursor)throw new Error('workspace history: invalid legacy selection cursor');cursor=next;
    }
    return this.page([],[],null,observedAt,'legacy','turns-full',['selected turn beyond bounded scan or unavailable']);
  }
}
