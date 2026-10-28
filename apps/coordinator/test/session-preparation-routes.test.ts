import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { buildServer } from "../src/server.js";

const projectId="00000000-0000-4000-8000-000000000001";
const roleId="00000000-0000-4000-8000-000000000002";
const sessionId="00000000-0000-4000-8000-000000000003";
const revisionId="00000000-0000-4000-8000-000000000004";
const token="r".repeat(40),readerToken="s".repeat(40);

test("preparation reports a real readiness snapshot only to the project reviewer",async()=>{
  const role={id:roleId,version:2,currentRevisionId:revisionId,state:"active",proposal:{goal:"Goal",independentResponsibility:"Responsibility",
    workflow:"Workflow",handoffBoundary:"Boundary"}};
  const empty=async()=>[];
  const service={getProject:async()=>({id:projectId}),getRole:async()=>role,getRuntimeSession:async()=>{
    throw new DomainError("NOT_FOUND","missing");
  },listRoleSessionBindings:empty,listRoleRevisions:empty,listRoleReviews:empty,listRoleHandoffs:empty,
  listSchedules:empty,listScheduleRevisions:empty,listScheduleOccurrences:empty,
  listRoles:async()=>({items:[],nextCursor:null})} as unknown as WorkflowService;
  const app=await buildServer({service,credentials:[
    {token,actorId:"lead",projectIds:[projectId],permissions:["read","write","review"]},
    {token:readerToken,actorId:"reader",projectIds:[projectId],permissions:["read"]}],
    sessionPreparation:async()=>({runtimeAvailable:true,grantReady:true,cwdReady:true,
      materialCli:{actorId:"agent",command:"/private/cli",ready:true},roleActorId:"agent",
      skills:[{path:".agents/skills/evoloop-workflow/SKILL.md",commit:"a".repeat(40),contentHash:"b".repeat(64),readSubcommand:"get /fixed"}]})});
  try {
    const path=`/api/projects/${projectId}/session-preparation/${sessionId}?roleId=${roleId}&cwd=%2Fprivate%2Fproject&authorizationScope=project`;
    assert.equal((await app.inject({url:path})).statusCode,401);
    assert.equal((await app.inject({url:path,headers:{authorization:`Bearer ${readerToken}`}})).statusCode,403);
    const response=await app.inject({url:path,headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.statusCode,200);
    assert.equal(response.json().readyForTasks,false);
    assert.equal(response.json().roleRevisionId,revisionId);
    assert.equal(response.json().session,null);
  } finally {await app.close();}
});

test("existing Session requires its actual full profile, open recovery and matching queue CLI actor",async()=>{
  const role={id:roleId,version:2,currentRevisionId:revisionId,state:"active",proposal:{goal:"Goal",
    independentResponsibility:"Responsibility",workflow:"Workflow",handoffBoundary:"Boundary"}};
  const current={projectId,id:sessionId,roleId,actorId:"lead",cwd:"/private/project",authorizationScope:"project",
    model:null,sandbox:"danger-full-access",approvalPolicy:"never",state:"ready",version:3,
    nativeThreadId:"thread",nativeSessionId:"native",operationId:revisionId,
    executionProfile:null as Record<string,unknown>|null};
  const gate={phase:"open",version:1,causeId:null,decisionOperationId:null};
  let cliActor="agent";
  const empty=async()=>[];
  const service={getProject:async()=>({id:projectId}),getRole:async()=>role,getRuntimeSession:async()=>current,
    getSessionRecovery:async()=>({gate,executionProfile:current.executionProfile,partial:false,nextAction:"normal_work"}),
    getRuntimeSessionProfile:async()=>({version:1,displayName:"Agent",purpose:"Work"}),
    listRoleSessionBindings:async()=>[{sessionId}],listRoleRevisions:empty,listRoleReviews:empty,listRoleHandoffs:empty,
    listSchedules:empty,listScheduleRevisions:empty,listScheduleOccurrences:empty,
    listRoles:async()=>({items:[],nextCursor:null})} as unknown as WorkflowService;
  const app=await buildServer({service,credentials:[{token,actorId:"lead",projectIds:[projectId],permissions:["read","write","review"]}],
    sessionPreparation:async()=>({runtimeAvailable:true,grantReady:true,cwdReady:true,
      materialCli:{actorId:cliActor,command:"/private/cli",ready:true},roleActorId:"agent",
      skills:[{path:".agents/skills/evoloop-workflow/SKILL.md",commit:"a".repeat(40),
        contentHash:"b".repeat(64),readSubcommand:"get /fixed"}]})});
  const url=`/api/projects/${projectId}/session-preparation/${sessionId}?roleId=${roleId}`;
  const read=async()=>{
    const response=await app.inject({url,headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.statusCode,200);
    return response.json() as {readyForTasks:boolean;missing:string[]};
  };
  try {
    assert.equal((await read()).readyForTasks,true);
    current.sandbox="read-only";current.approvalPolicy="on-request";
    assert.deepEqual((await read()).missing,["session_execution_profile_restricted"]);
    current.sandbox="danger-full-access";current.approvalPolicy="never";
    current.executionProfile={revision:{revisionId,model:null,sandbox:"danger-full-access",approvalPolicy:"never",
      cwd:current.cwd,authorizationScope:current.authorizationScope},activationState:"pending",activeRevisionId:null,
      activationOperationId:revisionId};
    assert.deepEqual((await read()).missing,["execution_profile_pending"]);
    current.executionProfile.activationState="unknown";
    assert.deepEqual((await read()).missing,["execution_profile_unknown"]);
    current.executionProfile.activationState="active";current.executionProfile.activeRevisionId=revisionId;
    gate.phase="blocked";
    assert.deepEqual((await read()).missing,["recovery_blocked"]);
    gate.phase="open";cliActor="other-agent";
    assert.deepEqual((await read()).missing,["material_cli_actor_mismatch"]);
    cliActor="agent";
    assert.equal((await read()).readyForTasks,true);
  } finally {await app.close();}
});

test("fixed skill child read requires project authority and a bounded source trail",async()=>{
  const empty=async()=>[];
  const service={getRole:async(principal:{projectIds:string[]},project:string)=>{
    if(!principal.projectIds.includes(project))throw new DomainError("FORBIDDEN","project read required");
    return {id:roleId};
  },listRoleRevisions:empty,listRoleReviews:empty,
    listRoleHandoffs:empty,listRoleSessionBindings:empty,listSchedules:empty,
    listScheduleRevisions:empty,listScheduleOccurrences:empty,
    listRoles:async()=>({items:[],nextCursor:null})} as unknown as WorkflowService;
  const skillPath=".agents/skills/evoloop-workflow/SKILL.md";
  const sourcePath=".agents/skills/evoloop-workflow/references/writing.md";
  let seen:string[]=[];
  const app=await buildServer({service,credentials:[{token:readerToken,actorId:"reader",projectIds:[projectId],permissions:["read"]}],
    readRoleSkillSource:async(_project,_role,_name,path,via,commit,hash)=>{
      seen=[path,via,commit,hash];
      if(via!==skillPath||path!==sourcePath)return null;
      return {path,commit,contentHash:hash,body:"fixed writing",references:[],cycleReferencesOmitted:0,referenceLimitReached:false};
    }});
  try {
    const url=`/api/projects/${projectId}/roles/${roleId}/skills/evoloop-workflow/source?path=${encodeURIComponent(sourcePath)}`+
      `&via=${encodeURIComponent(skillPath)}&commit=${"a".repeat(40)}&hash=${"b".repeat(64)}`;
    assert.equal((await app.inject({url})).statusCode,401);
    const response=await app.inject({url,headers:{authorization:`Bearer ${readerToken}`}});
    assert.equal(response.statusCode,200);
    assert.equal(response.json().body,"fixed writing");
    assert.deepEqual(seen,[sourcePath,skillPath,"a".repeat(40),"b".repeat(64)]);
    const foreign=url.replace(projectId,"00000000-0000-4000-8000-000000000099");
    assert.equal((await app.inject({url:foreign,headers:{authorization:`Bearer ${readerToken}`}})).statusCode,403);
  } finally {await app.close();}
});
