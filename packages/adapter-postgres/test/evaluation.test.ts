import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import type { BasisSet, Document, DocumentRevision, Project, Task, TaskRevision } from "@evoloop/contracts";
import type { EvaluationAssessment, EvaluationConclusion, EvaluationDefinition } from "@evoloop/contracts/evaluation";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for evaluation PG tests");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1)).toLowerCase();
if (!databaseName.includes("evoloop") || !databaseName.includes("test")) throw new Error("dedicated evoloop test database required");
const schema = `el_evaluation_${randomUUID().replaceAll("-", "").slice(0,16)}`;
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const actor = "evaluation-test", now = "2026-10-21T00:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const principal = (projectId: string) => ({ actorId: actor, projectIds: [projectId], permissions: ["read","write","review"] as Array<"read"|"write"|"review"> });
const workflow = new WorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID }, hasher: { hash } });
const runtime = new RuntimeWorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID } });

before(async () => { await migrate(connectionString, schema); });
after(async () => {
  await pool.end();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
});

async function seed(): Promise<{projectId:string; taskId:string; taskRevisionId:string; basisId:string; definition:EvaluationDefinition}> {
  const projectId = randomUUID(), taskId = randomUUID(), taskRevisionId = randomUUID(), basisId = randomUUID();
  const sourceId = randomUUID(), sourceRevisionId = randomUUID(), primaryId = randomUUID(), primaryRevisionId = randomUUID();
  const sourceBody = "# Fixed protocol and source", primaryBody = "# Neutral case task";
  const project: Project = { id: projectId, title: "Evaluation PG", createdAt: now };
  const doc = (id:string, revisionId:string, body:string, kind:Document["kind"]): {head:Document; revision:DocumentRevision} => ({
    head: { projectId,id,title:body,version:1,currentRevisionId:revisionId,adoptedRevisionId:null,kind,status:"draft" },
    revision: { projectId,documentId:id,id:revisionId,body,format:"markdown",mediaType:"text/markdown",
      originalName:`${id}.md`,payloadRef:null,entrypoint:null,assetsManifest:[],contentHash:hash(body),author:actor,
      createdAt:now,previousRevisionId:null,reason:"fixture" },
  });
  const source = doc(sourceId,sourceRevisionId,sourceBody,"spec"), primary = doc(primaryId,primaryRevisionId,primaryBody,"task");
  const task: Task = { projectId,id:taskId,version:1,currentRevisionId:taskRevisionId,title:"Neutral case",content:primaryBody,
    contentDocumentId:primaryId,contentRevisionId:primaryRevisionId,kind:null,acceptance:"Observe actual outcome",owner:actor,state:"in_progress" };
  const revision: TaskRevision = { projectId,taskId,id:taskRevisionId,version:1,title:task.title,content:task.content,
    contentDocumentId:primaryId,contentRevisionId:primaryRevisionId,kind:null,acceptance:task.acceptance,owner:actor,
    state:"in_progress",basisSetId:basisId,actorId:actor,reason:"fixture",createdAt:now };
  const basis: BasisSet = { projectId,taskId,taskRevisionId,id:basisId,sealed:true,
    members:[{documentId:sourceId,revisionId:sourceRevisionId},{documentId:primaryId,revisionId:primaryRevisionId}] };
  await uow.transaction(projectId,async tx => {
    await tx.insertProject(project);
    for (const item of [source,primary]) { await tx.insertDocument(item.head); await tx.insertDocumentRevision(item.revision); }
    await tx.insertTask(task); await tx.insertTaskRevision(revision); await tx.insertSealedBasisSet(basis);
  });
  const directId = randomUUID(), wikiId = randomUUID();
  const environment = { cwd:"/tmp/evoloop-evaluation-test",authorizationScope:"evaluation-case",sandbox:"read-only" as const,approvalPolicy:"on-request" as const };
  const definition: EvaluationDefinition = { ownerTaskId:taskId,question:"Does fixed Wiki change this case?",
    protocol:{kind:"document",id:sourceId,revision:sourceRevisionId,contentHash:hash(sourceBody)},
    case:{id:randomUUID(),taskId,sourceTaskRevisionId:taskRevisionId,
      sourceSignature:{title:task.title,contentDocumentId:primaryId,contentRevisionId:primaryRevisionId,
        acceptance:task.acceptance,owner:actor,kind:"unclassified",basis:[
          {documentId:primaryId,revisionId:primaryRevisionId,contentHash:hash(primaryBody)},
          {documentId:sourceId,revisionId:sourceRevisionId,contentHash:hash(sourceBody)},
        ].sort((a,b)=>a.documentId.localeCompare(b.documentId)),retentions:[],external:[]},
      commonInput:"Answer the neutral case using the fixed material.",
      materials:[{kind:"document",id:sourceId,revision:sourceRevisionId,contentHash:hash(sourceBody)}],criteria:"Check factual delivery"},
    conditions:[{id:directId,kind:"direct",wikiRefs:null,model:"test-model",environment},
      {id:wikiId,kind:"wiki",wikiRefs:[{kind:"wiki",id:"wiki-page",revision:"fixed-v1",contentHash:hash("wiki text")}],model:"test-model",environment}],
    limits:"Tool-level knowledge isolation remains unverified" };
  return {projectId,taskId,taskRevisionId,basisId,definition};
}

async function publishBasis(fixture:Awaited<ReturnType<typeof seed>>):Promise<void> {
  await uow.transaction(fixture.projectId,async tx=>{
    const basis = (await tx.getBasisSet(fixture.taskId,fixture.taskRevisionId,fixture.basisId))!;
    for (const member of basis.members) {
      const doc = (await tx.getDocument(member.documentId))!;
      await tx.insertDocumentDecision({projectId:fixture.projectId,id:randomUUID(),documentId:doc.id,
        revisionId:member.revisionId,actorId:actor,reason:"Fixed source adopted",createdAt:now});
      await tx.updateDocument({...doc,version:2,adoptedRevisionId:member.revisionId,status:"published"},1);
    }
  });
}

async function readySession(projectId:string):Promise<string> {
  const sessionId = randomUUID();
  await uow.transaction(projectId,tx=>tx.insertRuntimeSession({projectId,id:sessionId,roleId:actor,
    cwd:"/tmp/evoloop-evaluation-test",authorizationScope:"evaluation-case",model:"test-model",sandbox:"read-only",
    approvalPolicy:"on-request",state:"ready",version:1,nativeThreadId:`native-${sessionId}`,nativeSessionId:`native-${sessionId}`,
    operationId:randomUUID(),actorId:actor,createdAt:now,updatedAt:now}));
  return sessionId;
}

test("frozen evaluation revisions, project scoping and command replay use one PG transaction", async () => {
  const fixture = await seed();
  const evaluationId = randomUUID(), revisionId = randomUUID(), operationId = randomUUID();
  const command = {type:"evaluation.create" as const,projectId:fixture.projectId,operationId,evaluationId,revisionId,definition:fixture.definition};
  const applied = await workflow.execute(principal(fixture.projectId),command);
  assert.equal(applied.status,"applied");
  assert.deepEqual(await workflow.execute(principal(fixture.projectId),command),applied,"replay cannot duplicate frozen history");
  const first = await uow.read(fixture.projectId,reader=>reader.getEvaluation(evaluationId));
  assert.deepEqual(first?.definition,fixture.definition);
  assert.equal((await uow.read(fixture.projectId,reader=>reader.listEvaluations(10,undefined,fixture.taskId))).items.length,1);
  assert.equal((await uow.read(fixture.projectId,reader=>reader.listEvaluations(10,undefined,undefined,"wiki-page"))).items.length,1);
  const otherProject = randomUUID();
  await uow.transaction(otherProject,tx=>tx.insertProject({id:otherProject,title:"Other",createdAt:now}));
  assert.equal(await uow.read(otherProject,reader=>reader.getEvaluation(evaluationId)),null);
  await assert.rejects(uow.transaction(otherProject,tx=>tx.insertEvaluationRevision({...first!,projectId:otherProject,evaluationId:randomUUID(),id:randomUUID(),version:1})),/foreign key/);
  const secondId = randomUUID();
  const revised = await workflow.execute(principal(fixture.projectId),{type:"evaluation.revise",projectId:fixture.projectId,
    operationId:randomUUID(),evaluationId,revisionId:secondId,expectedVersion:1,definition:fixture.definition,reason:"Keep frozen case with a new version"});
  assert.equal(revised.status,"applied");
  assert.equal((await uow.read(fixture.projectId,reader=>reader.getEvaluation(evaluationId)))?.id,secondId);
  assert.equal((await uow.read(fixture.projectId,reader=>reader.getEvaluation(evaluationId,revisionId)))?.id,revisionId);
  const anotherEvaluationId=randomUUID();
  assert.equal((await workflow.execute(principal(fixture.projectId),{type:"evaluation.create",projectId:fixture.projectId,
    operationId:randomUUID(),evaluationId:anotherEvaluationId,revisionId:randomUUID(),definition:fixture.definition})).status,"applied");
  const page1=await uow.read(fixture.projectId,reader=>reader.listEvaluations(1,undefined,undefined,"wiki-page"));
  assert.ok(page1.nextCursor);
  const page2=await uow.read(fixture.projectId,reader=>reader.listEvaluations(1,page1.nextCursor!,undefined,"wiki-page"));
  assert.equal(page2.nextCursor,null);
  assert.deepEqual([page1.items[0]?.evaluationId,page2.items[0]?.evaluationId].sort(),
    [evaluationId,anotherEvaluationId].sort(),"each evaluation appears once despite multiple matching revisions");
  await assert.rejects(pool.query("UPDATE evaluation_revision SET reason='changed' WHERE project_id=$1 AND evaluation_id=$2",[fixture.projectId,evaluationId]),/immutable/);
});

test("attempt binds Run and fixed revision; corrections append, missing cost remains null and packet is immutable", async () => {
  const fixture = await seed();
  const evaluationId = randomUUID(), revisionId = randomUUID();
  assert.equal((await workflow.execute(principal(fixture.projectId),{type:"evaluation.create",projectId:fixture.projectId,
    operationId:randomUUID(),evaluationId,revisionId,definition:fixture.definition})).status,"applied");
  const secondRevisionId=randomUUID();
  const secondDefinition=structuredClone(fixture.definition);
  secondDefinition.conditions[1].wikiRefs![0]!.id="wiki-page-b";
  assert.equal((await workflow.execute(principal(fixture.projectId),{type:"evaluation.revise",projectId:fixture.projectId,
    operationId:randomUUID(),evaluationId,revisionId:secondRevisionId,expectedVersion:1,
    definition:secondDefinition,reason:"Compare a different frozen Wiki source"})).status,"applied");
  const actualTaskRevisionId = randomUUID(), actualBasisId = randomUUID();
  await uow.transaction(fixture.projectId,async tx=>{
    const head = (await tx.getTask(fixture.taskId))!;
    const source = (await tx.getTaskRevision(fixture.taskId,fixture.taskRevisionId))!;
    const sourceBasis = (await tx.getBasisSet(fixture.taskId,fixture.taskRevisionId,fixture.basisId))!;
    await tx.insertTaskRevision({...source,id:actualTaskRevisionId,version:2,basisSetId:actualBasisId,reason:"Run reservation fixture"});
    await tx.insertSealedBasisSet({...sourceBasis,id:actualBasisId,taskRevisionId:actualTaskRevisionId});
    await tx.updateTask({...head,version:2,currentRevisionId:actualTaskRevisionId},1);
  });
  const runId = randomUUID(), sessionId = randomUUID(), attemptId = randomUUID();
  const session: RuntimeSessionRecord = {projectId:fixture.projectId,id:sessionId,roleId:actor,cwd:"/tmp/evoloop-evaluation-test",
    authorizationScope:"evaluation-case",model:"test-model",sandbox:"read-only",approvalPolicy:"on-request",state:"reserved",
    version:1,nativeThreadId:null,nativeSessionId:null,operationId:randomUUID(),actorId:actor,createdAt:now,updatedAt:now};
  const binding = {evaluationId,revisionId,caseId:fixture.definition.case.id,
    conditionId:fixture.definition.conditions[0].id,sourceTaskRevisionId:fixture.taskRevisionId,
    actualTaskRevisionId,attemptId};
  const run:RuntimeRunRecord = {projectId:fixture.projectId,id:runId,taskId:fixture.taskId,taskRevisionId:actualTaskRevisionId,
    basisSetId:actualBasisId,sessionId,operationId:randomUUID(),input:fixture.definition.case.commonInput,
    inputHash:hash(fixture.definition.case.commonInput),state:"requested",version:1,nativeTurnId:null,
    interruptRequested:false,resultSummary:null,actorId:actor,createdAt:now,updatedAt:now,evaluationBinding:binding,evaluationPacket:null};
  await uow.transaction(fixture.projectId,async tx=>{
    await tx.insertRuntimeSession(session); await tx.insertRuntimeRun(run);
    await tx.insertEvaluationAttempt({projectId:fixture.projectId,id:attemptId,evaluationId,revisionId,
      caseId:binding.caseId,conditionId:binding.conditionId,ordinal:1,runId,sourceTaskRevisionId:fixture.taskRevisionId,
      actualTaskRevisionId,sessionId,actorId:actor,createdAt:now});
  });
  assert.equal((await uow.read(fixture.projectId,reader=>reader.listEvaluationAttempts(evaluationId,revisionId))).length,1);
  assert.deepEqual((await uow.read(fixture.projectId,reader=>reader.getRuntimeRun(runId)))?.evaluationBinding,binding);
  const packet = {payloadRef:"blob:fixed",contentHash:hash("packet"),manifestHash:hash("manifest"),builderVersion:"v1",sources:[]};
  await uow.transaction(fixture.projectId,tx=>tx.updateRuntimeRun({...run,version:2,evaluationPacket:packet},1));
  assert.deepEqual((await uow.read(fixture.projectId,reader=>reader.getRuntimeRun(runId)))?.evaluationPacket,packet);
  await assert.rejects(uow.transaction(fixture.projectId,tx=>tx.updateRuntimeRun({...run,version:3,evaluationPacket:{...packet,payloadRef:"blob:other"}},2)),/immutable/);
  await uow.transaction(fixture.projectId,tx=>tx.updateRuntimeRun({...run,version:3,state:"failed",evaluationPacket:packet,resultSummary:"Provider rejected turn"},2));
  assert.equal((await uow.read(fixture.projectId,reader=>reader.getRuntimeRun(runId)))?.state,"failed");
  assert.equal((await uow.read(fixture.projectId,reader=>reader.listEvaluationAttempts(evaluationId,revisionId))).length,1,
    "failed Runs retain the attempted condition");
  const wrongDeliveryId = randomUUID();
  await uow.transaction(fixture.projectId,tx=>tx.insertDelivery({projectId:fixture.projectId,id:wrongDeliveryId,
    taskId:fixture.taskId,taskRevisionId:fixture.taskRevisionId,artifactRef:"test:old",artifactRevision:"v1",
    contentHash:hash("old"),technicalResult:"passed",technicalEvidence:"Old version",reason:"fixture",actorId:actor,createdAt:now}));
  const values:EvaluationAssessment["values"] = {sourceFidelity:"unknown",knowledgeAdoption:"not_applicable",deliveryQuality:"unknown",humanEffect:"unknown"};
  const firstId = randomUUID();
  const first:EvaluationAssessment = {projectId:fixture.projectId,id:firstId,evaluationId,revisionId,attemptId,
    deliveryId:null,observationId:null,supersedesId:null,values,costs:[{phase:"run",unit:"USD",amount:null,source:"unreported",evidence:null}],
    evidence:[],assessorKind:"human",actorId:actor,reason:"Cost unobserved",createdAt:now};
  await assert.rejects(uow.transaction(fixture.projectId,tx=>tx.insertEvaluationAssessment({...first,id:randomUUID(),deliveryId:wrongDeliveryId})),
    /attempt Run and Task/);
  await uow.transaction(fixture.projectId,tx=>tx.insertEvaluationAssessment(first));
  const second:EvaluationAssessment = {...first,id:randomUUID(),supersedesId:firstId,reason:"Explicit correction"};
  await uow.transaction(fixture.projectId,tx=>tx.insertEvaluationAssessment(second));
  const costs = (await uow.read(fixture.projectId,reader=>reader.listEvaluationAssessments(evaluationId,revisionId))).map(x=>x.costs[0]?.amount);
  assert.deepEqual(costs,[null,null]);
  const conclusion:EvaluationConclusion = {projectId:fixture.projectId,id:randomUUID(),evaluationId,revisionId,
    assessmentIds:[second.id],supersedesId:null,finding:"Evidence remains unknown",limits:"One direct attempt only",
    comparability:"unknown",comparabilityReason:"No Wiki attempt",nextChoice:"wait",affectedRefs:[],
    nextActionRef:{kind:"task",taskId:fixture.taskId,taskRevisionId:actualTaskRevisionId},
    actorId:actor,createdAt:now};
  await uow.transaction(fixture.projectId,tx=>tx.insertEvaluationConclusion(conclusion));
  const storedConclusions=await uow.read(fixture.projectId,reader=>reader.listEvaluationConclusions(evaluationId,revisionId));
  assert.equal(storedConclusions.length,1);
  assert.deepEqual(storedConclusions[0]?.nextActionRef,conclusion.nextActionRef);
  const oldWikiList=await uow.read(fixture.projectId,reader=>reader.listEvaluations(1,undefined,undefined,"wiki-page"));
  const newWikiList=await uow.read(fixture.projectId,reader=>reader.listEvaluations(1,undefined,undefined,"wiki-page-b"));
  const defaultList=await uow.read(fixture.projectId,reader=>reader.listEvaluations(1));
  assert.equal(oldWikiList.items[0]?.id,revisionId,"historical Wiki filter must return its frozen version");
  assert.equal(newWikiList.items[0]?.id,secondRevisionId);
  assert.equal(defaultList.items[0]?.id,secondRevisionId,"unfiltered list still returns current head");
  assert.equal((await uow.read(fixture.projectId,reader=>reader.listEvaluationAttempts(evaluationId,oldWikiList.items[0]!.id))).length,1);
  assert.equal((await uow.read(fixture.projectId,reader=>reader.listEvaluationConclusions(evaluationId,oldWikiList.items[0]!.id))).length,1);
  assert.deepEqual(await uow.read(fixture.projectId,reader=>reader.listEvaluationAttempts(evaluationId,secondRevisionId)),[]);
  const foreignProject=randomUUID();
  await uow.transaction(foreignProject,tx=>tx.insertProject({id:foreignProject,title:"Foreign evaluation",createdAt:now}));
  assert.deepEqual((await uow.read(foreignProject,reader=>reader.listEvaluations(10,undefined,undefined,"wiki-page"))).items,[]);
  await assert.rejects(uow.transaction(fixture.projectId,tx=>tx.insertEvaluationConclusion({...conclusion,id:randomUUID(),assessmentIds:[randomUUID()]})),/frozen revision/);
  await assert.rejects(pool.query("DELETE FROM evaluation_attempt WHERE project_id=$1 AND attempt_id=$2",[fixture.projectId,attemptId]),/immutable/);
});

test("real evaluation reserve creates derived Task revision, Run and Attempt atomically and replays once", async () => {
  const fixture = await seed();
  await publishBasis(fixture);
  const evaluationId=randomUUID(), revisionId=randomUUID();
  assert.equal((await workflow.execute(principal(fixture.projectId),{type:"evaluation.create",projectId:fixture.projectId,
    operationId:randomUUID(),evaluationId,revisionId,definition:fixture.definition})).status,"applied");
  const sessionId = await readySession(fixture.projectId);
  const command = {type:"runtime.run.reserve" as const,projectId:fixture.projectId,operationId:randomUUID(),runId:randomUUID(),
    taskId:fixture.taskId,sessionId,expectedVersion:1,input:fixture.definition.case.commonInput,
    evaluation:{evaluationId,revisionId,caseId:fixture.definition.case.id,conditionId:fixture.definition.conditions[0].id}};
  const result = await workflow.execute(principal(fixture.projectId),command);
  assert.equal(result.status,"applied",JSON.stringify(result));
  assert.deepEqual(await workflow.execute(principal(fixture.projectId),command),result);
  const run = (await uow.read(fixture.projectId,reader=>reader.getRuntimeRun(command.runId)))!;
  const attempts = await uow.read(fixture.projectId,reader=>reader.listEvaluationAttempts(evaluationId,revisionId));
  const task = (await uow.read(fixture.projectId,reader=>reader.getTask(fixture.taskId)))!;
  assert.equal(attempts.length,1);
  assert.equal(run.evaluationBinding?.attemptId,attempts[0]?.id);
  assert.equal(run.evaluationBinding?.sourceTaskRevisionId,fixture.taskRevisionId);
  assert.equal(run.evaluationBinding?.actualTaskRevisionId,task.currentRevisionId);
  assert.notEqual(task.currentRevisionId,fixture.taskRevisionId);
  assert.equal(attempts[0]?.actualTaskRevisionId,task.currentRevisionId);
  assert.equal(run.evaluationPacket,null);
});

test("changed external head rejects real reserve and leaves source Task, Run and Attempt untouched", async () => {
  const fixture = await seed();
  await publishBasis(fixture);
  const slotId=randomUUID(), firstDecisionId=randomUUID(), secondDecisionId=randomUUID();
  const firstRef = {referenceId:"git:fixed-source",revision:"commit-1",contentHash:hash("git-one")};
  await pool.query(`INSERT INTO task_external_ref_decision(project_id,decision_id,task_id,origin_task_revision_id,slot_id,slot_version,
    decision,source_kind,reference_id,source_revision,content_hash,observed_current_revision,observed_current_hash,
    observed_current_validity,reason,action_impact,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,1,'adopt','git',$6,$7,$8,$7,$8,'valid','freeze','read source',$9,$10)`,
    [fixture.projectId,firstDecisionId,fixture.taskId,fixture.taskRevisionId,slotId,
      firstRef.referenceId,firstRef.revision,firstRef.contentHash,actor,now]);
  await pool.query("INSERT INTO task_external_ref_head(project_id,task_id,slot_id,slot_version,decision_id) VALUES($1,$2,$3,1,$4)",
    [fixture.projectId,fixture.taskId,slotId,firstDecisionId]);
  await pool.query("INSERT INTO task_external_ref_snapshot(project_id,task_id,task_revision_id,slot_id,slot_version,decision_id) VALUES($1,$2,$3,$4,1,$5)",
    [fixture.projectId,fixture.taskId,fixture.taskRevisionId,slotId,firstDecisionId]);
  fixture.definition.case.sourceSignature.external=[{slotId,kind:"git",...firstRef}];
  const evaluationId=randomUUID(), revisionId=randomUUID();
  assert.equal((await workflow.execute(principal(fixture.projectId),{type:"evaluation.create",projectId:fixture.projectId,
    operationId:randomUUID(),evaluationId,revisionId,definition:fixture.definition})).status,"applied");
  const sessionId=await readySession(fixture.projectId);
  const secondRef={referenceId:"git:changed-source",revision:"commit-2",contentHash:hash("git-two")};
  await pool.query(`INSERT INTO task_external_ref_decision(project_id,decision_id,task_id,origin_task_revision_id,slot_id,slot_version,
    decision,source_kind,reference_id,source_revision,content_hash,observed_current_revision,observed_current_hash,
    observed_current_validity,reason,action_impact,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,2,'replace','git',$6,$7,$8,$7,$8,'valid','changed','read new source',$9,$10)`,
    [fixture.projectId,secondDecisionId,fixture.taskId,fixture.taskRevisionId,slotId,
      secondRef.referenceId,secondRef.revision,secondRef.contentHash,actor,now]);
  await pool.query("UPDATE task_external_ref_head SET slot_version=2,decision_id=$4 WHERE project_id=$1 AND task_id=$2 AND slot_id=$3",
    [fixture.projectId,fixture.taskId,slotId,secondDecisionId]);
  const runId=randomUUID(), operationId=randomUUID();
  const result=await workflow.execute(principal(fixture.projectId),{type:"runtime.run.reserve",projectId:fixture.projectId,
    operationId,runId,taskId:fixture.taskId,sessionId,expectedVersion:1,input:fixture.definition.case.commonInput,
    evaluation:{evaluationId,revisionId,caseId:fixture.definition.case.id,conditionId:fixture.definition.conditions[0].id}});
  assert.equal(result.status,"rejected");
  if (result.status==="rejected") assert.equal(result.code,"EVALUATION_EXTERNAL_CHANGED");
  assert.equal((await uow.read(fixture.projectId,reader=>reader.getTask(fixture.taskId)))?.currentRevisionId,fixture.taskRevisionId);
  assert.equal(await uow.read(fixture.projectId,reader=>reader.getRuntimeRun(runId)),null);
  assert.deepEqual(await uow.read(fixture.projectId,reader=>reader.listEvaluationAttempts(evaluationId,revisionId)),[]);
  assert.equal((await uow.read(fixture.projectId,reader=>reader.getOperation(operationId)))?.result.status,"rejected");
});

test("014 and 015 upgrade an ordinary Run and old delivery without changing identity or attribution", async () => {
  const legacySchema=`el_eval_upgrade_${randomUUID().replaceAll("-","").slice(0,12)}`;
  const migrations=fileURLToPath(new URL("../migrations/",import.meta.url));
  const legacyClient=new pg.Client({connectionString,options:`-c search_path=${legacySchema}`});
  try {
    await runner({databaseUrl:connectionString!,dir:migrations,migrationsTable:"pgmigrations",schema:legacySchema,
      createSchema:true,createMigrationsSchema:true,direction:"up",singleTransaction:true,count:12,log:()=>{}});
    await legacyClient.connect();
    const projectId=randomUUID(),taskId=randomUUID(),taskRevisionId=randomUUID(),basisId=randomUUID();
    const docId=randomUUID(),docRevisionId=randomUUID(),sessionId=randomUUID(),runId=randomUUID(),deliveryId=randomUUID();
    const input="Ordinary Run before evaluation migration";
    await legacyClient.query("BEGIN");
    try {
      await legacyClient.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Existing project',$2)",[projectId,now]);
      await legacyClient.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
        VALUES($1,$2,'Task body',1,$3,NULL,'task','draft')`,[projectId,docId,docRevisionId]);
      await legacyClient.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason)
        VALUES($1,$2,$3,'# Existing','markdown',$4,$5,$6,NULL,'fixture')`,[projectId,docId,docRevisionId,hash("# Existing"),actor,now]);
      await legacyClient.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id)
        VALUES($1,$2,1,$3,'Existing','Check', $4,'in_progress',NULL,$5,$6)`,[projectId,taskId,taskRevisionId,actor,docId,docRevisionId]);
      await legacyClient.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
        VALUES($1,$2,$3,1,'Existing','Check',$4,'in_progress',NULL,$5,$6,$7,$4,'fixture',$8)`,
        [projectId,taskId,taskRevisionId,actor,docId,docRevisionId,basisId,now]);
      await legacyClient.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)",
        [projectId,taskId,taskRevisionId,basisId]);
      await legacyClient.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id)
        VALUES($1,$2,$3,$4,$5,$6)`,[projectId,taskId,taskRevisionId,basisId,docId,docRevisionId]);
      await legacyClient.query("UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3",[projectId,taskId,taskRevisionId]);
      await legacyClient.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,approval_policy,state,version,
        native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
        VALUES($1,$2,$3,'/tmp','ordinary','test-model','read-only','on-request','reserved',1,NULL,NULL,$4,$3,$5,$5)`,
        [projectId,sessionId,actor,randomUUID(),now]);
      await legacyClient.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,
        state,version,native_turn_id,interrupt_requested,result_summary,actor_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested',1,NULL,false,NULL,$10,$11,$11)`,
        [projectId,runId,taskId,taskRevisionId,basisId,sessionId,randomUUID(),input,hash(input),actor,now]);
      await legacyClient.query("COMMIT");
    } catch(error) { await legacyClient.query("ROLLBACK"); throw error; }
    await runner({databaseUrl:connectionString!,dir:migrations,migrationsTable:"pgmigrations",schema:legacySchema,
      createSchema:true,createMigrationsSchema:true,direction:"up",singleTransaction:true,count:2,log:()=>{}});
    await legacyClient.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,
      content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'artifact:pre-015','v1',$5,'failed','Preexisting output','Legacy registration',$6,$7)`,
      [projectId,deliveryId,taskId,taskRevisionId,hash("pre-015"),actor,now]);
    await migrate(connectionString!,legacySchema);
    const legacyPool=new pg.Pool({connectionString,options:`-c search_path=${legacySchema}`});
    try {
      const migrated=new PostgresUnitOfWork(legacyPool);
      const original=(await migrated.read(projectId,reader=>reader.getRuntimeRun(runId)))!;
      assert.equal(original.id,runId); assert.equal(original.inputHash,hash(input));
      assert.equal(original.evaluationBinding,null); assert.equal(original.evaluationPacket,null);
      assert.equal((await migrated.read(projectId,reader=>reader.getDelivery(deliveryId)))?.runId,null);
      await migrated.transaction(projectId,tx=>tx.updateRuntimeRun({...original,version:2,state:"failed",resultSummary:"Known failure"},1));
      const updated=(await migrated.read(projectId,reader=>reader.getRuntimeRun(runId)))!;
      assert.equal(updated.state,"failed"); assert.equal(updated.evaluationBinding,null); assert.equal(updated.evaluationPacket,null);
    } finally { await legacyPool.end(); }
  } finally {
    await legacyClient.end().catch(()=>{});
    const cleanup=new pg.Client({connectionString}); await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`); } finally { await cleanup.end(); }
  }
});

async function officialCase() {
  const projectId=randomUUID(), taskId=randomUUID(), sourceId=randomUUID(), evaluationId=randomUUID(), evaluationRevisionId=randomUUID();
  const p=principal(projectId);
  const apply=async (command: Parameters<typeof workflow.execute>[1]) => {
    const result=await workflow.execute(p,command);
    assert.equal(result.status,"applied",JSON.stringify(result));
    return result;
  };
  await apply({type:"project.create",projectId,operationId:randomUUID(),title:"Official evaluation journey"});
  const sourceBody="# Fixed evaluation protocol";
  const source=await apply({type:"document.create",projectId,operationId:randomUUID(),documentId:sourceId,
    title:"Protocol",body:sourceBody,kind:"spec"});
  await apply({type:"document.publish",projectId,operationId:randomUUID(),documentId:sourceId,
    expectedVersion:1,revisionId:source.revisionId!,reason:"Freeze common source"});
  await apply({type:"task.create",projectId,operationId:randomUUID(),taskId,title:"Compare fixed sources",
    content:"# Produce a fixed answer",acceptance:"Check answer against protocol",owner:actor,documentIds:[sourceId]});
  await apply({type:"task.start",projectId,operationId:randomUUID(),taskId,expectedVersion:1,
    basis:[{documentId:sourceId,revisionId:source.revisionId!}],reason:"Seal comparison inputs"});
  const frozen=await workflow.getEvaluationSourceTask(p,projectId,taskId);
  const environment={cwd:"/tmp/evoloop-evaluation-test",authorizationScope:"evaluation-case",
    sandbox:"read-only" as const,approvalPolicy:"on-request" as const};
  const directId=randomUUID(),wikiId=randomUUID(),caseId=randomUUID();
  const protocol={kind:"document" as const,id:sourceId,revision:source.revisionId!,contentHash:hash(sourceBody)};
  const definition:EvaluationDefinition={ownerTaskId:taskId,question:"Does the fixed Wiki change this answer?",protocol,
    case:{id:caseId,taskId,sourceTaskRevisionId:frozen.sourceTaskRevisionId,sourceSignature:frozen.sourceSignature,
      commonInput:"Answer using the fixed protocol",materials:[protocol],criteria:"Compare the two fixed deliveries"},
    conditions:[{id:directId,kind:"direct",wikiRefs:null,model:"test-model",environment},
      {id:wikiId,kind:"wiki",wikiRefs:[{kind:"wiki",id:"wiki-fixed",revision:"v1",contentHash:hash("wiki-fixed-v1")}],
        model:"test-model",environment}],limits:"Technical isolation and downstream effects are unverified"};
  await apply({type:"evaluation.create",projectId,operationId:randomUUID(),evaluationId,
    revisionId:evaluationRevisionId,definition});
  return {projectId,taskId,evaluationId,evaluationRevisionId,definition,apply};
}

async function officialRun(fixture:Awaited<ReturnType<typeof officialCase>>, conditionIndex:0|1,
  terminal:"completed"|"failed", markUnknown=false) {
  const {projectId,taskId,evaluationId,evaluationRevisionId,definition,apply}=fixture;
  const sessionId=randomUUID(),runId=randomUUID(),turnId=`turn-${randomUUID()}`;
  const condition=definition.conditions[conditionIndex];
  await apply({type:"runtime.session.reserve",projectId,operationId:randomUUID(),sessionId,roleId:actor,
    cwd:condition.environment.cwd,authorizationScope:condition.environment.authorizationScope,
    model:condition.model,sandbox:condition.environment.sandbox,approvalPolicy:condition.environment.approvalPolicy});
  await runtime.beginSessionCreate(projectId,sessionId);
  const reservedSession=(await uow.read(projectId,reader=>reader.getRuntimeSession(sessionId)))!;
  await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,roleId:actor,
    cwd:condition.environment.cwd,authorizationScope:condition.environment.authorizationScope,
    nativeThreadId:`thread-${sessionId}`,nativeSessionId:`native-${sessionId}`,
    resumeProfile:{actorId:reservedSession.actorId,model:reservedSession.model,sandbox:reservedSession.sandbox,
      approvalPolicy:reservedSession.approvalPolicy,executionProfileRevisionId:reservedSession.executionProfile!.revision.revisionId}});
  const taskBefore=(await uow.read(projectId,reader=>reader.getTask(taskId)))!;
  await apply({type:"runtime.run.reserve",projectId,operationId:randomUUID(),runId,taskId,sessionId,
    expectedVersion:taskBefore.version,input:definition.case.commonInput,
    evaluation:{evaluationId,revisionId:evaluationRevisionId,caseId:definition.case.id,conditionId:condition.id}});
  const run=(await uow.read(projectId,reader=>reader.getRuntimeRun(runId)))!;
  const refs=[definition.protocol,...definition.case.materials,
    ...definition.case.sourceSignature.basis.map(x=>({kind:"document" as const,id:x.documentId,revision:x.revisionId,contentHash:x.contentHash})),
    ...(condition.wikiRefs??[])];
  const sources=[...new Map(refs.map(x=>[`${x.kind}:${x.id}:${x.revision}:${x.contentHash}`,x])).values()];
  await runtime.attachEvaluationPacket(projectId,runId,run.version,{payloadRef:`blob:${runId}`,
    contentHash:hash(`packet-${runId}`),manifestHash:hash(`manifest-${runId}`),builderVersion:"test-v1",sources});
  await runtime.beginDispatch(projectId,runId);
  if (markUnknown) await runtime.markRunUnknown(projectId,runId,"Test uncertain native start");
  else await runtime.bindTurn(projectId,runId,{id:turnId},{kind:"startReply",operationId:run.operationId});
  return {runId,sessionId,turnId,run,finish:async()=>{
    if (markUnknown) await runtime.bindTurn(projectId,runId,{id:turnId},{kind:"historyMarker",operationId:run.operationId});
    await runtime.recordTurn(projectId,runId,turnId,terminal,terminal==="failed"?"Fixed provider failure":"Fixed response received");
  }};
}

test("official commands attribute two terminal evaluation Runs to later deliveries and complete both assessments", async () => {
  const fixture=await officialCase();
  const direct=await officialRun(fixture,0,"completed"); await direct.finish();
  const wiki=await officialRun(fixture,1,"failed",true);
  const {projectId,taskId,evaluationId,evaluationRevisionId,apply}=fixture;
  const attemptedWhileUnknown=await workflow.execute(principal(projectId),{type:"delivery.record",projectId,
    operationId:randomUUID(),taskId,runId:direct.runId,expectedVersion:4,artifactRef:"artifact:early",
    artifactRevision:"v1",contentHash:hash("early"),technicalResult:"passed",technicalEvidence:"Fixed check",reason:"Too early"});
  assert.equal(attemptedWhileUnknown.status,"rejected");
  if (attemptedWhileUnknown.status==="rejected") assert.equal(attemptedWhileUnknown.code,"TASK_BUSY");
  await wiki.finish();
  const attempts=await uow.read(projectId,reader=>reader.listEvaluationAttempts(evaluationId,evaluationRevisionId));
  assert.equal(attempts.length,2);
  const directAttempt=attempts.find(x=>x.runId===direct.runId)!;
  const wikiAttempt=attempts.find(x=>x.runId===wiki.runId)!;
  const makeDelivery=(runId:string,expectedVersion:number,technicalResult:"passed"|"failed",artifact:string)=>({
    type:"delivery.record" as const,projectId,operationId:randomUUID(),taskId,runId,expectedVersion,
    artifactRef:`artifact:${artifact}`,artifactRevision:"v1",contentHash:hash(artifact),technicalResult,
    technicalEvidence:technicalResult==="failed"?"Failure output retained":"Fixed check passed",reason:"Register fixed Run output"});
  const firstCommand=makeDelivery(direct.runId,4,"passed","direct-output");
  const first=await apply(firstCommand);
  assert.deepEqual(await workflow.execute(principal(projectId),firstCommand),first,"operation replay is idempotent");
  const second=await apply(makeDelivery(wiki.runId,5,"failed","failed-wiki-output"));
  const deliveries=await uow.read(projectId,reader=>reader.listDeliveries(taskId));
  assert.equal(deliveries.length,2);
  const directDelivery=deliveries.find(x=>x.id===first.revisionId)!;
  const wikiDelivery=deliveries.find(x=>x.id===second.revisionId)!;
  assert.equal(directDelivery.runId,direct.runId); assert.equal(wikiDelivery.runId,wiki.runId);
  assert.notEqual(directDelivery.taskRevisionId,direct.run.taskRevisionId);
  assert.notEqual(wikiDelivery.taskRevisionId,wiki.run.taskRevisionId);
  assert.equal(wikiDelivery.technicalResult,"failed");
  assert.equal((await uow.read(projectId,reader=>reader.getRuntimeRun(wiki.runId)))?.state,"failed");
  const observations=[];
  for (const delivery of [directDelivery,wikiDelivery]) {
    const recorded=await apply({type:"observation.record",projectId,operationId:randomUUID(),taskId,
      deliveryId:delivery.id,observer:actor,observerKind:"agent",result:"notUsed",
      evidence:"No downstream use observed",reason:"Record observed non-use"});
    observations.push(recorded.revisionId!);
  }
  const values=(directCondition:boolean)=>({sourceFidelity:"unknown" as const,
    knowledgeAdoption:directCondition?"not_applicable" as const:"not_observed" as const,
    deliveryQuality:"unknown" as const,humanEffect:"unknown" as const});
  const assessmentIds=[];
  for (const [attempt,delivery,observation,directCondition] of [
    [directAttempt,directDelivery,observations[0],true],[wikiAttempt,wikiDelivery,observations[1],false]
  ] as const) {
    const assessmentId=randomUUID();
    await apply({type:"evaluation.assessment.record",projectId,operationId:randomUUID(),evaluationId,
      revisionId:evaluationRevisionId,assessmentId,attemptId:attempt.id,deliveryId:delivery.id,
      observationId:observation,supersedesId:null,values:values(directCondition),
      costs:[{phase:"run",unit:"USD",amount:null,source:"not reported",evidence:null}],evidence:[],
      assessorKind:"agent",reason:"Record actual outcome and unknown cost"});
    assessmentIds.push(assessmentId);
  }
  const wrong=await workflow.execute(principal(projectId),{type:"evaluation.assessment.record",projectId,
    operationId:randomUUID(),evaluationId,revisionId:evaluationRevisionId,assessmentId:randomUUID(),
    attemptId:directAttempt.id,deliveryId:wikiDelivery.id,observationId:null,supersedesId:assessmentIds[0],
    values:values(true),costs:[],evidence:[],assessorKind:"agent",reason:"Wrong Run delivery"});
  assert.equal(wrong.status,"rejected");
  if (wrong.status==="rejected") assert.equal(wrong.code,"DELIVERY_MISMATCH");
  const conclusion=await apply({type:"evaluation.conclusion.record",projectId,operationId:randomUUID(),evaluationId,
    revisionId:evaluationRevisionId,conclusionId:randomUUID(),assessmentIds,supersedesId:null,
    finding:"Both fixed outputs recorded; comparative effect remains unknown",limits:"Failed Wiki Run and unknown cost",
    comparability:"with_limits",comparabilityReason:"Only one completed and one failed Run",
    nextChoice:"research",affectedRefs:[],nextActionRef:null});
  assert.equal(conclusion.status,"applied");
  assert.equal((await uow.read(projectId,reader=>reader.listEvaluationConclusions(evaluationId,evaluationRevisionId))).length,1);
});

test("official delivery attribution rejects foreign Runs and preserves legacy null attribution", async () => {
  const fixture=await officialCase();
  const source=await officialRun(fixture,0,"completed"); await source.finish();
  const {projectId,taskId,apply}=fixture;
  const otherTaskId=randomUUID();
  await apply({type:"task.create",projectId,operationId:randomUUID(),taskId:otherTaskId,title:"Other case",
    content:"# Other case",acceptance:"Different acceptance",owner:actor});
  await apply({type:"task.start",projectId,operationId:randomUUID(),taskId:otherTaskId,expectedVersion:1,
    reason:"Start unrelated case"});
  const command=(pid:string,tid:string,runId:string|undefined,version:number)=>({type:"delivery.record" as const,
    projectId:pid,operationId:randomUUID(),taskId:tid,...(runId?{runId}:{}),expectedVersion:version,
    artifactRef:"artifact:fixed",artifactRevision:"v1",contentHash:hash("fixed"),technicalResult:"passed" as const,
    technicalEvidence:"Known fixed output",reason:"Attribute source Run"});
  const otherTask=await workflow.execute(principal(projectId),command(projectId,otherTaskId,source.runId,2));
  assert.equal(otherTask.status,"rejected");
  if (otherTask.status==="rejected") assert.equal(otherTask.code,"DELIVERY_RUN_MISMATCH");
  const otherHead=(await uow.read(projectId,reader=>reader.getTask(otherTaskId)))!;
  await assert.rejects(pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,
    artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'artifact:invalid','v1',$6,'passed','check','wrong Task',$7,$8)`,
    [projectId,randomUUID(),otherTaskId,otherHead.currentRevisionId,source.runId,hash("invalid"),actor,now]),/foreign key/);
  const otherProjectId=randomUUID(),foreignTaskId=randomUUID();
  const foreign=async(c:Parameters<typeof workflow.execute>[1])=>{
    const result=await workflow.execute(principal(otherProjectId),c);
    assert.equal(result.status,"applied",JSON.stringify(result)); return result;
  };
  await foreign({type:"project.create",projectId:otherProjectId,operationId:randomUUID(),title:"Other project"});
  await foreign({type:"task.create",projectId:otherProjectId,operationId:randomUUID(),taskId:foreignTaskId,
    title:"Foreign task",content:"# Foreign",acceptance:"Foreign check",owner:actor});
  await foreign({type:"task.start",projectId:otherProjectId,operationId:randomUUID(),taskId:foreignTaskId,
    expectedVersion:1,reason:"Start foreign task"});
  const foreignRun=await workflow.execute(principal(otherProjectId),command(otherProjectId,foreignTaskId,source.runId,2));
  assert.equal(foreignRun.status,"rejected");
  if (foreignRun.status==="rejected") assert.equal(foreignRun.code,"NOT_FOUND");
  const old=await apply(command(projectId,taskId,undefined,3));
  assert.equal((await uow.read(projectId,reader=>reader.getDelivery(old.revisionId!)))?.runId,null);
  await assert.rejects(pool.query("UPDATE delivery SET run_id=$3 WHERE project_id=$1 AND delivery_id=$2",
    [projectId,old.revisionId,source.runId]),/append-only/);
  assert.equal((await uow.read(projectId,reader=>reader.listDeliveries(taskId))).length,1);
});

test("official delivery attribution rejects body, acceptance and sealed basis drift after terminal Run", async () => {
  for (const change of ["body","acceptance","basis"] as const) {
    const fixture=await officialCase();
    const source=await officialRun(fixture,0,"completed"); await source.finish();
    const {projectId,taskId,apply}=fixture;
    const task=(await uow.read(projectId,reader=>reader.getTask(taskId)))!;
    await apply({type:"task.reopen",projectId,operationId:randomUUID(),taskId,expectedVersion:task.version,
      reason:`Reopen to change ${change}`});
    const current=(await uow.read(projectId,reader=>reader.getTask(taskId)))!;
    await apply({type:"task.update",projectId,operationId:randomUUID(),taskId,expectedVersion:current.version,
      title:current.title,content:change==="body"?"# Changed answer scope":current.content,
      acceptance:change==="acceptance"?"Check a different answer":current.acceptance,owner:current.owner,
      reason:`Change ${change}`});
    const updated=(await uow.read(projectId,reader=>reader.getTask(taskId)))!;
    await apply({type:"task.start",projectId,operationId:randomUUID(),taskId,expectedVersion:updated.version,
      ...(change==="basis"?{basis:[]}:{}),reason:`Reseal after ${change}`});
    const started=(await uow.read(projectId,reader=>reader.getTask(taskId)))!;
    const result=await workflow.execute(principal(projectId),{type:"delivery.record",projectId,
      operationId:randomUUID(),taskId,runId:source.runId,expectedVersion:started.version,
      artifactRef:"artifact:stale",artifactRevision:"v1",contentHash:hash("stale"),technicalResult:"passed",
      technicalEvidence:"Original Run output",reason:"Try stale attribution"});
    assert.equal(result.status,"rejected",`${change}: ${JSON.stringify(result)}`);
    if (result.status==="rejected") assert.equal(result.code,"DELIVERY_INPUT_CHANGED",change);
    assert.deepEqual(await uow.read(projectId,reader=>reader.listDeliveries(taskId)),[]);
  }
});
