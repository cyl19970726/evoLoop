import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import pg from "pg";
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

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== "/evoloop_journey_eval_test")
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
  const projectId=randomUUID(),loopId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),cognitiveTaskId=randomUUID();
  const cognitiveRole="fixture-planner",businessRole="fixture-builder",controller="fixture-controller";
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
  const gitSource=new GitDocumentSource([{projectId,repositoryId:"formal",root:gitRoot,allowedPaths:["formal.md"]}],async()=>true);
  let broker:WorkerCredentialBroker;
  const store=new PgOrchestrationStore(pool,{
    getAuthorizationFact:async (project,scope)=>project===projectId && [cognitiveScope,businessScope].includes(scope) ?
      {projectId,scopeId:scope,actorId:controller,roleId:scope===cognitiveScope?cognitiveRole:businessRole,active:true}:null,
    canActAsRole:async (project,actor,role)=>project===projectId &&
      (actor===controller || (await broker.identityForActor(actor))?.scope.roleId===role),
    wasActorRole:async (project,actor,loop,role)=>project===projectId &&
      (await broker.identityForActor(actor))?.scope.loopId===loop && (await broker.identityForActor(actor))?.scope.roleId===role,
  });
  const orchestration=new OrchestrationService({store,now:()=>new Date().toISOString(),nextId:randomUUID,hash});
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
  await issue({type:"goal.create",goalId,outcome:"Check one fixed source",constraints:"Fixture only",consumer:"owner",authority:"controller",scope:"isolated",owner:controller});
  await issue({type:"stage.propose",stageId,goalId,deliverable:"One bounded action",learningQuestion:"Can worker read and act?",reason:"Fixture stage"});
  await issue({type:"stage.accept",stageId,expectedVersion:1,reason:"Active fixture stage"});
  const basisId=randomUUID(),source="# Frozen basis\nExact original.";
  const basis=await issue({type:"document.create",documentId:basisId,title:"Frozen basis",body:source});
  await issue({type:"document.adopt",documentId:basisId,expectedVersion:1,revisionId:basis.revisionId,reason:"Fix source"});
  await issue({type:"task.create",taskId:cognitiveTaskId,stageId,title:"Review source",content:"# Decide next action",acceptance:"One signed result",
    owner:cognitiveRole,documentIds:[basisId],consumer:"owner",evidence:"Fixture",stopCondition:"One decision"});
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
    model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
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
  await workerCommand(wrapper,{type:"document.create",documentId:reportId,kind:"report",title:"Worker report",body:"# Worker evidence"});
  const report=await cli(wrapper,["document",reportId]);
  assert.equal((await cli(wrapper,["original",reportId,"--revision",report.current.id])).body,"# Worker evidence");
  const childTaskId=randomUUID();
  await workerCommand(wrapper,{type:"task.create",taskId:childTaskId,stageId,title:"Bounded child action",content:"# Next",
    acceptance:"One check",owner:businessRole,consumer:"owner",evidence:"Source reviewed",stopCondition:"One action"});
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
    model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
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
  await workerCommand(businessWrapper,{type:"document.create",documentId:businessReportId,kind:"report",
    title:"Business delivery report",body:businessReportBody});
  const businessReport=await cli(businessWrapper,["document",businessReportId]);
  const businessSubmissionId=randomUUID();
  assert.equal((await workerCommand(businessWrapper,{type:"worker.submit",submissionId:businessSubmissionId,
    dispatchId:childDispatch.entityId,runId:businessRunId,taskRevisionId:businessRun.revisionId,
    runInputHash:hash(businessInput),deliveryOperationId:randomUUID(),
    deliveryIntent:{artifactRef:`#/p/${projectId}/documents/${businessReportId}?revision=${businessReport.current.id}`,
      artifactRevision:businessReport.current.id,contentHash:hash(businessReportBody),technicalResult:"passed",
      technicalEvidence:"Fixture report was written through worker CLI",reason:"Fixed report delivered"},
    agentObservation:"Fixture report recorded; no native execution",evidenceRefs:[]})).entityId,businessSubmissionId);
  const businessTerminal=await runtime.rejectDispatch(projectId,businessRunId,"Fixture terminal; no native Turn");
  const businessSealed=await sealer((await orchestration.getDispatch(owner,projectId,childDispatch.entityId))!,businessTerminal);
  assert.equal(businessSealed.status,"sealed",JSON.stringify(businessSealed));
  await orchestrate({type:"worker.outcome",dispatchId:childDispatch.entityId,outcome:"delivered",
    deliveryId:businessSealed.deliveryId,decisionId:null,evidenceRef:"fixture:business-report",reason:"Signed report sealed"});
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
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
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
  assert.equal((await cli(continuationWorker.wrapperPath,["original",businessReportId,"--revision",businessReport.current.id])).body,
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
    authorizationScope:cognitiveScope,model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
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
  assert.equal((await cli(newGoalWorker.wrapperPath,["original",businessReportId,"--revision",businessReport.current.id],1)).error?.code,
    "FORBIDDEN");
  const revisedReport=await issue({type:"document.revise",documentId:businessReportId,expectedVersion:1,
    body:"# Later report revision",reason:"Different bytes after fixed delivery"});
  assert.equal((await cli(continuationWorker.wrapperPath,["document",businessReportId],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(continuationWorker.wrapperPath,["get",`/api/projects/${projectId}/documents/${businessReportId}/revisions`],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(continuationWorker.wrapperPath,["original",businessReportId,"--revision",businessReport.current.id])).body,
    businessReportBody);
  assert.equal((await cli(continuationWorker.wrapperPath,["original",businessReportId,"--revision",revisedReport.revisionId!],1)).error?.code,
    "FORBIDDEN");
  assert.equal((await cli(continuationWorker.wrapperPath,["original",reportId,"--revision",report.current.id],1)).error?.code,
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
    acceptance:"One signed waiting reason",owner:cognitiveRole,consumer:"owner",evidence:"Fixture",stopCondition:"One decision"});
  await issue({type:"task.start",taskId:secondTaskId,expectedVersion:1,reason:"Freeze second fixture"});
  const gitRefId=randomUUID();
  const deps={uow,git:gitSource,hashText:hash,nextId:randomUUID,now:()=>new Date().toISOString(),
    observeExternal:async (_actor:unknown,_project:string,kind:"git"|"wiki")=>({status:"reachable" as const,
      revision:kind==="git"?commit:wikiRevision,contentHash:kind==="git"?hash(gitBody):hash(wikiBody),
      currentRevision:kind==="git"?commit:wikiRevision,currentHash:kind==="git"?hash(gitBody):hash(wikiBody),
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
    sourceAfter:{createdAtUtc:afterFirst.created_at.toISOString(),eventId:afterFirst.event_id},maxRuns:1,maxConcurrent:1,reason:"Separate decision fixture"});
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
    model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,secondSessionId);
  await runtime.bindSession(projectId,secondSessionId,{owner:"evoloop-codex-app-server",projectId,sessionId:secondSessionId,
    roleId:cognitiveRole,cwd:directory,authorizationScope:cognitiveScope,nativeThreadId:`fixture-${secondSessionId}`,nativeSessionId:`fixture-${secondSessionId}`});
  await issue({type:"runtime.run.reserve",runId:secondRunId,taskId:secondTaskId,sessionId:secondSessionId,
    expectedVersion:secondTask.version,input:"Record one waiting decision"});
  await orchestrate({type:"dispatch.resolve",dispatchId:secondDispatch.entityId,claimToken:secondClaim,result:"accepted",
    runtimeRunId:secondRunId,reason:"Second fixture Run bound"});
  const decisionWorker=await broker.issue({projectId,loopId:secondLoopId,taskId:secondTaskId,runId:secondRunId,
    sessionId:secondSessionId,roleId:cognitiveRole,kind:"cognition",allowedRoleIds:[cognitiveRole,businessRole]});
  assert.equal((await cli(decisionWorker.wrapperPath,["original",businessReportId,"--revision",businessReport.current.id],1)).error?.code,
    "FORBIDDEN");
  const beforeStop=(await orchestration.getLoop(owner,projectId,secondLoopId))!;
  await orchestrate({type:"loop.state",loopId:secondLoopId,expectedVersion:beforeStop.version,state:"stopped",
    reason:"Existing bounded Run may still leave its signed decision"});
  const gitRead=await cli(decisionWorker.wrapperPath,["read","git",gitRefId]);
  assert.equal(Buffer.from(gitRead.base64,"base64").toString(),gitBody);
  assert.equal((await cli(decisionWorker.wrapperPath,["knowledge",wikiId,"--revision",wikiRevision])).body,wikiBody);
  const secondContext=await cli(decisionWorker.wrapperPath,["context",secondTaskId]);
  assert.equal(secondContext.status,"complete",JSON.stringify(secondContext.failures));
  assert.equal(secondContext.externalReferences.some((item:{body:string})=>item.body===gitBody),true);
  assert.equal(secondContext.externalReferences.some((item:{body:string})=>item.body===wikiBody),true);
  const decisionId=randomUUID();
  assert.equal((await workerCommand(decisionWorker.wrapperPath,{type:"worker.decision",decisionId,
    dispatchId:secondDispatch.entityId,runId:secondRunId,kind:"waiting",reason:"No new approved source",evidenceRefs:[]})).entityId,decisionId);
  assert.equal((await cli(decisionWorker.wrapperPath,["get",`/api/projects/${projectId}/orchestration/decisions/${decisionId}`])).reason,
    "No new approved source");
  const unknown=randomUUID();
  assert.equal((await cli(wrapper,["operation",unknown],1)).error?.code,"OPERATION_NOT_FOUND");
  assert.equal((await cli(wrapper,["task",randomUUID()],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["project",randomUUID()],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["list","tasks"],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["read","goal",randomUUID()],1)).error?.code,"FORBIDDEN");
  assert.equal((await cli(wrapper,["get",`/api/projects/${projectId}/runtime`],1)).error?.code,"FORBIDDEN");
  assert.equal((await workerCommand(wrapper,{type:"runtime.session.reserve",sessionId:randomUUID(),roleId:cognitiveRole,
    cwd:directory,authorizationScope:cognitiveScope,sandbox:"read-only",approvalPolicy:"on-request"},1)).error?.code,"FORBIDDEN");
  assert.ok(run.revisionId);
});
