import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { DocumentDetail, Principal } from "@evoloop/contracts";
import type { DocumentPayloadRevision } from "@evoloop/contracts/process-documents";
import type { BlobStore } from "@evoloop/contracts/sources";
import type { KnowledgeIngestRequest, KnowledgeRepository, KnowledgeRevision } from "@evoloop/contracts/knowledge";
import { DomainError } from "@evoloop/contracts/ports";
import { registerKnowledgeRoutes } from "../src/knowledge/routes.js";

const hash = (body: string) => createHash("sha256").update(body).digest("hex");
test("native work routes verify original authority, filter stale retrieval and lint candidates before review", async t => {
  const projectId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID();
  const knowledgeId = randomUUID(), knowledgeRevision = randomUUID(), candidateId = randomUUID();
  let adoptedRevisionId: string | null = revisionId;
  const fixed: DocumentPayloadRevision = { projectId, documentId, id: revisionId, previousRevisionId: null,
    format: "markdown", mediaType: "text/markdown", originalName: "original.md", body: "# Fixed original",
    payloadRef: null, contentHash: hash("# Fixed original"), entrypoint: null, assetsManifest: [],
    author: "owner", reason: "fixture", createdAt: new Date().toISOString() };
  const source = { sourceKey: `document:${documentId}`, originRevision: revisionId, contentHash: fixed.contentHash,
    fragment: null, state: "reachable" as const };
  const page: KnowledgeRevision = { projectId, knowledgeId, revision: knowledgeRevision, previousRevision: null,
    title: "Derived page", body: "# Derived", contentHash: hash("# Derived"), pageType: "concept", epistemicStatus: "inference",
    validity: "valid", observedValidity: "valid", sources: [source], relations: [], createdAt: "2026-10-21T00:00:00Z" };
  let ingested: KnowledgeIngestRequest | null = null, withdrawn = false;
  const repo: KnowledgeRepository = {
    capabilities: async () => ({backendVersion:"fixture",backendReachable:true,fixedRevisionRead:"adapter_verified",
      conditionalPublish:"single_maintainer_adapter",boundedRelations:"adapter_verified",migration:"unsupported",semanticIndex:"unverified"}),
    get: async (_p,id,rev) => id === knowledgeId && (!rev || rev === knowledgeRevision) ? page : null,
    list: async () => ({items:[],nextCursor:null,watermark:0}), history: async () => ({items:[],nextCursor:null,watermark:0}),
    graph: async () => ({nodes:[],edges:[],status:"complete",watermark:0}), sourceState: async () => withdrawn ? "withdrawn" : "reachable",
    listCandidates: async () => ({items:[],nextCursor:null,watermark:0}),
    getCandidate: async (_p,id) => id !== candidateId ? null : ({projectId,knowledgeId,candidateId,candidateRevision:knowledgeRevision,
      expectedRevision:null,title:page.title,body:page.body,contentHash:page.contentHash,pageType:page.pageType,
      epistemicStatus:page.epistemicStatus,sources:page.sources,relations:page.relations,operationId:randomUUID(),actorId:"owner",status:"pending",decision:null}),
    propose: async c=>c, review:async()=>{}, publish:async(_p,_c,op)=>({status:"unknown",operationId:op,reason:"not in test"}),
    reconcile:async()=>null,retractSource:async()=>[],
    ingestSource:async input=>{ingested=input;return {operationId:input.operationId,actorId:input.actorId,source:input.source,title:input.title,
      status:"submitted",taskId:"native-task",indexStatus:"unverified"};},
    getIngestion:async()=>null,
    query:async(_p,input)=>({items:[{kind:"document",id:documentId,revision:revisionId,contentHash:fixed.contentHash,title:"Original",score:0.9},
      {kind:"wiki",id:knowledgeId,revision:knowledgeRevision,contentHash:page.contentHash,title:page.title,score:0.8}],
      scope:input.scope,coverage:"bounded",indexStatus:"unverified",excluded:0}),
  };
  const app = Fastify();
  app.decorateRequest("principal",null);
  app.addHook("onRequest", async req=>{ const actor=req.headers.authorization === "Bearer writer" ? "writer" : "reader";
    req.principal={actorId:actor,projectIds:[projectId],permissions:actor === "writer" ? ["read","write"] : ["read"]} as Principal; });
  app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof DomainError ? e.code === "FORBIDDEN" ? 403 : 409 : 400)
    .send({code:e instanceof DomainError ? e.code : "INVALID_INPUT"}));
  registerKnowledgeRoutes(app,{workflow:{
    listDocuments:async()=>({items:[],nextCursor:null}),
    getDocument:async(_p,p,id)=>{if(p!==projectId||id!==documentId)throw new DomainError("NOT_FOUND","Not found");
      return {document:{projectId,id:documentId,title:"Original",version:1,currentRevisionId:revisionId,adoptedRevisionId},current:fixed,adopted:fixed} as DocumentDetail;},
    getDocumentPayloadRevision:async(_p,p,id,rev)=>{if(p!==projectId||id!==documentId||rev!==revisionId)throw new DomainError("NOT_FOUND","Not found");return fixed;},
    getRegisteredBlob:async()=>{throw new DomainError("NOT_FOUND","No blob");},
  },repositoryForPrincipal:()=>repo,blobsForPrincipal:()=>({} as BlobStore)});
  t.after(()=>app.close());
  const base=`/api/projects/${projectId}/knowledge`;
  const input={operationId:randomUUID(),documentId,revisionId};
  const post=(url:string,payload:unknown,actor="writer")=>app.inject({method:"POST",url:`${base}${url}`,headers:{authorization:`Bearer ${actor}`},payload});
  const get=(url:string)=>app.inject({method:"GET",url:`${base}${url}`});
  assert.equal((await post('/ingestions',input,'reader')).statusCode,403);
  assert.equal(ingested,null);
  assert.equal((await post('/ingestions',{...input,url:"http://unsafe"})).statusCode,400,"arbitrary inputs cannot enter native parser");
  adoptedRevisionId=null;
  assert.equal((await post('/ingestions',input)).statusCode,409);
  assert.equal(ingested,null,"unadopted sources never reach native upload");
  adoptedRevisionId=revisionId;
  fixed.body="tampered";
  assert.equal((await post('/ingestions',input)).statusCode,409);
  fixed.body="# Fixed original";
  const accepted=await post('/ingestions',input);
  assert.equal(accepted.statusCode,200,accepted.body);
  assert.equal(accepted.json().actorId,"writer");
  assert.equal((ingested as KnowledgeIngestRequest | null)?.body,fixed.body);
  assert.equal((await get('/query?query=what&scope=published')).json().items.length,1,"scope cannot be widened by a backend hit");
  adoptedRevisionId=randomUUID();
  const stale=(await get('/query?query=what&scope=sources')).json();
  assert.equal(stale.items.length,0,"current source validation drops stale Document hits and out-of-scope Wiki hits");
  assert.equal(stale.excluded,2);
  const broken=(await get(`/candidates/${candidateId}/lint`)).json();
  assert.equal(broken.target,"candidate"); assert.equal(broken.semantic,"not_run");
  assert.ok(broken.findings.some((f:{code:string})=>f.code === "SOURCE_UNAVAILABLE"));
  adoptedRevisionId=revisionId;
  const good=(await get(`/pages/${knowledgeId}/lint?revision=${knowledgeRevision}`)).json();
  assert.equal(good.structural,"passed"); assert.equal(good.semantic,"not_run");
  page.relations=[{edgeId:"missing-target",fromKnowledgeId:knowledgeId,fromRevision:knowledgeRevision,
    toKnowledgeId:randomUUID(),toRevision:randomUUID(),type:"supports",sourceKeys:[],state:"active"}];
  page.sources.push({...source});
  const damaged=(await get(`/candidates/${candidateId}/lint`)).json();
  assert.ok(damaged.findings.some((f:{code:string})=>f.code === "RELATION_UNAVAILABLE"));
  assert.ok(damaged.findings.some((f:{code:string})=>f.code === "DUPLICATE_SOURCE"));
  page.relations=[];page.sources.pop();
  withdrawn=true;
  const withdrawnReport=(await get(`/pages/${knowledgeId}/lint`)).json();
  assert.ok(withdrawnReport.findings.some((f:{code:string})=>f.code === "SOURCE_UNAVAILABLE"));
  assert.equal((await app.inject({method:"GET",url:`/api/projects/${randomUUID()}/knowledge/query?query=x`})).statusCode,403);
});
