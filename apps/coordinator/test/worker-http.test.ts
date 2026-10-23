import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowService } from "@evoloop/core";
import type { OrchestrationService } from "@evoloop/core/orchestration";
import type { DocumentPayloadRevision, DocumentPayloadUnitOfWork } from "@evoloop/contracts/process-documents";
import type { BlobStore } from "@evoloop/contracts/sources";
import type { ReferenceUnitOfWork } from "@evoloop/contracts/references";
import type { DocumentSource } from "@evoloop/contracts/sources";
import type { KnowledgeRepository } from "@evoloop/contracts/knowledge";
import { buildServer } from "../src/server.js";
import { WorkerCredentialBroker } from "../src/workers/credentials.js";
import type { WorkerGuardFacts } from "../src/workers/guard.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = id(1), OTHER = id(2), LOOP = id(3), TASK = id(4), OTHER_TASK = id(5);
const B_RUN = id(6), B_SESSION = id(7), C_RUN = id(8), C_SESSION = id(9);
const DOC = id(10), DOC_REV = id(11), TASK_REV = id(12), GIT = id(13), WIKI = id(14), WIKI_REV = id(15);
const DISPATCH = id(16), EVENT = id(17), INBOX = id(18), GOAL = id(19), STAGE = id(20);
const ownerToken = "o".repeat(40);
const body = "# Fixed original\n";
const fixed: DocumentPayloadRevision = { projectId: P, documentId: DOC, id: DOC_REV,
  previousRevisionId: null, format: "markdown", mediaType: "text/markdown", originalName: "report.md",
  body, payloadRef: null, contentHash: createHash("sha256").update(body).digest("hex"),
  entrypoint: null, assetsManifest: [], author: "fixture", reason: "fixed", createdAt: "2026-10-23T00:00:00Z" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "evoloop-worker-http-"));
  let now = Date.parse("2026-10-23T00:00:00Z");
  const broker = new WorkerCredentialBroker({ workerRoot: root, apiUrl: "http://127.0.0.1:1",
    cliMain: "/fixture/cli.js", nodeExecutable: process.execPath, ttlMs: 60_000, now: () => now });
  const business = await broker.issue({projectId:P,loopId:LOOP,taskId:TASK,runId:B_RUN,sessionId:B_SESSION,
    roleId:"builder",kind:"business",allowedRoleIds:["builder"]});
  const cognition = await broker.issue({projectId:P,loopId:LOOP,taskId:TASK,runId:C_RUN,sessionId:C_SESSION,
    roleId:"planner",kind:"cognition",allowedRoleIds:["planner","builder"]});
  const tokenFor = async (runId: string) => ({authorization:`Bearer ${await readFile(join(root,runId,"credential"),"utf8")}`});
  const businessAuth = await tokenFor(B_RUN), cognitionAuth = await tokenFor(C_RUN);
  const ownerAuth = {authorization:`Bearer ${ownerToken}`};
  let loopState: "active" | "paused" | "stopped" = "active";
  const reached: string[] = [];
  const facts: WorkerGuardFacts = {
    loop: async key => key === LOOP ? {projectId:P,state:loopState,goalId:GOAL,stageId:STAGE,
      cognitiveRoleId:"planner",allowedBusinessRoleIds:["builder"]} : null,
    task: async key => key === TASK ? {projectId:P,ownerRoleId:"builder",loopId:LOOP} :
      key === OTHER_TASK ? {projectId:OTHER,ownerRoleId:"builder",loopId:LOOP} : null,
    taskRevision: async (task,rev) => task === TASK && rev === TASK_REV,
    run: async key => key === B_RUN ? {projectId:P,taskId:TASK,sessionId:B_SESSION} :
      key === C_RUN ? {projectId:P,taskId:TASK,sessionId:C_SESSION} : null,
    delivery: async () => null,
    inbox: async key => key === INBOX ? {projectId:P,loopId:LOOP,state:"acknowledged"} : null,
    document: async key => key === DOC ? {projectId:P,taskId:TASK,loopId:LOOP} : null,
    fixedDocument: async (task,doc,rev) => task === TASK && doc === DOC && rev === DOC_REV,
    fixedReference: async (task,kind,ref,rev) => task === TASK &&
      (kind === "git" && ref === GIT || kind === "wiki" && ref === WIKI && rev === WIKI_REV),
    operation: async key => key === id(90) ? {projectId:P,actorId:business.principal.actorId} :
      key === id(91) ? {projectId:P,actorId:"somebody-else"} : null,
    dispatchForRun: async run => run === B_RUN || run === C_RUN ?
      {projectId:P,id:DISPATCH,loopId:LOOP,taskId:TASK,sourceEventId:EVENT,runtimeRunId:run} : null,
  };
  const workflow = {
    listRoles: async () => [], listRoleRevisions: async () => [], listRoleReviews: async () => [],
    listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [],
    listSchedules: async () => [], listScheduleRevisions: async () => [], listScheduleOccurrences: async () => [],
    getProject: async (...args: unknown[]) => {reached.push("project");return {id:P,actorId:(args[0] as {actorId:string}).actorId};},
    getTask: async () => {reached.push("task");return {id:TASK};},
    getTaskRevision: async () => {reached.push("taskRevision");return {id:TASK_REV};},
    getDocumentPayloadRevision: async () => {reached.push("original");return fixed;},
    getRuntimeRun: async () => {reached.push("run");return {id:B_RUN};},
    getOperation: async () => {reached.push("operation");return null;},
    execute: async (_principal: unknown, command: {type:string;operationId:string}) => {
      reached.push(`business:${command.type}`);
      return {status:"applied",operationId:command.operationId,entityId:TASK,version:1,replayed:false};
    },
  } as unknown as WorkflowService;
  const orchestration = {
    execute: async (_principal: unknown, command: {type:string}) => {
      reached.push(`orchestration:${command.type}`);
      return {entityId:DISPATCH,version:1,replayed:false};
    },
    getOperation: async () => {reached.push("orchestrationOperation");return null;},
  } as unknown as OrchestrationService;
  const app = await buildServer({credentials:[{token:ownerToken,actorId:"owner",projectIds:[P],permissions:["read","write","review"]}],
    service:workflow, orchestration:{service:orchestration},
    workers:{authenticate:header=>broker.authenticate(header),facts:()=>facts},
    documents:{uow:{} as DocumentPayloadUnitOfWork,blobsForPrincipal:async()=>({} as BlobStore)},
    references:{uow:{read:async (_p:string,fn:(reader:unknown)=>Promise<unknown>)=>fn({getGitSourceRef:async()=>({ref:{commit:"fixed"}})})} as ReferenceUnitOfWork,
      gitForPrincipal:async()=>({read:async()=>({status:"available",ref:{commit:"fixed"},bytes:Buffer.from("git"),observedAt:"2026-10-23T00:00:00Z"})} as DocumentSource),
      knowledgeForPrincipal:async()=>({} as KnowledgeRepository)},
    knowledge:{repositoryForPrincipal:async()=>({get:async()=>({id:WIKI,revision:WIKI_REV})} as KnowledgeRepository),
      blobsForPrincipal:async()=>({} as BlobStore)},
  });
  const inject = (auth: Record<string,string>, method:string, url:string, payload?:unknown) =>
    app.inject({method,url,headers:auth,...(payload === undefined ? {} : {payload})});
  return {app,root,broker,business,cognition,businessAuth,cognitionAuth,ownerAuth,reached,inject,
    setState:(value:typeof loopState)=>{loopState=value;},expire:()=>{now+=61_000;},close:async()=>{await app.close();await rm(root,{recursive:true,force:true});}};
}

test("real broker identity crosses HTTP hooks; unauthorized requests never reach services", async () => {
  const f=await fixture();
  try {
    const session=await f.inject(f.businessAuth,"GET","/api/session");
    assert.equal(session.statusCode,200);
    assert.equal(session.json().principal.actorId,f.business.principal.actorId);
    assert.equal((await f.inject(f.ownerAuth,"GET",`/api/projects/${P}`)).statusCode,200);
    assert.equal((await f.inject(f.businessAuth,"GET",`/api/projects/${P}/tasks/${TASK}`)).statusCode,200);
    const before=f.reached.length;
    for (const [method,url,payload] of [
      ["GET",`/api/projects/${OTHER}/tasks/${TASK}`,undefined],
      ["GET",`/api/projects/${P}/tasks/${OTHER_TASK}`,undefined],
      ["GET",`/api/projects/${P}/tasks`,undefined],
      ["GET",`/api/projects/${P}/roles`,undefined],
      ["GET",`/api/projects/${P}/runtime`,undefined],
      ["POST",`/api/projects/${P}/runtime/recover`,{}],
      ["POST",`/api/projects/${P}/references/git`,{}],
      ["POST","/api/commands",{type:"task.create",projectId:P,operationId:id(31),taskId:id(32),title:"x",content:"x",acceptance:"x",owner:"builder",stageId:STAGE}],
      ["POST","/api/commands",{type:"runtime.session.reserve",projectId:P,operationId:id(33),sessionId:id(34),roleId:"builder",cwd:"/tmp",authorizationScope:"all",sandbox:"workspace-write",approvalPolicy:"on-request"}],
      ["POST","/api/orchestration/commands",{type:"dispatch.claim",projectId:P,operationId:id(35),dispatchId:DISPATCH,claimToken:id(36),leaseUntilUtc:"2026-10-23T00:01:00Z"}],
    ] as const) {
      const response=await f.inject(f.businessAuth,method,url,payload);
      assert.equal(response.statusCode,403,`${method} ${url}: ${response.body}`);
    }
    assert.equal(f.reached.length,before);
  } finally {await f.close();}
});

test("fixed revision, original, Git and Wiki reads pass strict facts; guessed versions fail before handlers", async () => {
  const f=await fixture();
  try {
    for (const [url,expected] of [
      [`/api/projects/${P}/tasks/${TASK}/revisions/${TASK_REV}`,"taskRevision"],
      [`/api/projects/${P}/documents/${DOC}/revisions/${DOC_REV}/original`,"original"],
      [`/api/projects/${P}/references/git/${GIT}`,null],
      [`/api/projects/${P}/knowledge/pages/${WIKI}?revision=${WIKI_REV}`,null],
      [`/api/projects/${P}/runtime/runs/${B_RUN}`,"run"],
    ] as const) {
      const response=await f.inject(f.businessAuth,"GET",url);
      assert.equal(response.statusCode,200,`${url}: ${response.body}`);
      if (expected) assert.ok(f.reached.includes(expected));
      if (url.endsWith("/original")) assert.equal(response.json().body,body);
    }
    const before=f.reached.length;
    for (const url of [
      `/api/projects/${P}/tasks/${TASK}/revisions/${id(40)}`,
      `/api/projects/${P}/documents/${DOC}/revisions/${id(41)}/original`,
      `/api/projects/${P}/references/git/${id(42)}`,
      `/api/projects/${P}/knowledge/pages/${WIKI}?revision=${id(43)}`,
      `/api/projects/${P}/knowledge/pages/${WIKI}?revision=${WIKI_REV}&revision=${WIKI_REV}`,
      `/api/projects/${P}/runtime/runs/${C_RUN}`,
    ]) assert.equal((await f.inject(f.businessAuth,"GET",url)).statusCode,403,url);
    assert.equal(f.reached.length,before);
  } finally {await f.close();}
});

test("signed submissions survive pause and stop; new work is blocked and unknown operation stays 404", async () => {
  const f=await fixture();
  try {
    const common={projectId:P,operationId:id(50)};
    const submit={...common,type:"worker.submit",submissionId:id(51),dispatchId:DISPATCH,runId:B_RUN,
      taskRevisionId:TASK_REV,runInputHash:"fixture-hash",deliveryOperationId:id(52),
      deliveryIntent:{artifactRef:"document:fixture",artifactRevision:"1",contentHash:"a".repeat(64),technicalResult:"passed",technicalEvidence:"fixture",reason:"submitted"},
      agentObservation:null,evidenceRefs:[]};
    const decision={...common,type:"worker.decision",decisionId:id(53),dispatchId:DISPATCH,runId:C_RUN,
      kind:"waiting",reason:"fixture waiting",evidenceRefs:[]};
    for (const state of ["active","paused","stopped"] as const) {
      f.setState(state);
      assert.equal((await f.inject(f.businessAuth,"POST","/api/orchestration/commands",submit)).statusCode,200);
      assert.equal((await f.inject(f.cognitionAuth,"POST","/api/orchestration/commands",decision)).statusCode,200);
      assert.equal((await f.inject(f.businessAuth,"GET",`/api/projects/${P}/runtime/runs/${B_RUN}`)).statusCode,200);
      const missing=await f.inject(f.businessAuth,"GET",`/api/projects/${P}/orchestration/operations/${id(54)}`);
      assert.equal(missing.statusCode,404);
      assert.equal(missing.json().code,"OPERATION_NOT_FOUND");
      const before=f.reached.length;
      const wrong={...submit,runId:C_RUN};
      assert.equal((await f.inject(f.businessAuth,"POST","/api/orchestration/commands",wrong)).statusCode,403);
      assert.equal((await f.inject(f.businessAuth,"GET",`/api/projects/${P}/orchestration/operations/${id(91)}`)).statusCode,403);
      assert.equal(f.reached.length,before);
      if (state!=="active") {
        const create={...common,type:"task.create",taskId:id(55),title:"next",content:"body",acceptance:"done",owner:"builder",stageId:STAGE};
        assert.equal((await f.inject(f.cognitionAuth,"POST","/api/commands",create)).statusCode,403);
        const dispatch={...common,type:"dispatch.request",inboxId:INBOX,expectedInboxVersion:1,dispatchId:id(56),
          parentDispatchId:DISPATCH,taskId:TASK,expectedTaskVersion:1,recipientRoleId:"builder",purpose:"next",authorizationScopeId:"scope",reason:"next"};
        assert.equal((await f.inject(f.cognitionAuth,"POST","/api/orchestration/commands",dispatch)).statusCode,403);
        assert.equal(f.reached.length,before);
      }
    }
  } finally {await f.close();}
});

test("active cognition worker may create bounded work and request a child dispatch through parsed HTTP commands", async () => {
  const f=await fixture();
  try {
    const common={projectId:P,operationId:id(60)};
    const create={...common,type:"task.create",taskId:id(61),title:"Next task",content:"Fixed scope",acceptance:"Check outcome",owner:"builder",stageId:STAGE};
    const dispatch={...common,type:"dispatch.request",inboxId:INBOX,expectedInboxVersion:1,dispatchId:id(62),
      parentDispatchId:DISPATCH,taskId:TASK,expectedTaskVersion:1,recipientRoleId:"builder",purpose:"next",authorizationScopeId:"scope",reason:"Continue"};
    assert.equal((await f.inject(f.cognitionAuth,"POST","/api/commands",create)).statusCode,200);
    assert.equal((await f.inject(f.cognitionAuth,"POST","/api/orchestration/commands",dispatch)).statusCode,200);
    assert.deepEqual(f.reached,["business:task.create","orchestration:dispatch.request"]);
    const before=f.reached.length;
    assert.equal((await f.inject(f.cognitionAuth,"POST","/api/commands",{...create,owner:"admin"})).statusCode,403);
    assert.equal((await f.inject(f.cognitionAuth,"POST","/api/orchestration/commands",{...dispatch,parentDispatchId:id(63)})).statusCode,403);
    assert.equal(f.reached.length,before);
  } finally {await f.close();}
});

test("revocation and TTL expiration yield 401 before any service access", async () => {
  const f=await fixture();
  try {
    const before=f.reached.length;
    await f.broker.revoke(B_RUN);
    assert.equal((await f.inject(f.businessAuth,"GET","/api/session")).statusCode,401);
    assert.equal((await f.inject(f.cognitionAuth,"GET","/api/session")).statusCode,200);
    f.expire();
    assert.equal((await f.inject(f.cognitionAuth,"GET","/api/session")).statusCode,401);
    assert.equal(f.reached.length,before);
  } finally {await f.close();}
});
