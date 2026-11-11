import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { registerLeaderWorkRoutes } from "../src/work-management/leader-routes.ts";
import { registerLeaderNoticeRoutes } from "../src/work-management/leader-notice-routes.ts";
import type { LeaderWorkIndexReader } from "../src/work-management/work-index.ts";
import { DomainError } from "@evoloop/contracts/ports";

test("work-management routes bind route identity and expose stable read/write commands", async t => {
  const projectId = randomUUID(), taskId = randomUUID(), operationId = randomUUID();
  let principal = { actorId: "leader", projectIds: [projectId], permissions: ["read", "write", "review"] as const };
  const reads: unknown[] = [], plans: unknown[] = [], dependencies: unknown[] = [], reviews: unknown[] = [];
  const reader: LeaderWorkIndexReader = {
    index: async (_principal, project, query) => { reads.push({ project, query }); return { items: [], nextCursor: null }; },
    task: async (_principal, project, projectedTaskId) => {
      reads.push({ project, taskId: projectedTaskId }); return { taskId: projectedTaskId };
    },
    changes: async (_principal, project, limit, cursor) => { reads.push({ project, limit, cursor }); return { items: [], nextCursor: null }; },
    setPlan: async (who, project, command) => { plans.push({ who, project, command }); return { status: "applied" }; },
    setDependencies: async (who, project, command) => { dependencies.push({ who, project, command }); return { status: "applied" }; },
    setReview: async (who, project, command) => { reviews.push({ who, project, command }); return { status: "applied" }; },
  };
  const service = { getProject: async () => ({ id: projectId }) };
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = principal as unknown as typeof request.principal; });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.code === "FORBIDDEN" ? 403 : 409).send({ code: error.code });
    throw error;
  });
  registerLeaderWorkRoutes(app, service, reader);

  const read = await app.inject({ method: "GET", url: `/api/projects/${projectId}/work-management/index?view=documents&limit=20` });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(reads[0], { project: projectId,
    query: { view: "documents", limit: 20, includeClosed: false } });
  const exact = await app.inject({ method: "GET",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}` });
  assert.equal(exact.statusCode, 200);
  assert.deepEqual(reads[1], { project: projectId, taskId });

  const plan = await app.inject({ method: "PUT",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}/plan`,
    payload: { operationId, expectedTaskVersion: 1, expectedPlanVersion: 0, plannedStartAt: null,
      dueAt: null, priority: 2, reason: "Leader ordered this work" } });
  assert.equal(plan.statusCode, 200);
  assert.deepEqual((plans[0] as { command: { projectId: string; taskId: string } }).command.projectId, projectId);
  assert.deepEqual((plans[0] as { command: { taskId: string } }).command.taskId, taskId);

  const dependency = await app.inject({ method: "PUT",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}/dependencies`,
    payload: { operationId: randomUUID(), expectedTaskVersion: 1, expectedDependencyVersion: 0,
      dependsOnTaskIds: [], reason: "No prerequisite remains" } });
  assert.equal(dependency.statusCode, 200);
  assert.equal((dependencies[0] as { command: { taskId: string } }).command.taskId, taskId);

  const review = await app.inject({ method: "PUT",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}/review`,
    payload: { operationId: randomUUID(), expectedTaskVersion: 1, expectedTaskRevisionId: randomUUID(),
      expectedWorkChangeSequence: 8,
      decision: "deferred", reason: "Wait for the prerequisite" } });
  assert.equal(review.statusCode, 200);
  assert.equal((reviews[0] as { command: { decision: string } }).command.decision, "deferred");

  principal = { ...principal, permissions: ["read", "write"] as const };
  const denied = await app.inject({ method: "PUT",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}/plan`,
    payload: { operationId: randomUUID(), expectedTaskVersion: 1, expectedPlanVersion: 1,
      plannedStartAt: null, dueAt: null, priority: 2, reason: "Should require review authority" } });
  assert.equal(denied.statusCode, 403);
});

test("Leader notice reads require project access and retain Task scoped cursor", async t => {
  const projectId = randomUUID(), taskId = randomUUID();
  let authenticated = true;
  const seen: unknown[] = [];
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = authenticated ?
    { actorId: "reader", projectIds: [projectId], permissions: ["read"] } : null; });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(403).send({ code: error.code });
    throw error;
  });
  registerLeaderNoticeRoutes(app, { getProject: async (_who, p) => {
    if (p !== projectId) throw new DomainError("FORBIDDEN", "project");
    return { id: p };
  } }, { list: async (p, query) => { seen.push({ p, query }); return { items: [], nextCursor: null }; } });
  const url = `/api/projects/${projectId}/work-management/notices?taskId=${taskId}&limit=20&cursor=next`;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 200);
  assert.deepEqual(seen[0], { p: projectId, query: { taskId, limit: 20, cursor: "next" } });
  authenticated = false;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 403);
  assert.equal(seen.length, 1);
});

test("only a project reviewer can create a fresh intent for a rejected notice",async t=>{
  const projectId=randomUUID(),noticeId=randomUUID();
  const input={expectedOperationId:randomUUID(),newNoticeId:randomUUID(),newMessageId:randomUUID(),
    newOperationId:randomUUID(),reason:"Confirmed rejection after Session recovery"};
  let principal={actorId:"lead",projectIds:[projectId],permissions:["read","write"] as string[]};
  const calls:unknown[]=[];
  const app=Fastify();t.after(()=>app.close());
  app.decorateRequest("principal",null);
  app.addHook("onRequest",async request=>{request.principal=principal as typeof request.principal;});
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof DomainError)return reply.code(403).send({code:error.code});
    if(error.name==="ZodError")return reply.code(400).send({code:"INVALID_INPUT"});
    throw error;
  });
  registerLeaderNoticeRoutes(app,{getProject:async (_who,p)=>{
    if(p!==projectId)throw new DomainError("FORBIDDEN","project");return {id:p};
  }},{list:async()=>({items:[],nextCursor:null}),get:async()=>({id:noticeId}),
    recover:async(p,id,body,actor)=>{calls.push({p,id,body,actor});return {status:"recorded",originalNoticeId:id,
      newNoticeId:body.newNoticeId,newMessageId:body.newMessageId,newOperationId:body.newOperationId};}});
  const url=`/api/projects/${projectId}/work-management/notices/${noticeId}/recover`;
  assert.equal((await app.inject({method:"POST",url,payload:input})).statusCode,403);
  principal={...principal,permissions:["read","write","review"]};
  const response=await app.inject({method:"POST",url,payload:input});
  assert.equal(response.statusCode,200);
  assert.deepEqual(calls,[{p:projectId,id:noticeId,body:input,actor:"lead"}]);
  assert.equal((await app.inject({method:"GET",url:url.slice(0,-"/recover".length)})).statusCode,200);
  assert.equal((await app.inject({method:"POST",url,payload:{...input,newMessageId:input.newNoticeId}})).statusCode,400);
});

test("a blocked notice packet is recovered by its id with review authority and a reason",async t=>{
  const projectId=randomUUID(),packetId=randomUUID();
  let principal={actorId:"lead",projectIds:[projectId],permissions:["read","write","review"] as string[]};
  const calls:unknown[]=[];
  const app=Fastify();t.after(()=>app.close());
  app.decorateRequest("principal",null);
  app.addHook("onRequest",async request=>{request.principal=principal as typeof request.principal;});
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof DomainError)return reply.code(403).send({code:error.code});
    if(error.name==="ZodError")return reply.code(400).send({code:"INVALID_INPUT"});
    throw error;
  });
  registerLeaderNoticeRoutes(app,{getProject:async (_who,p)=>{
    if(p!==projectId)throw new DomainError("FORBIDDEN","project");return {id:p};
  }},{list:async()=>({items:[],nextCursor:null}),
    recoverPacket:async(who,p,id,reason)=>{calls.push({who:who.actorId,p,id,reason});return {status:"recorded",packetId:id,state:"recovered"};}});
  const url=`/api/projects/${projectId}/leader-notice-packets/${packetId}/recover`;
  const response=await app.inject({method:"POST",url,payload:{reason:"gate reviewed"}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json(),{status:"recorded",packetId,state:"recovered"});
  assert.deepEqual(calls,[{who:"lead",p:projectId,id:packetId,reason:"gate reviewed"}]);
  assert.equal((await app.inject({method:"POST",url,payload:{}})).statusCode,400,"a reason is required");
  assert.equal((await app.inject({method:"POST",url,payload:{reason:"x",extra:1}})).statusCode,400);
  principal={...principal,permissions:["read","write"]};
  assert.equal((await app.inject({method:"POST",url,payload:{reason:"gate reviewed"}})).statusCode,403,"review authority is required");
  assert.equal(calls.length,1);
});

test("the Leader's task index lists blocked notice packets with what to do about them",async t=>{
  const projectId=randomUUID();
  const app=Fastify();t.after(()=>app.close());
  app.decorateRequest("principal",null);
  app.addHook("onRequest",async request=>{request.principal={actorId:"lead",projectIds:[projectId],permissions:["read","write","review"]} as typeof request.principal;});
  const blocked=[{packetId:randomUUID(),sessionId:randomUUID(),itemCount:3,blockedAt:null,hint:"leader.notice.recover"}];
  const reader={index:async()=>({items:[],total:0}),blockedNoticePackets:async()=>blocked} as unknown as LeaderWorkIndexReader;
  registerLeaderWorkRoutes(app,{getProject:async()=>({})} as never,reader);
  const tasks=await app.inject({method:"GET",url:`/api/projects/${projectId}/work-management/index?view=tasks`});
  assert.equal(tasks.statusCode,200);
  assert.deepEqual(tasks.json().blockedNoticePackets,blocked);
  const documents=await app.inject({method:"GET",url:`/api/projects/${projectId}/work-management/index?view=documents`});
  assert.equal(documents.json().blockedNoticePackets,undefined);
});
