import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import pg from "pg";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { OrchestrationService } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import { GitDocumentSource } from "@evoloop/adapter-git-documents";
import { decideTaskExternalReference, registerFixedGitReference } from "../../packages/core/src/references/index.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { WorkerCredentialBroker } from "../../apps/coordinator/src/workers/credentials.js";
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.js";
import { createWorkerSealer } from "../../apps/coordinator/src/orchestration/seal.js";
import { readTaskContext } from "../../apps/coordinator/src/orchestration/setup.js";


function withPersistedResumeProfile(runtime: RuntimeWorkflowService, uow: PostgresUnitOfWork): RuntimeWorkflowService {
  const bind = runtime.bindSession.bind(runtime);
  runtime.bindSession = async (projectId, sessionId, binding) => {
    const saved = await uow.read(projectId, reader => reader.getRuntimeSession(sessionId));
    const profile = saved?.executionProfile;
    if (!saved || !profile) throw new Error("fixture Session execution profile unavailable");
    return bind(projectId, sessionId, { ...binding, resumeProfile: { actorId: saved.actorId, model: saved.model,
      sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: profile.revision.revisionId } });
  };
  return runtime;
}
const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("worker CLI/HTTP test requires the isolated evoloop_journey_eval_test database");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const principal = (projectId: string, actorId: string) => ({actorId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">});

/** This binds fixture session and Run records; it never starts a native AppServer Turn. */
test("real wrapper, HTTP guard and PG facts admit fixed context and bounded cognitive work", async t => {
  const schema=`el_workercli_${randomUUID().replaceAll("-","").slice(0,16)}`;
  const directory=await mkdtemp(join(tmpdir(),"evoloop-worker-cli-http-"));
  await migrate(database!,schema);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  const uow=new PostgresUnitOfWork(pool);
  const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
  const runtime=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
  withPersistedResumeProfile(runtime,uow);
  const projectId=randomUUID(),loopId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),cognitiveTaskId=randomUUID();
  const cognitiveRole=fixtureRoleId("fixture-planner"),businessRole=fixtureRoleId("fixture-builder"),controller="fixture-controller";
  const cognitiveScope="fixture-cognition-scope",businessScope="fixture-business-scope";
  const ownerToken=randomUUID()+randomUUID();
  const gitRoot=join(directory,"git");
  const {mkdir}=await import("node:fs/promises");
  await mkdir(gitRoot);
  const git=(...args:string[])=>execFileSync("git",args,{cwd:gitRoot,encoding:"utf8"}).trim();
  git("init","-q");git("config","user.email","fixture@example.invalid");git("config","user.name","Fixture");
  const gitBody="# Fixed repository source\n";
  const wikiId=randomUUID(),wikiRevision=randomUUID(),wikiBody="# Fixed Wiki fixture\n";
  const wikiPage={projectId,id:wikiId,revision:wikiRevision,body:wikiBody,contentHash:hash(wikiBody),
    validity:"valid",observedValidity:"valid"};
  await writeFile(join(gitRoot,"formal.md"),gitBody);
  git("add","formal.md");git("commit","-qm","fixed source");
  const commit=git("rev-parse","HEAD");
  const gitSource=new GitDocumentSource([{projectId,repositoryId:"formal",root:gitRoot,
    allowedPaths:["formal.md","gap.md","later.md"]}],async()=>true);
  let broker:WorkerCredentialBroker;
  const store=new PgOrchestrationStore(pool,{
    getAuthorizationFact:async (project,scope)=>project===projectId && [cognitiveScope,businessScope].includes(scope) ?
      {projectId,scopeId:scope,actorId:controller,roleId:scope===cognitiveScope?cognitiveRole:businessRole,active:true}:null,
    canActAsRole:async (project,actor,role)=>project===projectId &&
      (actor===controller || (await broker.identityForActor(actor))?.scope.roleId===role),
    wasActorRole:async (project,actor,loop,role)=>project===projectId &&
      (await broker.identityForActor(actor))?.scope.loopId===loop && (await broker.identityForActor(actor))?.scope.roleId===role,
  });
  let orchestrationClock: string | null=null;
  const orchestration=new OrchestrationService({store,now:()=>orchestrationClock ?? new Date().toISOString(),nextId:randomUUID,hash,
    getWorkerScope:async actor=>(await broker.identityForActor(actor))?.scope ?? null,
    canReadDivisionMaterial:async(actor,documentId,revisionId)=>{
      const identity=await broker.identityForActor(actor);
      if(!identity)return false;
      const facts=workerGuardFacts(pool,identity);
      return await facts.fixedDocument(identity.scope.taskId,documentId,revisionId) ||
        await facts.sourceIssueDocumentRevision?.(documentId,revisionId)===true ||
        await facts.recoveryDocument?.(documentId,revisionId)===true;
    }});
  const app=await buildServer({service:workflow,credentials:[{token:ownerToken,actorId:controller,projectIds:[projectId],permissions:["read","write","review"]}],
    workers:{authenticate:header=>broker.authenticate(header),facts:identity=>workerGuardFacts(pool,identity)},
    orchestration:{service:orchestration},documents:{uow,blobsForPrincipal:async()=>({} as never)},
    references:{uow,gitForPrincipal:async()=>gitSource,
      knowledgeForPrincipal:async()=>({get:async()=>wikiPage} as never)},
    knowledge:{repositoryForPrincipal:async()=>({get:async()=>wikiPage} as never),blobsForPrincipal:async()=>({} as never)}});
  const apiUrl=await app.listen({host:"127.0.0.1",port:0});
  broker=new WorkerCredentialBroker({workerRoot:join(directory,"workers"),apiUrl,cliMain:resolve("apps/cli/dist/main.js"),
    nodeExecutable:process.execPath,ttlMs:10*60_000});
  t.after(async()=>{
    await app.close();await pool.end();await rm(directory,{recursive:true,force:true});
    const admin=new pg.Client({connectionString:database});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}
  });
  const owner=principal(projectId,controller);
  const issue=async (command:Record<string,unknown>)=>{
    const result=await workflow.execute(owner,{projectId,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result as Extract<typeof result,{status:"applied"}>;
  };
  const orchestrate=async (command:Record<string,unknown>)=>
    orchestration.execute(owner,{projectId,operationId:randomUUID(),...command} as never);
  async function cli(wrapper:string,args:string[],expected=0){
    const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
      const child=spawn(process.execPath,[wrapper,...args],{stdio:["ignore","pipe","pipe"],env:{...process.env}});
      let stdout="",stderr="";
      child.stdout.on("data",chunk=>{stdout+=String(chunk);});child.stderr.on("data",chunk=>{stderr+=String(chunk);});
      child.once("error",reject);child.once("close",code=>done({code,stdout,stderr}));
    });
    assert.equal(result.code,expected,`CLI ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout ? JSON.parse(result.stdout) as Record<string,any> : JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}");
  }
  async function workerCommand(wrapper:string,command:Record<string,unknown>,expected=0){
    const operationId=randomUUID(),file=join(directory,`${operationId}.json`);
    await writeFile(file,JSON.stringify({projectId,operationId,...command}),{mode:0o600});
    return cli(wrapper,["command","run",file],expected);
  }
  await issue({type:"project.create",title:"Isolated worker HTTP matrix"});
  await seedFixtureRole(pool,projectId,cognitiveRole,{templateKey:"cognition"});
  await seedFixtureRole(pool,projectId,businessRole);
  await issue({type:"goal.create",goalId,outcome:"Check one fixed source",constraints:"Fixture only",consumer:"owner",authority:"controller",scope:"isolated",owner:controller});
  await issue({type:"stage.propose",stageId,goalId,deliverable:"One bounded action",learningQuestion:"Can worker read and act?",reason:"Fixture stage"});
  await issue({type:"stage.accept",stageId,expectedVersion:1,reason:"Active fixture stage"});
  const basisId=randomUUID(),source="# Frozen basis\nExact original.";
  const basis=await issue({type:"document.create",documentId:basisId,title:"Frozen basis",body:source});
  await issue({type:"document.adopt",documentId:basisId,expectedVersion:1,revisionId:basis.revisionId,reason:"Fix source"});
  await issue({type:"task.create",taskId:cognitiveTaskId,stageId,title:"Review source",content:"# Decide next action",acceptance:"One signed result",
    owner:cognitiveRole,documentIds:[basisId],consumer:controller,evidence:"Fixture",stopCondition:"One decision"});
  await issue({type:"task.start",taskId:cognitiveTaskId,expectedVersion:1,basis:[{documentId:basisId,revisionId:basis.revisionId}],reason:"Freeze cognitive task"});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await orchestrate({type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognitiveRole,allowedBusinessRoleIds:[businessRole],
    sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},maxRuns:3,maxConcurrent:2,reason:"Isolated no-native matrix"});
  const loop=(await orchestration.getLoop(owner,projectId,loopId))!;
  const inbox=await orchestrate({type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Read bootstrap"});
  const dispatch=await orchestrate({type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,dispatchId:randomUUID(),
    parentDispatchId:null,taskId:cognitiveTaskId,expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",
    authorizationScopeId:cognitiveScope,reason:"Read bounded source"});
  const claimToken=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:dispatch.entityId,claimToken,leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:dispatch.entityId,claimToken});
  const sessionId=randomUUID(),runId=randomUUID(),input="Read fixed source and choose one next action";
  await issue({type:"runtime.session.reserve",sessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,sessionId);
  await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,roleId:cognitiveRole,
    cwd:directory,authorizationScope:cognitiveScope,nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
  const run=await issue({type:"runtime.run.reserve",runId,taskId:cognitiveTaskId,sessionId,expectedVersion:2,input});
  await orchestrate({type:"dispatch.resolve",dispatchId:dispatch.entityId,claimToken,result:"accepted",runtimeRunId:runId,reason:"Fixture bound Run; no native Turn"});
  const issued=await broker.issue({projectId,loopId,taskId:cognitiveTaskId,runId,sessionId,roleId:cognitiveRole,
    kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  const wrapper=issued.wrapperPath;
  assert.equal((await cli(wrapper,["session"])).principal.actorId,issued.principal.actorId);
  assert.equal((await cli(wrapper,["project",projectId])).id,projectId);
  assert.equal((await cli(wrapper,["read","goal",goalId])).id,goalId);
  assert.equal((await cli(wrapper,["read","stage",stageId])).id,stageId);
  const context=await cli(wrapper,["context",cognitiveTaskId]);
  assert.equal(context.status,"complete",JSON.stringify(context.failures));
  assert.equal(context.documents.some((item:{body:string})=>item.body===source),true);
  assert.equal((await cli(wrapper,["original",basisId,"--revision",basis.revisionId!])).body,source);
  const linkedTodoId=randomUUID(),linkedDocumentId=randomUUID(),linkedBody="# Adopted input for a todo task";
  const linkedDocument=await issue({type:"document.create",documentId:linkedDocumentId,kind:"report",title:"Linked input",body:linkedBody});
  await issue({type:"document.publish",documentId:linkedDocumentId,expectedVersion:1,revisionId:linkedDocument.revisionId,reason:"Fix input"});
  await issue({type:"task.create",taskId:linkedTodoId,stageId,title:"Linked todo",content:"# Before start",acceptance:"Read source",
    owner:businessRole,documentIds:[linkedDocumentId],consumer:"fixture",evidence:"Linked source",stopCondition:"Read once"});
  assert.equal((await cli(wrapper,["original",linkedDocumentId,"--revision",linkedDocument.revisionId!])).body,linkedBody);
  const linkedLater=await issue({type:"document.revise",documentId:linkedDocumentId,expectedVersion:2,
    body:"# Later linked content",reason:"Owner changed source after cognition observed it"});
  assert.equal((await cli(wrapper,["document",linkedDocumentId],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["get",`/api/projects/${projectId}/documents/${linkedDocumentId}/revisions`],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(wrapper,["original",linkedDocumentId,"--revision",linkedDocument.revisionId!])).body,
    linkedBody);
  assert.equal((await cli(wrapper,["original",linkedDocumentId,"--revision",linkedLater.revisionId!],1)).error?.code,
    "FORBIDDEN");
  const unadoptedId=randomUUID(),unadopted=await issue({type:"document.create",documentId:unadoptedId,title:"Draft input",body:"# Draft"});
  await issue({type:"task.create",taskId:randomUUID(),stageId,title:"Draft linked todo",content:"# Before start",acceptance:"Read",
    owner:businessRole,documentIds:[unadoptedId],consumer:"fixture",evidence:"Draft source",stopCondition:"Read once"});
  assert.equal((await cli(wrapper,["original",unadoptedId,"--revision",unadopted.revisionId!],1)).error?.code,"FORBIDDEN");
  const outsideGoalId=randomUUID(),outsideStageId=randomUUID(),outsideDocumentId=randomUUID();
  await issue({type:"goal.create",goalId:outsideGoalId,outcome:"Separate goal",constraints:"Fixture only",
    consumer:"owner",authority:"controller",scope:"isolated",owner:controller});
  await issue({type:"stage.propose",stageId:outsideStageId,goalId:outsideGoalId,deliverable:"Separate work",
    learningQuestion:"Should scope isolate?",reason:"Outside loop"});
  await issue({type:"stage.accept",stageId:outsideStageId,expectedVersion:1,reason:"Active outside stage"});
  const outsideDocument=await issue({type:"document.create",documentId:outsideDocumentId,kind:"report",
    title:"Outside goal report",body:"# Outside"});
  await issue({type:"document.publish",documentId:outsideDocumentId,expectedVersion:1,
    revisionId:outsideDocument.revisionId,reason:"Fixed outside source"});
  await issue({type:"task.create",taskId:randomUUID(),stageId:outsideStageId,title:"Outside goal task",content:"# Outside",
    acceptance:"Read",owner:businessRole,documentIds:[outsideDocumentId],consumer:"fixture",evidence:"Outside",
    stopCondition:"Once"});
  assert.equal((await cli(wrapper,["original",outsideDocumentId,"--revision",outsideDocument.revisionId!],1)).error?.code,
    "FORBIDDEN");
  const reportId=randomUUID();
  const reportCreated=await workerCommand(wrapper,{type:"document.create",documentId:reportId,kind:"report",title:"Worker report",body:"# Worker evidence",origin:{taskId:cognitiveTaskId,runId}});
  const reportRevisionId=reportCreated.revisionId as string;
  assert.ok(reportRevisionId);
  assert.equal((await cli(wrapper,["document",reportId,"--revision",reportRevisionId])).body,"# Worker evidence");
  assert.equal((await cli(wrapper,["original",reportId,"--revision",reportRevisionId])).body,"# Worker evidence");
  const childTaskId=randomUUID();
  await workerCommand(wrapper,{type:"task.create",taskId:childTaskId,stageId,title:"Bounded child action",content:"# Next",
    acceptance:"One check",owner:businessRole,consumer:controller,evidence:"Source reviewed",stopCondition:"One action"});
  assert.equal((await cli(wrapper,["task",childTaskId])).task.id,childTaskId);
  await issue({type:"task.start",taskId:childTaskId,expectedVersion:1,reason:"Fixture seals child scope before dispatch"});
  const fixedRun=await cli(wrapper,["read","run",runId]);
  assert.equal(fixedRun.id,runId);
  assert.equal(fixedRun.inputHash,hash(input));
  assert.equal(fixedRun.taskRevisionId,run.revisionId);
  const nextInbox=await workerCommand(wrapper,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,
    recipientRoleId:cognitiveRole,purpose:"next_action"});
  assert.ok(nextInbox.entityId);
  await workerCommand(wrapper,{type:"inbox.ack",inboxId:nextInbox.entityId,expectedVersion:1,reason:"Reviewed fixed source"});
  const childDispatch=await workerCommand(wrapper,{type:"dispatch.request",inboxId:nextInbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:dispatch.entityId,taskId:childTaskId,expectedTaskVersion:2,
    recipientRoleId:businessRole,purpose:"Execute bounded next action",authorizationScopeId:businessScope,reason:"Source reviewed"});
  assert.equal((await cli(wrapper,["read","dispatch",childDispatch.entityId])).taskId,childTaskId);
  const paused=(await orchestration.getLoop(owner,projectId,loopId))!;
  await orchestrate({type:"loop.state",loopId,expectedVersion:paused.version,state:"paused",reason:"No new dispatch; existing Run may finish"});
  const submissionId=randomUUID(),deliveryOperationId=randomUUID();
  const submitted=await workerCommand(wrapper,{type:"worker.submit",submissionId,dispatchId:dispatch.entityId,runId,
    taskRevisionId:run.revisionId,runInputHash:hash(input),deliveryOperationId,
    deliveryIntent:{artifactRef:"fixture:review-report",artifactRevision:"v1",contentHash:hash("review-report"),
      technicalResult:"passed",technicalEvidence:"Fixture evidence; no native execution",reason:"Signed preterminal intention"},
    agentObservation:"Source inspected in CLI fixture",evidenceRefs:[]});
  assert.equal(submitted.entityId,submissionId);
  const terminal=await runtime.rejectDispatch(projectId,runId,"Fixture terminal state; no native Turn was started");
  assert.equal(terminal.state,"failed");
  assert.equal((await cli(wrapper,["read","run",runId])).state,"failed");
  assert.equal((await cli(wrapper,["read","submission",submissionId])).submittedBy,issued.principal.actorId);
  const signedOperation=await cli(wrapper,["get",`/api/projects/${projectId}/orchestration/operations/${submitted.operationId}`]);
  assert.equal(signedOperation.actorId,issued.principal.actorId);
  const otherOp=randomUUID();
  await issue({type:"document.create",documentId:randomUUID(),kind:"report",title:"Owner report",body:"# Owner" ,operationId:otherOp});
  assert.equal((await cli(wrapper,["operation",otherOp],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["read","run",runId])).id,runId);
  assert.equal((await cli(wrapper,["read","submission",submissionId])).id,submissionId);
  assert.equal((await cli(wrapper,["task",childTaskId])).task.id,childTaskId);
  assert.equal((await cli(wrapper,["get",`/api/projects/${projectId}/orchestration/operations/${submitted.operationId}`])).actorId,issued.principal.actorId);
  assert.equal((await workerCommand(wrapper,{type:"task.create",taskId:randomUUID(),stageId,title:"After pause",content:"# Stop",
    acceptance:"None",owner:businessRole},1)).error?.code,"FORBIDDEN");
  assert.equal((await workerCommand(wrapper,{type:"dispatch.request",inboxId:nextInbox.entityId,expectedInboxVersion:3,
    dispatchId:randomUUID(),parentDispatchId:dispatch.entityId,taskId:childTaskId,expectedTaskVersion:2,
    recipientRoleId:businessRole,purpose:"Forbidden new dispatch",authorizationScopeId:businessScope,reason:"paused"},1)).error?.code,"FORBIDDEN");
  const sealer=createWorkerSealer({workflow,orchestration,credential:broker,controller:()=>owner,now:()=>new Date().toISOString()});
  const cognitiveDispatch=(await orchestration.getDispatch(owner,projectId,dispatch.entityId))!;
  const settled=await sealer(cognitiveDispatch,terminal);
  assert.equal(settled.status,"sealed",JSON.stringify(settled));
  await orchestrate({type:"worker.outcome",dispatchId:dispatch.entityId,outcome:"delivered",deliveryId:settled.deliveryId,
    decisionId:null,evidenceRef:"fixture:sealed",reason:"Fixture cognitive report sealed; no native Turn"});
  const pausedLoop=(await orchestration.getLoop(owner,projectId,loopId))!;
  await orchestrate({type:"loop.state",loopId,expectedVersion:pausedLoop.version,state:"active",reason:"Continue isolated business credential check"});
  const businessClaim=randomUUID(),businessSessionId=randomUUID(),businessRunId=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:childDispatch.entityId,claimToken:businessClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:childDispatch.entityId,claimToken:businessClaim});
  await issue({type:"runtime.session.reserve",sessionId:businessSessionId,roleId:businessRole,cwd:directory,authorizationScope:businessScope,
    model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,businessSessionId);
  await runtime.bindSession(projectId,businessSessionId,{owner:"evoloop-codex-app-server",projectId,sessionId:businessSessionId,
    roleId:businessRole,cwd:directory,authorizationScope:businessScope,nativeThreadId:`fixture-${businessSessionId}`,
    nativeSessionId:`fixture-${businessSessionId}`});
  const businessInput="Inspect bounded child; this test starts no native Turn";
  const businessRun=await issue({type:"runtime.run.reserve",runId:businessRunId,taskId:childTaskId,sessionId:businessSessionId,
    expectedVersion:2,input:businessInput});
  await orchestrate({type:"dispatch.resolve",dispatchId:childDispatch.entityId,claimToken:businessClaim,
    result:"accepted",runtimeRunId:businessRunId,reason:"Fixture business Run bound"});
  const businessWorker=await broker.issue({projectId,loopId,taskId:childTaskId,runId:businessRunId,sessionId:businessSessionId,
    roleId:businessRole,kind:"business",allowedRoleIds:[businessRole]});
  const businessWrapper=businessWorker.wrapperPath;
  assert.equal((await cli(businessWrapper,["session"])).principal.actorId,businessWorker.principal.actorId);
  assert.equal((await cli(businessWrapper,["context",childTaskId])).status,"complete");
  assert.equal((await cli(businessWrapper,["read","run",businessRunId])).taskId,childTaskId);
  assert.equal((await cli(businessWrapper,["task",cognitiveTaskId],1)).error?.code,"FORBIDDEN");
  assert.equal((await workerCommand(businessWrapper,{type:"task.create",taskId:randomUUID(),stageId,title:"Forbidden",
    content:"# No",acceptance:"No",owner:businessRole},1)).error?.code,"FORBIDDEN");
  const businessReportId=randomUUID(),businessReportBody="# Business delivery report\nFixed facts.";
  const businessReportCreated=await workerCommand(businessWrapper,{type:"document.create",documentId:businessReportId,kind:"report",
    title:"Business delivery report",body:businessReportBody,origin:{taskId:childTaskId,runId:businessRunId}});
  const businessReportRevisionId=businessReportCreated.revisionId as string;
  assert.ok(businessReportRevisionId);
  assert.equal((await cli(businessWrapper,["document",businessReportId,"--revision",businessReportRevisionId])).body,
    businessReportBody);
  const businessSubmissionId=randomUUID();
  assert.equal((await workerCommand(businessWrapper,{type:"worker.submit",submissionId:businessSubmissionId,
    dispatchId:childDispatch.entityId,runId:businessRunId,taskRevisionId:businessRun.revisionId,
    runInputHash:hash(businessInput),deliveryOperationId:randomUUID(),
    deliveryIntent:{artifactRef:`#/p/${projectId}/documents/${businessReportId}?revision=${businessReportRevisionId}`,
      artifactRevision:businessReportRevisionId,contentHash:hash(businessReportBody),technicalResult:"passed",
      technicalEvidence:"Fixture report was written through worker CLI",reason:"Fixed report delivered"},
    agentObservation:"Fixture report recorded; no native execution",evidenceRefs:[]})).entityId,businessSubmissionId);
  const businessTerminal=await runtime.rejectDispatch(projectId,businessRunId,"Fixture terminal; no native Turn");
  const businessSealed=await sealer((await orchestration.getDispatch(owner,projectId,childDispatch.entityId))!,businessTerminal);
  assert.equal(businessSealed.status,"sealed",JSON.stringify(businessSealed));
  await orchestrate({type:"worker.outcome",dispatchId:childDispatch.entityId,outcome:"delivered",
    deliveryId:businessSealed.deliveryId,decisionId:null,evidenceRef:"fixture:business-report",reason:"Signed report sealed"});
  const observationLoopId=randomUUID(),observationTaskId=randomUUID();
  await issue({type:"task.create",taskId:observationTaskId,stageId,title:"Review independent feedback",
    content:"# Consumer feedback",acceptance:"Read fixed observation",owner:cognitiveRole,kind:"research",
    consumer:cognitiveRole,useRequired:false,evidence:"Independent observation",stopCondition:"One check"});
  await issue({type:"task.start",taskId:observationTaskId,expectedVersion:1,reason:"Fix observation review"});
  const observationCursor=(await pool.query(`SELECT created_at,event_id FROM outbox_event WHERE project_id=$1
    ORDER BY created_at DESC,event_id DESC LIMIT 1`,[projectId])).rows[0];
  await orchestrate({type:"loop.enroll",loopId:observationLoopId,goalId,stageId,cognitiveRoleId:cognitiveRole,
    allowedBusinessRoleIds:[businessRole],sourceAfter:{createdAtUtc:observationCursor.created_at.toISOString(),
      eventId:observationCursor.event_id},maxRuns:4,maxConcurrent:1,reason:"Independent feedback fixture"});
  const observationOperationId=randomUUID();
  await issue({type:"observation.record",operationId:observationOperationId,taskId:childTaskId,
    deliveryId:businessSealed.deliveryId,observer:controller,observerKind:"agent",result:"notUsed",
    evidence:"Fixture observer read formal report but did not claim use",reason:"Independent source for review"});
  const observationEvent=(await pool.query(`SELECT event_id FROM outbox_event WHERE project_id=$1
    AND operation_id=$2 AND kind='observation.record'`,[projectId,observationOperationId])).rows[0];
  assert.ok(observationEvent?.event_id);
  const observationInbox=await orchestrate({type:"inbox.accept",loopId:observationLoopId,
    sourceEventId:observationEvent.event_id,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:observationInbox.entityId,expectedVersion:1,
    reason:"Read independent feedback"});
  const observationDispatch=await orchestrate({type:"dispatch.request",inboxId:observationInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:observationTaskId,
    expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",
    authorizationScopeId:cognitiveScope,reason:"Review observed use boundary"});
  const observationClaim=randomUUID(),observationSessionId=randomUUID(),observationRunId=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:observationDispatch.entityId,claimToken:observationClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:observationDispatch.entityId,claimToken:observationClaim});
  await issue({type:"runtime.session.reserve",sessionId:observationSessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,observationSessionId);
  await runtime.bindSession(projectId,observationSessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:observationSessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${observationSessionId}`,nativeSessionId:`fixture-${observationSessionId}`});
  await issue({type:"runtime.run.reserve",runId:observationRunId,taskId:observationTaskId,
    sessionId:observationSessionId,expectedVersion:2,input:"Fixture observation review; no native Turn"});
  await orchestrate({type:"dispatch.resolve",dispatchId:observationDispatch.entityId,claimToken:observationClaim,
    result:"accepted",runtimeRunId:observationRunId,reason:"Fixture observed cognition bound"});
  await runtime.rejectDispatch(projectId,observationRunId,"Fixture terminal with no signed intent");
  const observationBeforeGap=(await orchestration.getDispatch(owner,projectId,observationDispatch.entityId))!;
  await orchestrate({type:"dispatch.gap",dispatchId:observationDispatch.entityId,
    expectedVersion:observationBeforeGap.version,reason:"Observed cognition credential expired",evidenceRef:null});
  const observationGap=(await pool.query(`SELECT event_id FROM orchestration_event WHERE project_id=$1
    AND loop_id=$2 AND entity_id=$3 AND kind='dispatch.gap' ORDER BY created_at_utc DESC LIMIT 1`,
  [projectId,observationLoopId,observationDispatch.entityId])).rows[0];
  assert.ok(observationGap?.event_id);
  const observationRecoveryTaskId=randomUUID();
  await issue({type:"task.create",taskId:observationRecoveryTaskId,stageId,title:"Recover observed cognition",
    content:"# Read the fixed gap",acceptance:"One bounded recovery",owner:cognitiveRole,kind:"research",
    consumer:cognitiveRole,useRequired:false,evidence:"Formal terminal gap",stopCondition:"One check"});
  await issue({type:"task.start",taskId:observationRecoveryTaskId,expectedVersion:1,reason:"Fix recovery scope"});
  const observationRecoveryInbox=await orchestrate({type:"inbox.accept",loopId:observationLoopId,
    sourceEventId:observationGap.event_id,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:observationRecoveryInbox.entityId,expectedVersion:1,
    reason:"Read exact terminal gap"});
  const observationRecoveryDispatch=await orchestrate({type:"dispatch.request",inboxId:observationRecoveryInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:observationRecoveryTaskId,
    expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",
    authorizationScopeId:cognitiveScope,reason:"Recover from formal gap source"});
  const unrelatedTaskId=randomUUID(),unrelatedObservationOperationId=randomUUID();
  await issue({type:"task.create",taskId:unrelatedTaskId,stageId,title:"Review separate feedback",
    content:"# Separate observation",acceptance:"Separate check",owner:cognitiveRole,kind:"research",
    consumer:cognitiveRole,useRequired:false,evidence:"Different Task",stopCondition:"One check"});
  await issue({type:"task.start",taskId:unrelatedTaskId,expectedVersion:1,reason:"Fix separate scope"});
  await issue({type:"observation.record",operationId:unrelatedObservationOperationId,taskId:cognitiveTaskId,
    deliveryId:settled.deliveryId,observer:controller,observerKind:"agent",result:"notUsed",
    evidence:"Separate cognitive report observation",reason:"Unrelated source in the same Loop"});
  const unrelatedObservation=(await pool.query(`SELECT event_id FROM outbox_event WHERE project_id=$1
    AND operation_id=$2 AND kind='observation.record'`,[projectId,unrelatedObservationOperationId])).rows[0];
  assert.ok(unrelatedObservation?.event_id);
  const unrelatedInbox=await orchestrate({type:"inbox.accept",loopId:observationLoopId,
    sourceEventId:unrelatedObservation.event_id,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:unrelatedInbox.entityId,expectedVersion:1,
    reason:"Read separate feedback"});
  const unrelatedDispatch=await orchestrate({type:"dispatch.request",inboxId:unrelatedInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:unrelatedTaskId,
    expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",
    authorizationScopeId:cognitiveScope,reason:"Separate same-Loop work"});
  const continuationTaskId=randomUUID(),continuationRunId=randomUUID(),continuationSessionId=randomUUID();
  await issue({type:"task.create",taskId:continuationTaskId,stageId,title:"Review business report",content:"# Read fixed delivery",
    acceptance:"Confirm exact report original",owner:cognitiveRole,consumer:"fixture",evidence:"Business report",
    stopCondition:"One exact read"});
  await issue({type:"task.start",taskId:continuationTaskId,expectedVersion:1,reason:"Fix continuation scope"});
  const feedbackEvent=(await pool.query(`SELECT event_id FROM orchestration_event WHERE project_id=$1 AND loop_id=$2
    AND entity_id=$3 AND kind='worker.outcome' ORDER BY created_at_utc DESC LIMIT 1`,[projectId,loopId,childDispatch.entityId])).rows[0];
  assert.ok(feedbackEvent?.event_id);
  const continuationInbox=await orchestrate({type:"inbox.accept",loopId,sourceEventId:feedbackEvent.event_id,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:continuationInbox.entityId,expectedVersion:1,reason:"Read business feedback"});
  const continuationDispatch=await orchestrate({type:"dispatch.request",inboxId:continuationInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:continuationTaskId,
    expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,
    reason:"Continue after formal business delivery"});
  const continuationClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:continuationDispatch.entityId,claimToken:continuationClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:continuationDispatch.entityId,claimToken:continuationClaim});
  await issue({type:"runtime.session.reserve",sessionId:continuationSessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,continuationSessionId);
  await runtime.bindSession(projectId,continuationSessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:continuationSessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${continuationSessionId}`,nativeSessionId:`fixture-${continuationSessionId}`});
  await issue({type:"runtime.run.reserve",runId:continuationRunId,taskId:continuationTaskId,
    sessionId:continuationSessionId,expectedVersion:2,input:"Read prior business delivery; no native Turn"});
  await orchestrate({type:"dispatch.resolve",dispatchId:continuationDispatch.entityId,claimToken:continuationClaim,
    result:"accepted",runtimeRunId:continuationRunId,reason:"Fixture continuation Run bound"});
  const continuationWorker=await broker.issue({projectId,loopId,taskId:continuationTaskId,runId:continuationRunId,
    sessionId:continuationSessionId,roleId:cognitiveRole,kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  const businessContext=await readTaskContext(pool,workflow,owner,projectId,childTaskId,50);
  const sameLoopContext=businessContext.items.find(item=>item.loopId===loopId);
  assert.ok(sameLoopContext?.sourceEventIds.includes(feedbackEvent.event_id),"business outcome source is retained");
  assert.ok(sameLoopContext.dispatchIds.includes(childDispatch.entityId));
  assert.ok(sameLoopContext.dispatchIds.includes(continuationDispatch.entityId),"next cognition is related by outcome, not parentDispatch");
  const independentContext=businessContext.items.find(item=>item.loopId===observationLoopId);
  assert.ok(independentContext?.sourceEventIds.includes(observationEvent.event_id),"applied observation source is retained");
  assert.ok(independentContext.dispatchIds.includes(observationDispatch.entityId),"independent observation cognition is related without parentDispatch");
  assert.ok(independentContext.sourceEventIds.includes(observationGap.event_id),"formal terminal gap is retained downstream");
  assert.ok(independentContext.dispatchIds.includes(observationRecoveryDispatch.entityId),"gap recovery cognition is reached through the observed cognition");
  assert.equal(independentContext.dispatchIds.includes(unrelatedDispatch.entityId),false,
    "another same-Loop observation does not pull in an unrelated Task");
  assert.equal(independentContext.sourceEventIds.includes(unrelatedObservation.event_id),false,
    "unrelated same-Loop source is not part of this Task story");
  await runtime.rejectDispatch(projectId,continuationRunId,"Fixture terminal with no worker intent");
  const beforeGap=(await orchestration.getDispatch(owner,projectId,continuationDispatch.entityId))!;
  await orchestrate({type:"dispatch.gap",dispatchId:continuationDispatch.entityId,
    expectedVersion:beforeGap.version,reason:"Fixture worker credential expired before signed intent",evidenceRef:null});
  const gapEvent=(await pool.query(`SELECT event_id FROM orchestration_event WHERE project_id=$1 AND loop_id=$2
    AND entity_id=$3 AND kind='dispatch.gap' ORDER BY created_at_utc DESC LIMIT 1`,
  [projectId,loopId,continuationDispatch.entityId])).rows[0];
  assert.ok(gapEvent?.event_id);
  const gapContext=await readTaskContext(pool,workflow,owner,projectId,continuationTaskId,50);
  assert.ok(gapContext.items.find(item=>item.loopId===loopId)?.sourceEventIds.includes(gapEvent.event_id),
    "terminal intent gap is a real downstream source even without a delivered outcome");
  assert.notEqual(continuationWorker.principal.actorId,businessWorker.principal.actorId);
  const childBeforeMove=(await workflow.getTask(owner,projectId,childTaskId)).task;
  await issue({type:"task.reopen",taskId:childTaskId,expectedVersion:childBeforeMove.version,
    reason:"Historical scope fixture: move current Task after sealed Delivery"});
  const childReopened=(await workflow.getTask(owner,projectId,childTaskId)).task;
  await issue({type:"task.update",taskId:childTaskId,expectedVersion:childReopened.version,
    title:childReopened.title,content:childReopened.content,acceptance:childReopened.acceptance,
    owner:childReopened.owner,stageId:outsideStageId,reason:"Current Task now belongs to another Goal"});
  const newGoalLinkId=randomUUID(),newGoalLink=await issue({type:"document.create",documentId:newGoalLinkId,
    kind:"report",title:"Only current new Goal link",body:"# New Goal only"});
  await issue({type:"document.publish",documentId:newGoalLinkId,expectedVersion:1,
    revisionId:newGoalLink.revisionId,reason:"Publish new Goal source"});
  const childInNewGoal=(await workflow.getTask(owner,projectId,childTaskId)).task;
  await issue({type:"task.update",taskId:childTaskId,expectedVersion:childInNewGoal.version,
    title:childInNewGoal.title,content:childInNewGoal.content,acceptance:childInNewGoal.acceptance,
    owner:childInNewGoal.owner,documentIds:[newGoalLinkId],reason:"Link only after Goal move"});
  assert.equal((await cli(continuationWorker.wrapperPath,["task",childTaskId],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(continuationWorker.wrapperPath,["original",newGoalLinkId,"--revision",newGoalLink.revisionId!],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(continuationWorker.wrapperPath,["original",businessReportId,"--revision",businessReportRevisionId])).body,
    businessReportBody);
  const newGoalLoopId=randomUUID(),newGoalTaskId=randomUUID(),newGoalSessionId=randomUUID(),newGoalRunId=randomUUID();
  await issue({type:"task.create",taskId:newGoalTaskId,stageId:outsideStageId,title:"New Goal cognition",
    content:"# Review only new Goal",acceptance:"Do not inherit old Loop report",owner:cognitiveRole,
    consumer:"fixture",evidence:"Current new Goal Task",stopCondition:"One scope check"});
  await issue({type:"task.start",taskId:newGoalTaskId,expectedVersion:1,reason:"Fix new Goal cognition"});
  const newGoalCursor=(await pool.query(`SELECT created_at,event_id FROM outbox_event WHERE project_id=$1
    ORDER BY created_at DESC,event_id DESC LIMIT 1`,[projectId])).rows[0];
  await orchestrate({type:"loop.enroll",loopId:newGoalLoopId,goalId:outsideGoalId,stageId:outsideStageId,
    cognitiveRoleId:cognitiveRole,allowedBusinessRoleIds:[businessRole],
    sourceAfter:{createdAtUtc:newGoalCursor.created_at.toISOString(),eventId:newGoalCursor.event_id},
    maxRuns:1,maxConcurrent:1,reason:"Isolated new Goal scope"});
  const newGoalLoop=(await orchestration.getLoop(owner,projectId,newGoalLoopId))!;
  const newGoalInbox=await orchestrate({type:"inbox.accept",loopId:newGoalLoopId,
    sourceEventId:newGoalLoop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:newGoalInbox.entityId,expectedVersion:1,reason:"Read new Goal seed"});
  const newGoalDispatch=await orchestrate({type:"dispatch.request",inboxId:newGoalInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:newGoalTaskId,
    expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,
    reason:"Read only new Goal"});
  const newGoalClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:newGoalDispatch.entityId,claimToken:newGoalClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:newGoalDispatch.entityId,claimToken:newGoalClaim});
  await issue({type:"runtime.session.reserve",sessionId:newGoalSessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,newGoalSessionId);
  await runtime.bindSession(projectId,newGoalSessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:newGoalSessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${newGoalSessionId}`,nativeSessionId:`fixture-${newGoalSessionId}`});
  await issue({type:"runtime.run.reserve",runId:newGoalRunId,taskId:newGoalTaskId,
    sessionId:newGoalSessionId,expectedVersion:2,input:"Check new Goal scope; no native Turn"});
  await orchestrate({type:"dispatch.resolve",dispatchId:newGoalDispatch.entityId,claimToken:newGoalClaim,
    result:"accepted",runtimeRunId:newGoalRunId,reason:"New Goal fixture Run bound"});
  const newGoalWorker=await broker.issue({projectId,loopId:newGoalLoopId,taskId:newGoalTaskId,
    runId:newGoalRunId,sessionId:newGoalSessionId,roleId:cognitiveRole,
    kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  assert.equal((await cli(newGoalWorker.wrapperPath,["task",childTaskId])).task.id,childTaskId);
  assert.equal((await cli(newGoalWorker.wrapperPath,["original",newGoalLinkId,"--revision",newGoalLink.revisionId!])).body,
    "# New Goal only");
  assert.equal((await cli(newGoalWorker.wrapperPath,["original",businessReportId,"--revision",businessReportRevisionId],1)).error?.code,
    "FORBIDDEN");
  const revisedReport=await issue({type:"document.revise",documentId:businessReportId,expectedVersion:1,
    body:"# Later report revision",reason:"Different bytes after fixed delivery"});
  assert.equal((await cli(businessWrapper,["document",businessReportId],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(businessWrapper,["get",`/api/projects/${projectId}/documents/${businessReportId}/revisions`],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(businessWrapper,["original",businessReportId,"--revision",businessReportRevisionId])).body,
    businessReportBody);
  assert.equal((await cli(continuationWorker.wrapperPath,["document",businessReportId],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(continuationWorker.wrapperPath,["get",`/api/projects/${projectId}/documents/${businessReportId}/revisions`],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(continuationWorker.wrapperPath,["original",businessReportId,"--revision",businessReportRevisionId])).body,
    businessReportBody);
  assert.equal((await cli(continuationWorker.wrapperPath,["original",businessReportId,"--revision",revisedReport.revisionId!],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(continuationWorker.wrapperPath,["original",reportId,"--revision",reportRevisionId],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(businessWrapper,["original",businessReportId,"--revision",revisedReport.revisionId!],1)).error?.code,
    "FORBIDDEN");
  const mismatchedId=randomUUID(),mismatchedBody="# Hash does not match Delivery";
  const mismatchedDocument=await issue({type:"document.create",documentId:mismatchedId,kind:"report",
    title:"Mismatched delivered report",body:mismatchedBody});
  const childBeforeRestart=(await workflow.getTask(owner,projectId,childTaskId)).task;
  await issue({type:"task.start",taskId:childTaskId,expectedVersion:childBeforeRestart.version,
    basis:[{documentId:newGoalLinkId,revisionId:newGoalLink.revisionId}],reason:"Start current new Goal scope"});
  const childBeforeMismatch=(await workflow.getTask(owner,projectId,childTaskId)).task;
  await issue({type:"delivery.record",taskId:childTaskId,expectedVersion:childBeforeMismatch.version,
    artifactRef:`#/p/${projectId}/documents/${mismatchedId}?revision=${mismatchedDocument.revisionId}`,
    artifactRevision:mismatchedDocument.revisionId,contentHash:hash("wrong bytes"),technicalResult:"passed",
    technicalEvidence:"Isolated negative fixture",reason:"Incorrect hash must not authorize read"});
  assert.equal((await cli(continuationWorker.wrapperPath,["original",mismatchedId,"--revision",mismatchedDocument.revisionId!],1)).error?.code,
    "FORBIDDEN");
  // A separate accepted Run records a signed decision instead of a submission.
  const secondLoopId=randomUUID(),secondSessionId=randomUUID(),secondRunId=randomUUID(),secondTaskId=randomUUID();
  await issue({type:"task.create",taskId:secondTaskId,stageId,title:"Independent decision",content:"# Decide whether to wait",
    acceptance:"One signed waiting reason",owner:cognitiveRole,kind:"research",consumer:cognitiveRole,
    useRequired:false,evidence:"Fixture",stopCondition:"One decision"});
  await issue({type:"task.start",taskId:secondTaskId,expectedVersion:1,reason:"Freeze second fixture"});
  const gitRefId=randomUUID();
  const observedGit=new Map<string,{revision:string;body:string}>([[gitRefId,{revision:commit,body:gitBody}]]);
  const deps={uow,git:gitSource,hashText:hash,nextId:randomUUID,now:()=>new Date().toISOString(),
    observeExternal:async (_actor:unknown,_project:string,kind:"git"|"wiki",referenceId:string)=>({status:"reachable" as const,
      revision:kind==="git"?observedGit.get(referenceId)?.revision??"":wikiRevision,
      contentHash:kind==="git"?hash(observedGit.get(referenceId)?.body??""):hash(wikiBody),
      currentRevision:kind==="git"?observedGit.get(referenceId)?.revision??"":wikiRevision,
      currentHash:kind==="git"?hash(observedGit.get(referenceId)?.body??""):hash(wikiBody),
      currentValidity:"valid" as const})};
  const registered=await registerFixedGitReference(deps,owner,{projectId,operationId:randomUUID(),actorId:controller,
    referenceId:gitRefId,repositoryId:"formal",path:"formal.md",commit,contentHash:hash(gitBody)});
  assert.equal(registered.status,"applied");
  const beforeReference=(await workflow.getTask(owner,projectId,secondTaskId)).task;
  const adopted=await decideTaskExternalReference(deps,owner,{projectId,operationId:randomUUID(),actorId:controller,
    decisionId:randomUUID(),taskId:secondTaskId,taskRevisionId:beforeReference.currentRevisionId,expectedTaskVersion:beforeReference.version,
    slotId:randomUUID(),expectedHeadVersion:0,decision:"adopt",kind:"git",referenceId:gitRefId,
    revision:commit,contentHash:hash(gitBody),reason:"Read exact Git source",actionImpact:"Check fixed bytes"});
  assert.equal(adopted.status,"applied",JSON.stringify(adopted));
  const beforeWiki=(await workflow.getTask(owner,projectId,secondTaskId)).task;
  const wikiAdopted=await decideTaskExternalReference(deps,owner,{projectId,operationId:randomUUID(),actorId:controller,
    decisionId:randomUUID(),taskId:secondTaskId,taskRevisionId:beforeWiki.currentRevisionId,expectedTaskVersion:beforeWiki.version,
    slotId:randomUUID(),expectedHeadVersion:0,decision:"adopt",kind:"wiki",referenceId:wikiId,
    revision:wikiRevision,contentHash:hash(wikiBody),reason:"Read exact Wiki fixture",actionImpact:"Check fixed body"});
  assert.equal(wikiAdopted.status,"applied",JSON.stringify(wikiAdopted));
  const secondTask=(await workflow.getTask(owner,projectId,secondTaskId)).task;
  const afterFirst=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await orchestrate({type:"loop.enroll",loopId:secondLoopId,goalId,stageId,cognitiveRoleId:cognitiveRole,allowedBusinessRoleIds:[businessRole],
    sourceAfter:{createdAtUtc:afterFirst.created_at.toISOString(),eventId:afterFirst.event_id},maxRuns:2,maxConcurrent:1,reason:"Separate decision fixture"});
  const secondLoop=(await orchestration.getLoop(owner,projectId,secondLoopId))!;
  const secondInbox=await orchestrate({type:"inbox.accept",loopId:secondLoopId,sourceEventId:secondLoop.bootstrapEventId,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:secondInbox.entityId,expectedVersion:1,reason:"Second source"});
  const secondDispatch=await orchestrate({type:"dispatch.request",inboxId:secondInbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:secondTaskId,expectedTaskVersion:secondTask.version,
    recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,reason:"Independent decision path"});
  const secondClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:secondDispatch.entityId,claimToken:secondClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:secondDispatch.entityId,claimToken:secondClaim});
  await issue({type:"runtime.session.reserve",sessionId:secondSessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,secondSessionId);
  await runtime.bindSession(projectId,secondSessionId,{owner:"evoloop-codex-app-server",projectId,sessionId:secondSessionId,
    roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,nativeThreadId:`fixture-${secondSessionId}`,nativeSessionId:`fixture-${secondSessionId}`});
  await issue({type:"runtime.run.reserve",runId:secondRunId,taskId:secondTaskId,sessionId:secondSessionId,
    expectedVersion:secondTask.version,input:"Record one waiting decision"});
  await orchestrate({type:"dispatch.resolve",dispatchId:secondDispatch.entityId,claimToken:secondClaim,result:"accepted",
    runtimeRunId:secondRunId,reason:"Second fixture Run bound"});
  const decisionWorker=await broker.issue({projectId,loopId:secondLoopId,taskId:secondTaskId,runId:secondRunId,
    sessionId:secondSessionId,roleId:cognitiveRole,kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  assert.equal((await cli(decisionWorker.wrapperPath,["original",businessReportId,"--revision",businessReportRevisionId],1)).error?.code,
    "FORBIDDEN");
  const gitRead=await cli(decisionWorker.wrapperPath,["read","git",gitRefId]);
  assert.equal(Buffer.from(gitRead.base64,"base64").toString(),gitBody);
  assert.equal((await cli(decisionWorker.wrapperPath,["knowledge",wikiId,"--revision",wikiRevision])).body,wikiBody);
  const secondContext=await cli(decisionWorker.wrapperPath,["context",secondTaskId]);
  assert.equal(secondContext.status,"complete",JSON.stringify(secondContext.failures));
  assert.equal(secondContext.externalReferences.some((item:{body:string})=>item.body===gitBody),true);
  assert.equal(secondContext.externalReferences.some((item:{body:string})=>item.body===wikiBody),true);
  const waitingChildTaskId=randomUUID();
  await issue({type:"task.create",taskId:waitingChildTaskId,stageId,title:"Business responsibility after cognition",
    content:"# Perform the bounded next action",acceptance:"Business checks are independently recorded",
    owner:businessRole,consumer:"owner",evidence:"Signed cognition choice",stopCondition:"One checked action"});
  await issue({type:"task.start",taskId:waitingChildTaskId,expectedVersion:1,reason:"Fix child business input"});
  const waitingNextInbox=await workerCommand(decisionWorker.wrapperPath,{type:"inbox.accept",loopId:secondLoopId,
    sourceEventId:secondLoop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"next_action"});
  await workerCommand(decisionWorker.wrapperPath,{type:"inbox.ack",inboxId:waitingNextInbox.entityId,
    expectedVersion:1,reason:"Read source for business handoff"});
  orchestrationClock=new Date().toISOString();
  const positiveSameTick=orchestrationClock;
  const waitingChild=await workerCommand(decisionWorker.wrapperPath,{type:"dispatch.request",inboxId:waitingNextInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:secondDispatch.entityId,
    taskId:waitingChildTaskId,expectedTaskVersion:2,recipientRoleId:businessRole,
    purpose:"Execute bounded next action",authorizationScopeId:businessScope,reason:"Assign business work"});
  const beforeStop=(await orchestration.getLoop(owner,projectId,secondLoopId))!;
  await orchestrate({type:"loop.state",loopId:secondLoopId,expectedVersion:beforeStop.version,state:"stopped",
    reason:"Existing bounded Run may still leave its signed decision"});
  const decisionId=randomUUID();
  assert.equal((await workerCommand(decisionWorker.wrapperPath,{type:"worker.decision",decisionId,
    dispatchId:secondDispatch.entityId,runId:secondRunId,kind:"waiting",reason:"Child business work now awaits execution",evidenceRefs:[]})).entityId,decisionId);
  assert.equal((await cli(decisionWorker.wrapperPath,["get",`/api/projects/${projectId}/orchestration/decisions/${decisionId}`])).reason,
    "Child business work now awaits execution");
  const fixedOrder=(await pool.query(`SELECT kind,created_at_utc FROM orchestration_event WHERE project_id=$1
    AND (entity_id=$2 OR entity_id=$3) AND kind IN ('dispatch.requested','worker.decision')`,
    [projectId,waitingChild.entityId,decisionId])).rows;
  assert.deepEqual(fixedOrder.map(row=>row.kind).sort(),["dispatch.requested","worker.decision"]);
  assert.ok(fixedOrder.every(row=>row.created_at_utc.toISOString()===positiveSameTick),"formal request and decision share exact UTC tick");
  orchestrationClock=null;
  const decisionTaskVersion=(await workflow.getTask(owner,projectId,secondTaskId)).task.version;
  const premature=await workflow.execute(owner,{projectId,operationId:randomUUID(),type:"task.close",taskId:secondTaskId,
    expectedVersion:decisionTaskVersion,decisionId,acceptanceResult:"met",acceptanceEvidence:"Premature",reason:"No settlement yet"});
  assert.equal(premature.status,"rejected");
  await runtime.rejectDispatch(projectId,secondRunId,"Fixture terminal; no native Turn");
  await orchestrate({type:"worker.outcome",dispatchId:secondDispatch.entityId,outcome:"waiting",deliveryId:null,
    decisionId,evidenceRef:null,reason:"Child business work now awaits execution"});
  const missingHandoff=await workflow.execute(owner,{projectId,operationId:randomUUID(),type:"task.close",taskId:secondTaskId,
    expectedVersion:decisionTaskVersion,decisionId,acceptanceResult:"met",acceptanceEvidence:"Missing child",reason:"No handoff"});
  assert.equal(missingHandoff.status==="rejected"?missingHandoff.code:null,"WAITING_HANDOFF_REQUIRED");
  const wrongHandoff=await workflow.execute(owner,{projectId,operationId:randomUUID(),type:"task.close",taskId:secondTaskId,
    expectedVersion:decisionTaskVersion,decisionId,handoffDispatchId:childDispatch.entityId,
    acceptanceResult:"met",acceptanceEvidence:"Wrong source",reason:"Wrong child"});
  assert.equal(wrongHandoff.status==="rejected"?wrongHandoff.code:null,"WAITING_HANDOFF_REQUIRED");
  const closeResponse=await fetch(`${apiUrl}/api/commands`,{method:"POST",headers:{authorization:`Bearer ${ownerToken}`,
    "content-type":"application/json"},body:JSON.stringify({projectId,operationId:randomUUID(),type:"task.close",
    taskId:secondTaskId,expectedVersion:decisionTaskVersion,decisionId,handoffDispatchId:waitingChild.entityId,
    acceptanceResult:"met",acceptanceEvidence:"Signed waiting decision, earlier business handoff and terminal Run were read back",
    reason:"Bounded cognition accepted; child remains open"})});
  assert.equal(closeResponse.status,200,await closeResponse.text());
  assert.equal((await workflow.getTask(owner,projectId,secondTaskId)).task.state,"done");
  const decisionClosure=(await workflow.getTask(owner,projectId,secondTaskId)).closures.at(-1)!;
  assert.equal(decisionClosure.decisionId,decisionId);
  assert.equal(decisionClosure.deliveryId,null);
  assert.equal(decisionClosure.sourceInboxId,secondInbox.entityId);
  assert.equal(decisionClosure.sourceTaskId,null);
  assert.equal(decisionClosure.handoffDispatchId,waitingChild.entityId);
  assert.equal(decisionClosure.handoffTaskId,waitingChildTaskId);
  assert.equal((await workflow.getTask(owner,projectId,waitingChildTaskId)).task.state,"in_progress");
  const originalGapTask=(await workflow.getTask(owner,projectId,observationTaskId)).task;
  const borrowedDecision=await workflow.execute(owner,{projectId,operationId:randomUUID(),type:"task.close",
    taskId:observationTaskId,expectedVersion:originalGapTask.version,decisionId,
    handoffDispatchId:waitingChild.entityId,acceptanceResult:"met",acceptanceEvidence:"Wrong Task decision",
    reason:"Must not borrow another Task's result"});
  assert.equal(borrowedDecision.status==="rejected"?borrowedDecision.code:null,"DECISION_UNSETTLED");
  assert.equal((await workflow.getTask(owner,projectId,observationTaskId)).task.state,"in_progress");
  // Observation outbox entity_id is the business Task, while the signed operation names the Observation.
  const sourceRow=(await pool.query(`SELECT e.entity_id,j.result->>'revisionId' AS observation_id
    FROM outbox_event e JOIN operation_journal j ON j.project_id=e.project_id AND j.operation_id=e.operation_id
    WHERE e.project_id=$1 AND e.event_id=$2`,[projectId,observationEvent.event_id])).rows[0];
  assert.equal(sourceRow.entity_id,childTaskId);
  assert.notEqual(sourceRow.observation_id,sourceRow.entity_id);
  const observedLoopId=randomUUID(),observedTaskId=randomUUID(),observedSessionId=randomUUID(),observedRunId=randomUUID();
  await issue({type:"task.create",taskId:observedTaskId,stageId,title:"Judge independent consumer feedback",
    content:"# Read the signed observation",acceptance:"Record one bounded decision",owner:cognitiveRole,
    consumer:"owner",evidence:"Observation source",stopCondition:"One decision"});
  await issue({type:"task.start",taskId:observedTaskId,expectedVersion:1,reason:"Fix observation evidence"});
  await orchestrate({type:"loop.enroll",loopId:observedLoopId,goalId,stageId,cognitiveRoleId:cognitiveRole,
    allowedBusinessRoleIds:[businessRole],sourceAfter:{createdAtUtc:observationCursor.created_at.toISOString(),
      eventId:observationCursor.event_id},maxRuns:1,maxConcurrent:1,reason:"Signed Observation closure fact"});
  const observedInbox=await orchestrate({type:"inbox.accept",loopId:observedLoopId,sourceEventId:observationEvent.event_id,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:observedInbox.entityId,expectedVersion:1,reason:"Read exact feedback"});
  const observedDispatch=await orchestrate({type:"dispatch.request",inboxId:observedInbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:observedTaskId,expectedTaskVersion:2,
    recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,reason:"Judge external source"});
  const observedClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:observedDispatch.entityId,claimToken:observedClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:observedDispatch.entityId,claimToken:observedClaim});
  await issue({type:"runtime.session.reserve",sessionId:observedSessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,observedSessionId);
  await runtime.bindSession(projectId,observedSessionId,{owner:"evoloop-codex-app-server",projectId,sessionId:observedSessionId,
    roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${observedSessionId}`,nativeSessionId:`fixture-${observedSessionId}`});
  await issue({type:"runtime.run.reserve",runId:observedRunId,taskId:observedTaskId,sessionId:observedSessionId,
    expectedVersion:2,input:"Observe formal feedback fixture; no native Turn"});
  await orchestrate({type:"dispatch.resolve",dispatchId:observedDispatch.entityId,claimToken:observedClaim,result:"accepted",
    runtimeRunId:observedRunId,reason:"Formal fixture bound"});
  const observedWorker=await broker.issue({projectId,loopId:observedLoopId,taskId:observedTaskId,runId:observedRunId,
    sessionId:observedSessionId,roleId:cognitiveRole,kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  const observedDecisionId=randomUUID();
  await workerCommand(observedWorker.wrapperPath,{type:"worker.decision",decisionId:observedDecisionId,
    dispatchId:observedDispatch.entityId,runId:observedRunId,kind:"no_action",reason:"Feedback recorded; no further action",evidenceRefs:[]});
  await runtime.rejectDispatch(projectId,observedRunId,"Fixture terminal; no native Turn");
  await orchestrate({type:"worker.outcome",dispatchId:observedDispatch.entityId,outcome:"no_action",deliveryId:null,
    decisionId:observedDecisionId,evidenceRef:null,reason:"Feedback recorded; no further action"});
  const observedFact=await uow.read(projectId,tx=>tx.getCognitiveClosureFact!(observedDecisionId));
  assert.equal(observedFact?.sourceTaskId,childTaskId);
  assert.equal(observedFact?.sourceTaskIsCognition,false);
  assert.equal(observedFact?.sourceEventId,observationEvent.event_id);
  assert.equal(await uow.read(projectId,tx=>tx.getCognitiveClosureFact!(randomUUID())),null);
  const unsupportedSource=(await pool.query(`SELECT event_id FROM outbox_event WHERE project_id=$1
    AND kind='task' LIMIT 1`,[projectId])).rows[0];
  assert.ok(unsupportedSource?.event_id);
  await pool.query("UPDATE orchestration_inbox SET source_event_id=$3 WHERE project_id=$1 AND inbox_id=$2",
    [projectId,observedInbox.entityId,unsupportedSource.event_id]);
  await pool.query("UPDATE orchestration_dispatch SET data=jsonb_set(data,'{sourceEventId}',to_jsonb($3::text)) WHERE project_id=$1 AND dispatch_id=$2",
    [projectId,observedDispatch.entityId,unsupportedSource.event_id]);
  assert.equal(await uow.read(projectId,tx=>tx.getCognitiveClosureFact!(observedDecisionId)),null,
    "an unsupported or tampered source cannot become a closure fact merely because the decision is signed");
  // A formal observation of a cognition report still does not create a business handoff.
  const cognitionSourceSessionId=randomUUID(),cognitionSourceRunId=randomUUID(),cognitionSourceDecisionId=randomUUID();
  const cognitionSourceClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:unrelatedDispatch.entityId,claimToken:cognitionSourceClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:unrelatedDispatch.entityId,claimToken:cognitionSourceClaim});
  await issue({type:"runtime.session.reserve",sessionId:cognitionSourceSessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,cognitionSourceSessionId);
  await runtime.bindSession(projectId,cognitionSourceSessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:cognitionSourceSessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${cognitionSourceSessionId}`,nativeSessionId:`fixture-${cognitionSourceSessionId}`});
  await issue({type:"runtime.run.reserve",runId:cognitionSourceRunId,taskId:unrelatedTaskId,sessionId:cognitionSourceSessionId,
    expectedVersion:2,input:"Review cognition source fixture; no native Turn"});
  await orchestrate({type:"dispatch.resolve",dispatchId:unrelatedDispatch.entityId,claimToken:cognitionSourceClaim,
    result:"accepted",runtimeRunId:cognitionSourceRunId,reason:"Fixture bound"});
  const cognitionSourceWorker=await broker.issue({projectId,loopId:observationLoopId,taskId:unrelatedTaskId,
    runId:cognitionSourceRunId,sessionId:cognitionSourceSessionId,roleId:cognitiveRole,kind:"cognition",
    allowedRoleIds:[cognitiveRole,businessRole]});
  const lateNextInbox=await orchestrate({type:"inbox.accept",loopId:observationLoopId,
    sourceEventId:unrelatedObservation.event_id,recipientRoleId:cognitiveRole,purpose:"next_action"});
  await orchestrate({type:"inbox.ack",inboxId:lateNextInbox.entityId,
    expectedVersion:1,reason:"Read source before decision"});
  orchestrationClock=new Date().toISOString();
  const negativeSameTick=orchestrationClock;
  await workerCommand(cognitionSourceWorker.wrapperPath,{type:"worker.decision",decisionId:cognitionSourceDecisionId,
    dispatchId:unrelatedDispatch.entityId,runId:cognitionSourceRunId,kind:"waiting",reason:"No business owner in source",evidenceRefs:[]});
  await assert.rejects(orchestrate({type:"dispatch.request",inboxId:lateNextInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:unrelatedDispatch.entityId,
    taskId:waitingChildTaskId,expectedTaskVersion:2,recipientRoleId:businessRole,
    purpose:"Too late after signed decision",authorizationScopeId:businessScope,reason:"Invalid late child"}),
  (error:{code?:string})=>error.code==="PARENT_DECIDED");
  const decisionEventTime=(await pool.query(`SELECT created_at_utc FROM orchestration_event WHERE project_id=$1
    AND entity_id=$2 AND kind='worker.decision'`,[projectId,cognitionSourceDecisionId])).rows[0].created_at_utc.toISOString();
  assert.equal(decisionEventTime,negativeSameTick);
  orchestrationClock=null;
  await runtime.rejectDispatch(projectId,cognitionSourceRunId,"Fixture terminal; no native Turn");
  await orchestrate({type:"worker.outcome",dispatchId:unrelatedDispatch.entityId,outcome:"waiting",deliveryId:null,
    decisionId:cognitionSourceDecisionId,evidenceRef:null,reason:"No business owner in source"});
  const cognitionSourceFact=await uow.read(projectId,tx=>tx.getCognitiveClosureFact!(cognitionSourceDecisionId));
  assert.equal(cognitionSourceFact?.sourceTaskId,cognitiveTaskId);
  assert.equal(cognitionSourceFact?.sourceTaskIsCognition,true);
  const cognitionTask=(await workflow.getTask(owner,projectId,unrelatedTaskId)).task;
  const noBusinessHandoff=await workflow.execute(owner,{projectId,operationId:randomUUID(),type:"task.close",
    taskId:unrelatedTaskId,expectedVersion:cognitionTask.version,decisionId:cognitionSourceDecisionId,
    waitingInboxId:randomUUID(),acceptanceResult:"met",acceptanceEvidence:"Cannot claim business handoff",
    reason:"Review source classification"});
  assert.equal(noBusinessHandoff.status==="rejected"?noBusinessHandoff.code:null,"WAITING_HANDOFF_REQUIRED");
  // The gap-origin cognition Task can settle its own new judgement, without rewriting the original gap Run.
  const gapJudgementClaim=randomUUID(),gapJudgementSessionId=randomUUID(),gapJudgementRunId=randomUUID(),gapJudgementDecisionId=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:observationRecoveryDispatch.entityId,claimToken:gapJudgementClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:observationRecoveryDispatch.entityId,claimToken:gapJudgementClaim});
  await issue({type:"runtime.session.reserve",sessionId:gapJudgementSessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,gapJudgementSessionId);
  await runtime.bindSession(projectId,gapJudgementSessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:gapJudgementSessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${gapJudgementSessionId}`,nativeSessionId:`fixture-${gapJudgementSessionId}`});
  await issue({type:"runtime.run.reserve",runId:gapJudgementRunId,taskId:observationRecoveryTaskId,sessionId:gapJudgementSessionId,
    expectedVersion:2,input:"Judge the original formal gap; no native Turn"});
  await orchestrate({type:"dispatch.resolve",dispatchId:observationRecoveryDispatch.entityId,claimToken:gapJudgementClaim,
    result:"accepted",runtimeRunId:gapJudgementRunId,reason:"Fixture recovery judgement bound"});
  const gapJudgementWorker=await broker.issue({projectId,loopId:observationLoopId,taskId:observationRecoveryTaskId,
    runId:gapJudgementRunId,sessionId:gapJudgementSessionId,roleId:cognitiveRole,kind:"cognition",
    allowedRoleIds:[cognitiveRole,businessRole]});
  await workerCommand(gapJudgementWorker.wrapperPath,{type:"worker.decision",decisionId:gapJudgementDecisionId,
    dispatchId:observationRecoveryDispatch.entityId,runId:gapJudgementRunId,kind:"no_action",
    reason:"Gap remains visible; no separate repair authorized",evidenceRefs:[]});
  await runtime.rejectDispatch(projectId,gapJudgementRunId,"Fixture terminal; no native Turn");
  await orchestrate({type:"worker.outcome",dispatchId:observationRecoveryDispatch.entityId,outcome:"no_action",
    deliveryId:null,decisionId:gapJudgementDecisionId,evidenceRef:null,
    reason:"Gap remains visible; no separate repair authorized"});
  const gapJudgementTask=(await workflow.getTask(owner,projectId,observationRecoveryTaskId)).task;
  const gapJudgementClosed=await workflow.execute(owner,{projectId,operationId:randomUUID(),type:"task.close",
    taskId:observationRecoveryTaskId,expectedVersion:gapJudgementTask.version,decisionId:gapJudgementDecisionId,
    acceptanceResult:"met",acceptanceEvidence:"Signed bounded judgement on fixed gap source",reason:"Review this judgement"});
  assert.equal(gapJudgementClosed.status,"applied",JSON.stringify(gapJudgementClosed));
  assert.equal((await workflow.getTask(owner,projectId,observationRecoveryTaskId)).task.state,"done");
  assert.equal((await workflow.getTask(owner,projectId,observationTaskId)).task.state,"in_progress");
  const unknown=randomUUID();
  assert.equal((await cli(wrapper,["operation",unknown],1)).error?.code,"OPERATION_NOT_FOUND");
  assert.equal((await cli(wrapper,["task",randomUUID()],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["project",randomUUID()],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["list","tasks"],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["read","goal",randomUUID()],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["get",`/api/projects/${projectId}/runtime`],1)).error?.code,"FORBIDDEN");
  assert.equal((await workerCommand(wrapper,{type:"runtime.session.reserve",sessionId:randomUUID(),roleId:cognitiveRole,
    cwd:directory,authorizationScope:cognitiveScope,sandbox:"danger-full-access",approvalPolicy:"never"},1)).error?.code,"FORBIDDEN");
  assert.ok(run.revisionId);

  // A fresh loop receives a verified terminal intent gap after the original Task moved to another Goal.
  const gapLoopId=randomUUID(),gapTaskId=randomUUID(),gapRunId=randomUUID(),gapSessionId=randomUUID();
  await issue({type:"task.create",taskId:gapTaskId,stageId,title:"Original gap Task",content:"# Frozen old work",
    acceptance:"Inspect fixed work",owner:cognitiveRole,consumer:"owner",evidence:"Fixture",stopCondition:"One Run"});
  const gapCursor=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await orchestrate({type:"loop.enroll",loopId:gapLoopId,goalId,stageId,cognitiveRoleId:cognitiveRole,
    allowedBusinessRoleIds:[businessRole],sourceAfter:{createdAtUtc:gapCursor.created_at.toISOString(),eventId:gapCursor.event_id},
    maxRuns:2,maxConcurrent:1,reason:"Terminal gap scoped read fixture"});
  const gapLoop=(await orchestration.getLoop(owner,projectId,gapLoopId))!;
  const gapSeed=await orchestrate({type:"inbox.accept",loopId:gapLoopId,sourceEventId:gapLoop.bootstrapEventId,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:gapSeed.entityId,expectedVersion:1,reason:"Read seed"});
  const original=await orchestrate({type:"dispatch.request",inboxId:gapSeed.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:gapTaskId,expectedTaskVersion:1,
    recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,reason:"Original cognition"});
  const gapClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:original.entityId,claimToken:gapClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:original.entityId,claimToken:gapClaim});
  await issue({type:"task.start",taskId:gapTaskId,expectedVersion:1,reason:"Managed start after dispatch request"});
  await issue({type:"runtime.session.reserve",sessionId:gapSessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,gapSessionId);
  await runtime.bindSession(projectId,gapSessionId,{owner:"evoloop-codex-app-server",projectId,sessionId:gapSessionId,
    roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${gapSessionId}`,nativeSessionId:`fixture-${gapSessionId}`});
  await issue({type:"runtime.run.reserve",runId:gapRunId,taskId:gapTaskId,sessionId:gapSessionId,
    expectedVersion:2,input:"Original fixed input"});
  await orchestrate({type:"dispatch.resolve",dispatchId:original.entityId,claimToken:gapClaim,
    result:"accepted",runtimeRunId:gapRunId,reason:"Original Run bound"});
  const originalWorker=await broker.issue({projectId,loopId:gapLoopId,taskId:gapTaskId,runId:gapRunId,
    sessionId:gapSessionId,roleId:cognitiveRole,kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  await runtime.rejectDispatch(projectId,gapRunId,"Terminal fixture without signed intent");
  await orchestrate({type:"dispatch.gap",dispatchId:original.entityId,expectedVersion:4,
    reason:"Worker intent gap: absent",evidenceRef:null});
  const recoveryGapEvent=(await pool.query("SELECT event_id FROM orchestration_event WHERE project_id=$1 AND kind='dispatch.gap' AND entity_id=$2",
    [projectId,original.entityId])).rows[0].event_id as string;
  const oldRevision=(await pool.query("SELECT task_revision_id FROM runtime_run WHERE project_id=$1 AND run_id=$2",
    [projectId,gapRunId])).rows[0].task_revision_id as string;
  assert.equal((await pool.query("SELECT task_version FROM orchestration_dispatch WHERE project_id=$1 AND dispatch_id=$2",
    [projectId,original.entityId])).rows[0].task_version,1);
  assert.equal((await pool.query("SELECT version FROM task_revision WHERE project_id=$1 AND task_id=$2 AND revision_id=$3",
    [projectId,gapTaskId,oldRevision])).rows[0].version,3);
  const oldContent=(await pool.query("SELECT content_document_id,content_revision_id FROM task_revision WHERE project_id=$1 AND task_id=$2 AND revision_id=$3",
    [projectId,gapTaskId,oldRevision])).rows[0];
  const beforeMove=(await workflow.getTask(owner,projectId,gapTaskId)).task;
  const reopenedGap=await issue({type:"task.reopen",taskId:gapTaskId,expectedVersion:beforeMove.version,reason:"Later work"});
  await issue({type:"task.update",taskId:gapTaskId,expectedVersion:reopenedGap.version,
    title:beforeMove.title,content:"# New Goal secret",acceptance:beforeMove.acceptance,owner:beforeMove.owner,
    stageId:outsideStageId,reason:"Move later Task head"});
  const recoveryTaskId=randomUUID(),recoverySessionId=randomUUID(),recoveryRunId=randomUUID();
  await issue({type:"task.create",taskId:recoveryTaskId,stageId,title:"Inspect old gap",content:"# Recover",
    acceptance:"One signed finding",owner:cognitiveRole,consumer:"owner",evidence:"Gap",stopCondition:"One Run"});
  await issue({type:"task.start",taskId:recoveryTaskId,expectedVersion:1,reason:"Fix recovery Task"});
  const recoveryInbox=await orchestrate({type:"inbox.accept",loopId:gapLoopId,sourceEventId:recoveryGapEvent,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:recoveryInbox.entityId,expectedVersion:1,reason:"Read gap"});
  const recoveryDispatch=await orchestrate({type:"dispatch.request",inboxId:recoveryInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:recoveryTaskId,
    expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,
    reason:"Recover exactly one old gap"});
  const recoveryClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:recoveryDispatch.entityId,claimToken:recoveryClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:recoveryDispatch.entityId,claimToken:recoveryClaim});
  await issue({type:"runtime.session.reserve",sessionId:recoverySessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,recoverySessionId);
  await runtime.bindSession(projectId,recoverySessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:recoverySessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${recoverySessionId}`,nativeSessionId:`fixture-${recoverySessionId}`});
  await issue({type:"runtime.run.reserve",runId:recoveryRunId,taskId:recoveryTaskId,
    sessionId:recoverySessionId,expectedVersion:2,input:"Read the original gap"});
  await orchestrate({type:"dispatch.resolve",dispatchId:recoveryDispatch.entityId,claimToken:recoveryClaim,
    result:"accepted",runtimeRunId:recoveryRunId,reason:"Recovery Run bound"});
  const recoveryWorker=await broker.issue({projectId,loopId:gapLoopId,taskId:recoveryTaskId,runId:recoveryRunId,
    sessionId:recoverySessionId,roleId:cognitiveRole,kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  const diagnosisHash=(await pool.query("SELECT content_hash FROM document_revision WHERE project_id=$1 AND document_id=$2 AND revision_id=$3",
    [projectId,oldContent.content_document_id,oldContent.content_revision_id])).rows[0].content_hash as string;
  const methodIntent={type:"division.decide",decisionId:randomUUID(),loopId:gapLoopId,
    expectedLoopVersion:(await orchestration.getLoop(owner,projectId,gapLoopId))!.version,
    sourceEventId:recoveryGapEvent,parentDispatchId:recoveryDispatch.entityId,
    documentId:oldContent.content_document_id,documentRevisionId:oldContent.content_revision_id,
    documentContentHash:diagnosisHash,firstTaskId:recoveryTaskId,
    expectedFirstTaskVersion:(await workflow.getTask(owner,projectId,recoveryTaskId)).task.version,
    choice:"method",roleId:cognitiveRole,templateId:null,templateRevision:null,templateHash:null,
    reason:"Keep the existing cognition method"};
  assert.equal((await workerCommand(recoveryWorker.wrapperPath,{...methodIntent,parentDispatchId:original.entityId},1)).error?.code,"FORBIDDEN");
  const recordedMethod=await workerCommand(recoveryWorker.wrapperPath,methodIntent);
  assert.equal(recordedMethod.entityId,methodIntent.decisionId);
  const invalidWaiting=await workerCommand(recoveryWorker.wrapperPath,{type:"worker.decision",decisionId:randomUUID(),
    dispatchId:recoveryDispatch.entityId,runId:recoveryRunId,kind:"waiting",
    divisionDecisionId:recordedMethod.entityId,reason:"Method is not a handoff binding",evidenceRefs:[]},1);
  assert.equal(invalidWaiting.error?.code,"INVALID_CAUSALITY");
  assert.equal(await orchestration.getDecisionForDispatch(owner,projectId,recoveryDispatch.entityId),null);
  const noAction=await workerCommand(recoveryWorker.wrapperPath,{type:"worker.decision",decisionId:randomUUID(),
    dispatchId:recoveryDispatch.entityId,runId:recoveryRunId,kind:"no_action",
    divisionDecisionId:null,reason:"Reviewed the fixed gap without a child",evidenceRefs:[]});
  assert.equal((await orchestration.getDecision(owner,projectId,noAction.entityId))?.divisionDecisionId,null);
  const recoveryGet=(path:string,expected=0)=>cli(recoveryWorker.wrapperPath,["get",`/api/projects/${projectId}/${path}`],expected);
  assert.equal((await recoveryGet(`runtime/runs/${gapRunId}`)).id,gapRunId);
  assert.equal((await recoveryGet(`tasks/${gapTaskId}/revisions/${oldRevision}`)).revision.id,oldRevision);
  assert.equal((await cli(recoveryWorker.wrapperPath,["original",oldContent.content_document_id,"--revision",oldContent.content_revision_id])).body,
    "# Frozen old work");
  for(const path of [`tasks/${gapTaskId}`,`tasks/${gapTaskId}/revisions`,
    `documents/${oldContent.content_document_id}`,`documents/${oldContent.content_document_id}/revisions`,
    `runtime/runs/${secondRunId}`,`tasks/${gapTaskId}/revisions/${randomUUID()}`])
    assert.equal((await recoveryGet(path,1)).error?.code,"FORBIDDEN",path);
  assert.equal((await cli(recoveryWorker.wrapperPath,["original",oldContent.content_document_id,
    "--revision",(await workflow.getTask(owner,projectId,gapTaskId)).task.contentRevisionId],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(originalWorker.wrapperPath,["get",`/api/projects/${projectId}/runtime/runs/${recoveryRunId}`],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(newGoalWorker.wrapperPath,["get",`/api/projects/${projectId}/runtime/runs/${gapRunId}`],1)).error?.code,
    "FORBIDDEN");
  const unknownLoopId=randomUUID(),unknownTaskId=randomUUID(),unknownSessionId=randomUUID(),unknownRunId=randomUUID();
  await issue({type:"task.create",taskId:unknownTaskId,stageId,title:"Unresolved work",content:"# Unknown",
    acceptance:"Do not infer terminal",owner:cognitiveRole,kind:"research",consumer:cognitiveRole,
    useRequired:false,evidence:"Fixture",stopCondition:"One Run"});
  const unknownGitRefId=randomUUID();
  const unknownGitBody="# Gap fixed source\n";
  await writeFile(join(gitRoot,"gap.md"),unknownGitBody);
  git("add","gap.md");git("commit","-qm","fixed gap source");
  const unknownCommit=git("rev-parse","HEAD");
  observedGit.set(unknownGitRefId,{revision:unknownCommit,body:unknownGitBody});
  assert.equal((await registerFixedGitReference(deps,owner,{projectId,operationId:randomUUID(),actorId:controller,
    referenceId:unknownGitRefId,repositoryId:"formal",path:"gap.md",commit:unknownCommit,
    contentHash:hash(unknownGitBody)})).status,"applied");
  const beforeUnknownGit=(await workflow.getTask(owner,projectId,unknownTaskId)).task;
  const unknownGit=await decideTaskExternalReference(deps,owner,{projectId,operationId:randomUUID(),actorId:controller,
    decisionId:randomUUID(),taskId:unknownTaskId,taskRevisionId:beforeUnknownGit.currentRevisionId,
    expectedTaskVersion:beforeUnknownGit.version,slotId:randomUUID(),expectedHeadVersion:0,decision:"adopt",
    kind:"git",referenceId:unknownGitRefId,revision:unknownCommit,contentHash:hash(unknownGitBody),reason:"Freeze Git in original Run",
    actionImpact:"Read exact Git bytes"});
  assert.equal(unknownGit.status,"applied");
  const beforeUnknownWiki=(await workflow.getTask(owner,projectId,unknownTaskId)).task;
  const unknownWiki=await decideTaskExternalReference(deps,owner,{projectId,operationId:randomUUID(),actorId:controller,
    decisionId:randomUUID(),taskId:unknownTaskId,taskRevisionId:beforeUnknownWiki.currentRevisionId,
    expectedTaskVersion:beforeUnknownWiki.version,slotId:randomUUID(),expectedHeadVersion:0,decision:"adopt",
    kind:"wiki",referenceId:wikiId,revision:wikiRevision,contentHash:hash(wikiBody),reason:"Freeze Wiki in original Run",
    actionImpact:"Read exact Wiki bytes"});
  assert.equal(unknownWiki.status,"applied");
  const unknownCursor=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await orchestrate({type:"loop.enroll",loopId:unknownLoopId,goalId,stageId,cognitiveRoleId:cognitiveRole,
    allowedBusinessRoleIds:[businessRole],sourceAfter:{createdAtUtc:unknownCursor.created_at.toISOString(),eventId:unknownCursor.event_id},
    maxRuns:2,maxConcurrent:1,reason:"Unknown Run is not yet a gap"});
  const unknownLoop=(await orchestration.getLoop(owner,projectId,unknownLoopId))!;
  const unknownInbox=await orchestrate({type:"inbox.accept",loopId:unknownLoopId,
    sourceEventId:unknownLoop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:unknownInbox.entityId,expectedVersion:1,reason:"Read seed"});
  const unresolved=await orchestrate({type:"dispatch.request",inboxId:unknownInbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:unknownTaskId,expectedTaskVersion:3,
    recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,reason:"Unresolved fixture"});
  const unknownClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:unresolved.entityId,claimToken:unknownClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:unresolved.entityId,claimToken:unknownClaim});
  await issue({type:"task.start",taskId:unknownTaskId,expectedVersion:3,reason:"Prepare unresolved Run"});
  await issue({type:"runtime.session.reserve",sessionId:unknownSessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,unknownSessionId);
  await runtime.bindSession(projectId,unknownSessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:unknownSessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${unknownSessionId}`,nativeSessionId:`fixture-${unknownSessionId}`});
  await issue({type:"runtime.run.reserve",runId:unknownRunId,taskId:unknownTaskId,
    sessionId:unknownSessionId,expectedVersion:4,input:"Unresolved native start"});
  await orchestrate({type:"dispatch.resolve",dispatchId:unresolved.entityId,claimToken:unknownClaim,
    result:"accepted",runtimeRunId:unknownRunId,reason:"Run identity bound"});
  await runtime.beginDispatch(projectId,unknownRunId);
  const unknownOperationId=(await pool.query("SELECT operation_id FROM runtime_run WHERE project_id=$1 AND run_id=$2",
    [projectId,unknownRunId])).rows[0].operation_id as string;
  const fixtureTurnId=`fixture-turn-${unknownRunId}`;
  await runtime.bindTurn(projectId,unknownRunId,{id:fixtureTurnId,status:"running"},
    {kind:"startReply",operationId:unknownOperationId});
  await runtime.markRunUnknown(projectId,unknownRunId,"No native proof of terminal state");
  const unknownTaskVersion=(await workflow.getTask(owner,projectId,unknownTaskId)).task.version;
  const unknownClose=await workflow.execute(owner,{projectId,operationId:randomUUID(),type:"task.close",
    taskId:unknownTaskId,expectedVersion:unknownTaskVersion,decisionId,acceptanceResult:"met",
    acceptanceEvidence:"Unknown Run is not terminal proof",reason:"Must remain open"});
  assert.equal(unknownClose.status==="rejected"?unknownClose.code:null,"TASK_BUSY");
  await assert.rejects(orchestrate({type:"dispatch.gap",dispatchId:unresolved.entityId,expectedVersion:4,
    reason:"Worker intent gap: unproven",evidenceRef:null}),{code:"RUN_NOT_TERMINAL"});
  assert.equal((await orchestration.listSourceFacts(owner,projectId,unknownLoopId)).items.some(item=>item.kind==="dispatch.gap"),false);
  await runtime.recordTurn(projectId,unknownRunId,fixtureTurnId,"completed","Fixture terminal observation");
  const unsignedClose=await workflow.execute(owner,{projectId,operationId:randomUUID(),type:"task.close",
    taskId:unknownTaskId,expectedVersion:unknownTaskVersion,decisionId,acceptanceResult:"met",
    acceptanceEvidence:"Another Task's Decision is not this Run's evidence",reason:"Must remain open"});
  assert.equal(unsignedClose.status==="rejected"?unsignedClose.code:null,"DECISION_UNSETTLED");
  await orchestrate({type:"dispatch.gap",dispatchId:unresolved.entityId,expectedVersion:4,
    reason:"Worker intent gap: no signed submission",evidenceRef:null});
  const referenceGapEvent=(await pool.query("SELECT event_id FROM orchestration_event WHERE project_id=$1 AND kind='dispatch.gap' AND entity_id=$2",
    [projectId,unresolved.entityId])).rows[0].event_id as string;
  const unknownFixedRevision=(await pool.query("SELECT task_revision_id FROM runtime_run WHERE project_id=$1 AND run_id=$2",
    [projectId,unknownRunId])).rows[0].task_revision_id as string;
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task_external_ref_snapshot WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3",
    [projectId,unknownTaskId,unknownFixedRevision])).rows[0].n,2);
  const lateRefId=randomUUID();
  const lateGitBody="# Later private source\n";
  await writeFile(join(gitRoot,"later.md"),lateGitBody);
  git("add","later.md");git("commit","-qm","later private source");
  const lateCommit=git("rev-parse","HEAD");
  observedGit.set(lateRefId,{revision:lateCommit,body:lateGitBody});
  assert.equal((await registerFixedGitReference(deps,owner,{projectId,operationId:randomUUID(),actorId:controller,
    referenceId:lateRefId,repositoryId:"formal",path:"later.md",commit:lateCommit,
    contentHash:hash(lateGitBody)})).status,"applied");
  const beforeLateRef=(await workflow.getTask(owner,projectId,unknownTaskId)).task;
  assert.equal((await decideTaskExternalReference(deps,owner,{projectId,operationId:randomUUID(),actorId:controller,
    decisionId:randomUUID(),taskId:unknownTaskId,taskRevisionId:beforeLateRef.currentRevisionId,
    expectedTaskVersion:beforeLateRef.version,slotId:randomUUID(),expectedHeadVersion:0,decision:"adopt",
    kind:"git",referenceId:lateRefId,revision:lateCommit,contentHash:hash(lateGitBody),reason:"Later source outside fixed Run",
    actionImpact:"Must stay private to later Task versions"})).status,"applied");
  assert.equal((await cli(newGoalWorker.wrapperPath,["read","git",unknownGitRefId],1)).error?.code,"FORBIDDEN");
  const beforeReferenceMove=(await workflow.getTask(owner,projectId,unknownTaskId)).task;
  const reopenedReference=await issue({type:"task.reopen",taskId:unknownTaskId,expectedVersion:beforeReferenceMove.version,
    reason:"Later Goal change"});
  await issue({type:"task.update",taskId:unknownTaskId,expectedVersion:reopenedReference.version,
    title:beforeReferenceMove.title,content:"# Later private version",acceptance:beforeReferenceMove.acceptance,
    owner:beforeReferenceMove.owner,stageId:outsideStageId,reason:"Move old source Task away"});
  const referenceRecoveryTaskId=randomUUID(),referenceRecoverySessionId=randomUUID(),referenceRecoveryRunId=randomUUID();
  await issue({type:"task.create",taskId:referenceRecoveryTaskId,stageId,title:"Recover fixed references",
    content:"# Read original",acceptance:"One bounded finding",owner:cognitiveRole,consumer:"owner",evidence:"Gap",
    stopCondition:"One Run"});
  await issue({type:"task.start",taskId:referenceRecoveryTaskId,expectedVersion:1,reason:"Fix recovery source"});
  const referenceInbox=await orchestrate({type:"inbox.accept",loopId:unknownLoopId,sourceEventId:referenceGapEvent,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestrate({type:"inbox.ack",inboxId:referenceInbox.entityId,expectedVersion:1,reason:"Review fixed gap"});
  const referenceDispatch=await orchestrate({type:"dispatch.request",inboxId:referenceInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:referenceRecoveryTaskId,
    expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,
    reason:"Read old external snapshot"});
  const referenceClaim=randomUUID();
  await orchestrate({type:"dispatch.claim",dispatchId:referenceDispatch.entityId,claimToken:referenceClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestrate({type:"dispatch.start",dispatchId:referenceDispatch.entityId,claimToken:referenceClaim});
  await issue({type:"runtime.session.reserve",sessionId:referenceRecoverySessionId,roleId:cognitiveRole,cwd:directory,
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,referenceRecoverySessionId);
  await runtime.bindSession(projectId,referenceRecoverySessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:referenceRecoverySessionId,roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${referenceRecoverySessionId}`,nativeSessionId:`fixture-${referenceRecoverySessionId}`});
  await issue({type:"runtime.run.reserve",runId:referenceRecoveryRunId,taskId:referenceRecoveryTaskId,
    sessionId:referenceRecoverySessionId,expectedVersion:2,input:"Read fixed Git and Wiki"});
  await orchestrate({type:"dispatch.resolve",dispatchId:referenceDispatch.entityId,claimToken:referenceClaim,
    result:"accepted",runtimeRunId:referenceRecoveryRunId,reason:"Recovery reference Run bound"});
  const referenceWorker=await broker.issue({projectId,loopId:unknownLoopId,taskId:referenceRecoveryTaskId,
    runId:referenceRecoveryRunId,sessionId:referenceRecoverySessionId,roleId:cognitiveRole,
    kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  const referencePath=`/api/projects/${projectId}/references/tasks/${unknownTaskId}/revisions/${unknownFixedRevision}`;
  const snapshot=await cli(referenceWorker.wrapperPath,["get",referencePath]);
  assert.equal(snapshot.length,2);
  assert.equal(Buffer.from((await cli(referenceWorker.wrapperPath,["read","git",unknownGitRefId])).base64,"base64").toString(),unknownGitBody);
  assert.equal((await cli(referenceWorker.wrapperPath,["knowledge",wikiId,"--revision",wikiRevision])).body,wikiBody);
  assert.equal((await cli(referenceWorker.wrapperPath,["read","git",lateRefId],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(referenceWorker.wrapperPath,["knowledge",wikiId,"--revision",randomUUID()],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(businessWrapper,["read","git",unknownGitRefId],1)).error?.code,"FORBIDDEN");
});
