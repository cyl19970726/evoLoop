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
