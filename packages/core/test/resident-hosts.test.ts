import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import type { Transaction } from "@evoloop/contracts/ports";
import type { BusinessDomain, HostLink, ResidentCommand } from "@evoloop/contracts/resident-hosts";
import { DomainError } from "@evoloop/contracts/ports";
import { applyResident } from "../src/resident-hosts.js";
import { WorkflowService } from "../src/index.js";

const projectId=randomUUID(), roleId=randomUUID(), sessionId=randomUUID();
const now="2026-10-25T10:00:00.000Z";
const reviewer: Principal={actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]};
function fixture() {
  const domains=new Map<string,BusinessDomain>(), links=new Map<string,HostLink>();
  let roleState="active", roleVersion=4, sessionState="ready", bound=true;
  const tx={
    getBusinessDomain:async(id:string)=>domains.get(id)??null,
    createBusinessDomain:async(value:BusinessDomain)=>{domains.set(value.id,value);},
    advanceBusinessDomain:async(value:BusinessDomain)=>{domains.set(value.id,value);},
    getHostLink:async(id:string)=>links.get(id)??null,
    createHostLink:async(value:HostLink)=>{links.set(value.id,value);},
    advanceHostLink:async(value:HostLink)=>{links.set(value.id,value);},
    getRole:async(id:string)=>id===roleId?{id,projectId,version:roleVersion,state:roleState}:null,
    getRuntimeSession:async(id:string)=>id===sessionId?{id,projectId,roleId,state:sessionState,nativeThreadId:"native"}:null,
    listSessionBindings:async()=>bound?[{sessionId}]:[],
  } as unknown as Transaction;
  return {tx,domains,links,setRoleState:(value:string)=>{roleState=value;},setRoleVersion:(value:number)=>{roleVersion=value;},
    setSessionState:(value:string)=>{sessionState=value;},setBound:(value:boolean)=>{bound=value;}};
}
const apply=(tx:Transaction,command:ResidentCommand,principal=reviewer)=>applyResident(tx,principal,command,now,randomUUID);
const domain=(id:string):ResidentCommand=>({type:"domain.create",projectId,operationId:randomUUID(),domainId:id,title:"功能开发",
  roleId,observedRoleVersion:4,routingReason:"reviewed owner mapping",authorizationEvidence:"Task and accepted Role trial"});

test("domain mapping is reviewed, versioned, and distinct from Task kind",async()=>{
  const f=fixture(),id=randomUUID();
  await assert.rejects(()=>apply(f.tx,domain(id),{...reviewer,permissions:["write"]}),
    (e:unknown)=>e instanceof DomainError&&e.code==="FORBIDDEN");
  assert.equal((await apply(f.tx,domain(id))).version,1);
  await assert.rejects(()=>apply(f.tx,{type:"domain.update",projectId,operationId:randomUUID(),domainId:id,
    expectedVersion:2,title:"改名",roleId,routingReason:"new order",authorizationEvidence:"review",state:"active",reason:"change"}),
    (e:unknown)=>e instanceof DomainError&&e.code==="VERSION_CONFLICT");
  f.setRoleState("retired");
  await assert.rejects(()=>apply(f.tx,domain(randomUUID())),
    (e:unknown)=>e instanceof DomainError&&e.code==="ROLE_UNAVAILABLE");
});

test("Desktop link remains manual and verification requires current Role and evidence",async()=>{
  const f=fixture(),linkId=randomUUID();
  const register:ResidentCommand={type:"host.register",projectId,operationId:randomUUID(),linkId,roleId,
    expectedRoleVersion:4,host:{kind:"external",provider:"codex-desktop",ref:"chat:01a158d7"},
    claimedCapabilities:["open","read","manual-claim"],reason:"human handoff"};
  await apply(f.tx,register);
  assert.equal(f.links.get(linkId)?.state,"registered");
  assert.deepEqual(f.links.get(linkId)?.verifiedCapabilities,[]);
  await assert.rejects(()=>apply(f.tx,{...register,linkId:randomUUID(),claimedCapabilities:["start"]}),
    (e:unknown)=>e instanceof DomainError&&e.code==="INVALID_CAPABILITY");
  f.setRoleVersion(5);
  await assert.rejects(()=>apply(f.tx,{type:"host.verify",projectId,operationId:randomUUID(),linkId,
    expectedVersion:1,expectedRoleVersion:4,verifiedCapabilities:["manual-claim"],evidence:"opened chat",
    observedAtUtc:now,reason:"checked"}),
    (e:unknown)=>e instanceof DomainError&&e.code==="VERSION_CONFLICT");
  const verified=await apply(f.tx,{type:"host.verify",projectId,operationId:randomUUID(),linkId,
    expectedVersion:1,expectedRoleVersion:5,verifiedCapabilities:["open","read","manual-claim"],
    evidence:"opened and read chat; human accepted handoff",observedAtUtc:now,reason:"checked"});
  assert.equal(verified.version,2);
  assert.equal(f.links.get(linkId)?.observer,"reviewer");
  await assert.rejects(()=>apply(f.tx,{type:"host.revoke",projectId,operationId:randomUUID(),linkId,
    expectedVersion:1,reason:"withdrawn"}),
    (e:unknown)=>e instanceof DomainError&&e.code==="VERSION_CONFLICT");
});

test("owned registration rejects unbound or wrong Session",async()=>{
  const f=fixture(),linkId=randomUUID();
  const command:ResidentCommand={type:"host.register",projectId,operationId:randomUUID(),linkId,roleId,
    expectedRoleVersion:4,host:{kind:"owned",sessionId},claimedCapabilities:["read"],reason:"formal binding"};
  f.setBound(false);
  await assert.rejects(()=>apply(f.tx,command),(e:unknown)=>e instanceof DomainError&&e.code==="SESSION_UNOWNED");
  f.setBound(true);f.setSessionState("unknown");
  await assert.rejects(()=>apply(f.tx,command),(e:unknown)=>e instanceof DomainError&&e.code==="SESSION_UNOWNED");
  f.setSessionState("ready");
  assert.equal((await apply(f.tx,command)).version,1);
});

test("routing observes an existing formal owned binding and fences a revoked link",async()=>{
  const domainId=randomUUID(),linkId=randomUUID();
  const current:BusinessDomain={projectId,id:domainId,version:1,currentRevisionId:randomUUID(),title:"Development",
    roleId,routingReason:"reviewed mapping",authorizationEvidence:"Role trial",state:"active",actorId:"reviewer",createdAtUtc:now};
  const links:HostLink[]=[];
  const reader={getProject:async()=>({id:projectId,title:"test",createdAt:now}),
    getBusinessDomain:async()=>current,
    getRole:async()=>({projectId,id:roleId,version:1,state:"active",proposal:{title:"Development"}}),
    listHostLinks:async()=>links,
    listSessionBindings:async()=>[{sessionId}],
    getRuntimeSession:async()=>({projectId,id:sessionId,roleId,state:"ready",nativeThreadId:"native"})};
  const service=new WorkflowService({uow:{read:async(_projectId:string,action:(value:typeof reader)=>Promise<unknown>)=>action(reader)} as any,
    clock:{now:()=>now},ids:{next:randomUUID},hasher:{hash:(value:string)=>value}});
  const owned=await service.getDomainRoute(reviewer,projectId,domainId);
  assert.equal(owned.status,"owned-ready");
  assert.equal(owned.link,null);
  assert.equal(owned.automaticStart,false);
  links.push({projectId,id:linkId,roleId,version:2,host:{kind:"owned",sessionId},claimedCapabilities:["read"],
    verifiedCapabilities:[],evidence:"withdrawn",observer:"reviewer",observedAtUtc:now,state:"revoked",actorId:"reviewer",createdAtUtc:now});
  assert.equal((await service.getDomainRoute(reviewer,projectId,domainId)).status,"unlinked");
});
