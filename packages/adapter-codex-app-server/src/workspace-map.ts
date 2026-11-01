import { relative, resolve, isAbsolute, sep } from 'node:path';
import type { WorkspaceEntry, WorkspaceState, WorkspaceTurn, WorkspaceRuntimeUpdate, WorkspaceMessage } from '@evoloop/contracts/session-timeline';
import type { RuntimeBinding } from '@evoloop/contracts/runtime';

const obj=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const str=(v:unknown):string|null=>typeof v==='string'?v:null;
const safe=(v:unknown,max=160):string|null=>{const s=str(v);return s&&s.length<=max&&/^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(s)?s:null;};
const state=(v:unknown):WorkspaceState=>({inProgress:'running',running:'running',completed:'completed',failed:'failed',interrupted:'interrupted',declined:'declined',pending:'pending'} as Record<string,WorkspaceState>)[str(v)??'']??'unknown';
const iso=(v:unknown,unit:1000|1):string|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v*unit<=8.64e15?new Date(v*unit).toISOString():null;
const clipped=(v:unknown,max:number):{value:string;truncated:boolean}=>{
  const bytes=Buffer.from(str(v)??'','utf8');
  const truncated=bytes.length>max;
  // Streaming decode holds an incomplete terminal code point instead of adding U+FFFD.
  return {value:new TextDecoder('utf-8').decode(bytes.subarray(0,max),{stream:truncated}),truncated};
};
const path=(v:unknown,cwd:string):string|null=>{
  const p=str(v);if(!p||p.includes('\0'))return null;
  const target=resolve(cwd,p);const rel=relative(cwd,target);
  if(!rel||rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel)||rel.length>200)return null;
  // Collapsed summaries use only unambiguous project paths; original paths stay in authorized detail.
  if(rel.split(sep).some(part=>/^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|.*(?:secret|token|credential|private.?key|auth.?key).*)$/i.test(part)))return null;
  return rel;
};
const author=(kind:'native'|'session',binding:RuntimeBinding)=>({kind,id:kind==='session'?binding.sessionId:null,label:kind==='session'?'Agent':'Native input'} as const);
const marker=/^\[evoloop-(run|message)-operation:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\n/;
function inputReference(value:unknown):WorkspaceMessage['inputReference']|undefined{
  if(!Array.isArray(value))return undefined;
  const first=obj(value[0]);
  if(first?.type!=='text'||typeof first.text!=='string')return undefined;
  const match=marker.exec(first.text);
  return match?{kind:'operation-marker',source:match[1] as 'run'|'message',operationId:match[2]!}:undefined;
}
const itemKey=(threadId:string,turnId:string,itemId:string)=>`native:${threadId}:${turnId}:${itemId}`;
const boundaryKey=(threadId:string,turnId:string,phase:'start'|'complete')=>`boundary:${threadId}:${turnId}:${phase}`;
const base=(item:Record<string,unknown>,turnId:string,binding:RuntimeBinding,observedAt:string,at:unknown):Pick<WorkspaceEntry,'id'|'turnId'|'nativeItemId'|'nativeKind'|'author'|'origin'|'occurredAt'|'observedAt'|'freshness'|'truncated'|'order'>=>({
  id:itemKey(binding.nativeThreadId,turnId,item.id as string),turnId,nativeItemId:item.id as string,nativeKind:item.type as string,
  author:author(item.type==='userMessage'?'native':'session',binding),origin:null,occurredAt:iso(at,1)??iso(item.startedAtMs,1)??iso(item.completedAtMs,1),observedAt,freshness:'persisted',truncated:false,
  order:{kind:'native-item',key:itemKey(binding.nativeThreadId,turnId,item.id as string),position:null,generation:null},
});
const detailText=(v:unknown):string|null=>{if(typeof v==='string')return v;const o=obj(v);if(!o)return null;if(Array.isArray(o.content))return o.content.map(x=>str(obj(x)?.text)).filter((x):x is string=>x!==null).join('\n');return null;};
const toolDetail=(item:Record<string,unknown>):{input:string|null;output:string|null;error:string|null;resources:string[]}=>{
  switch(item.type){
    case 'commandExecution':return {input:str(item.command),output:str(item.aggregatedOutput),error:null,resources:[]};
    case 'mcpToolCall':return {input:item.arguments==null?null:JSON.stringify(item.arguments),output:item.result==null?null:JSON.stringify(item.result),error:item.error==null?null:str(item.error)??JSON.stringify(item.error),resources:[]};
    case 'dynamicToolCall':return {input:item.arguments==null?null:JSON.stringify(item.arguments),output:Array.isArray(item.contentItems)&&item.contentItems.length?JSON.stringify(item.contentItems):null,error:null,resources:[]};
    case 'fileChange':return {input:Array.isArray(item.changes)&&item.changes.length?JSON.stringify(item.changes):null,output:null,error:null,resources:[]};
    default:return {input:null,output:null,error:null,resources:[]};
  }
};
export function mapWorkspaceItem(value:unknown,turnId:string,binding:RuntimeBinding,observedAt:string,at?:unknown,detail=false):WorkspaceEntry|null{
  const item=obj(value);if(!item||typeof item.id!=='string'||!item.id||typeof item.type!=='string'||!turnId)return null;
  const b=base(item,turnId,binding,observedAt,at);
  if(item.type==='reasoning'||item.type==='hookPrompt')return null;
  if(item.type==='userMessage'){
    const reference=inputReference(item.content);
    return {...b,kind:'message',role:'input',phase:'unknown',body:'',clientId:str(item.clientId),state:'completed',
      ...(reference?{inputReference:reference}:{})};
  }
  if(item.type==='agentMessage'){
    const body=clipped(item.text,detail?1_000_000:4096);
    const phase=item.phase==='commentary'||item.phase==='partial_answer'||item.phase==='final_answer'?item.phase:'unknown';
    return {...b,kind:'message',role:'assistant',phase,body:body.value,clientId:null,state:'completed',truncated:body.truncated};
  }
  if(item.type==='plan'){
    const body=clipped(item.text,4096);return {...b,kind:'plan',label:'Plan',body:body.value,state:'completed',truncated:body.truncated};
  }
  if(['commandExecution','mcpToolCall','dynamicToolCall','fileChange','webSearch','collabAgentToolCall','functionCallOutput'].includes(item.type)){
    let name='Tool',summary='Tool activity';
    if(item.type==='commandExecution'){
      const actions=Array.isArray(item.commandActions)?item.commandActions:[];
      const mapped=actions.slice(0,5).map(a=>{const x=obj(a),target=path(x?.path,binding.cwd);
        if(x?.type==='read')return {name:'Read file',summary:`Read file${target?' '+target:''}`};
        if(x?.type==='listFiles')return {name:'List files',summary:`List files${target?' in '+target:''}`};
        if(x?.type==='search')return {name:'Search',summary:`Search${target?' in '+target:''}`};
        return {name:'Command',summary:'Command'};
      });
      const names=[...new Set(mapped.map(action=>action.name))];
      name=names.length===1?names[0]!:'Command';
      summary=mapped.length?mapped.map(action=>action.summary).join(', '):'Command';
    }else if(item.type==='mcpToolCall'||item.type==='dynamicToolCall'){
      const namespace=safe(item.type==='mcpToolCall'?item.server:item.namespace);const tool=safe(item.tool);
      name=[namespace,tool].filter(Boolean).join('/')||'Tool';summary=name;
    }else if(item.type==='fileChange'){
      name='File change';const paths=Array.isArray(item.changes)?item.changes.map(c=>path(obj(c)?.path,binding.cwd)).filter(Boolean).slice(0,3):[];
      summary=paths.length?`Changed ${paths.join(', ')}`:'File change';
    }else if(item.type==='webSearch'){name='Web search';summary='Web search';}
    else if(item.type==='collabAgentToolCall'){name='Agent collaboration';summary=safe(item.tool)??name;}
    else if(item.type==='functionCallOutput'){name='Tool result';summary=safe(item.name)??name;}
    const duration=typeof item.durationMs==='number'&&Number.isSafeInteger(item.durationMs)&&item.durationMs>=0?item.durationMs:null;
    const exit=typeof item.exitCode==='number'&&Number.isSafeInteger(item.exitCode)?item.exitCode:null;
    const outcome=item.type==='dynamicToolCall'&&item.success===false||item.type==='mcpToolCall'&&item.error!=null?'failed':state(item.status);
    const supportedDetail=['commandExecution','mcpToolCall','dynamicToolCall','fileChange'].includes(item.type);
    const original=supportedDetail?toolDetail(item):null;
    const detailAvailable=original!==null&&([original.input,original.output,original.error].some(value=>value!==null&&value.length>0)||original.resources.length>0);
    const detailReason=detailAvailable?null:supportedDetail?'Native source did not provide original tool evidence.':'Original detail is unsupported for this native tool kind.';
    return {...b,kind:'tool',name,summary,state:outcome,durationMs:duration,exitCode:exit,detailAvailable,detailReason,...(detailAvailable&&detail?{detail:original!}:{})};
  }
  const labels:Record<string,string>={imageView:'Image',imageGeneration:'Image generation',subAgentActivity:'Subagent activity',sleep:'Wait',contextCompaction:'Context compacted',enteredReviewMode:'Review started',exitedReviewMode:'Review ended'};
  return {...b,kind:'notice',label:labels[item.type]??'Unsupported native item',body:'',state:'unknown'};
}
export function mapWorkspaceTurn(value:unknown):WorkspaceTurn|null{
  const t=obj(value);if(typeof t?.id!=='string'||!t.id)return null;
  return {id:t.id,state:state(t.status),startedAt:iso(t.startedAt,1000),completedAt:iso(t.completedAt,1000),origin:null};
}
export function mapWorkspaceEvent(method:string,params:unknown,binding:RuntimeBinding,observedAt:string,generation:string|null=null):WorkspaceRuntimeUpdate|null{
  const p=obj(params);if(!p||p.threadId!==binding.nativeThreadId)return null;
  const t=obj(p.turn);const turnId=str(p.turnId)??str(t?.id);
  const envelope={projectId:binding.projectId,sessionId:binding.sessionId,threadId:binding.nativeThreadId,turnId,observedAt};
  if(method==='turn/started'||method==='turn/completed'){
    const turn=mapWorkspaceTurn(t);
    if(turn)turn.order={kind:'turn-boundary',key:boundaryKey(binding.nativeThreadId,turn.id,method==='turn/started'?'start':'complete'),position:null,generation};
    return turn?{...envelope,turnId:turn.id,kind:'turn',turn}:null;
  }
  if(method==='turn/plan/updated'&&turnId){
    const steps=Array.isArray(p.plan)?p.plan:[];
    const lines=steps.slice(0,100).map((value,index)=>{
      const step=obj(value);if(typeof step?.step!=='string')return null;
      const status=['pending','inProgress','completed'].includes(String(step.status))?step.status:'unknown';
      return `${index+1}. [${status}] ${step.step}`;
    }).filter((value):value is string=>value!==null);
    const explanation=typeof p.explanation==='string'?p.explanation:'';
    const body=clipped([explanation,...lines].filter(Boolean).join('\n'),4096);
    const id=`plan:${binding.nativeThreadId}:${turnId}`;
    const entry:WorkspaceEntry={id,turnId,nativeItemId:null,nativeKind:'turnPlanUpdated',author:author('session',binding),origin:null,
      occurredAt:null,observedAt,freshness:'live',truncated:body.truncated||steps.length>100,
      order:{kind:'live-item',key:id,position:null,generation},kind:'plan',label:'Plan',body:body.value,
      state:steps.length>0&&steps.every(value=>obj(value)?.status==='completed')?'completed':'running'};
    return {...envelope,kind:'entry',entry};
  }
  if(method==='item/agentMessage/delta'&&turnId&&typeof p.itemId==='string'&&typeof p.delta==='string'){
    const delta=clipped(p.delta,8192);
    return {...envelope,kind:'text-delta',itemId:p.itemId,delta:delta.value,truncated:delta.truncated};
  }
  if((method==='item/started'||method==='item/completed')&&turnId){
    const entry=mapWorkspaceItem(p.item,turnId,binding,observedAt,p.startedAtMs??p.completedAtMs);
    if(entry){
      entry.freshness='live';entry.order={kind:'live-item',key:entry.id,position:null,generation};
      if(method==='item/started'&&(entry.kind==='tool'||entry.kind==='plan'||entry.kind==='message'&&entry.role==='assistant'))entry.state='running';
      return {...envelope,kind:'entry',entry};
    }
  }
  return null;
}
