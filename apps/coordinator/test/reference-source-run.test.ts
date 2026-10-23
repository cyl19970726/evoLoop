import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import { staticRunSessionAvailable } from "../src/references/source-run.js";

const projectId=randomUUID(),sessionId=randomUUID();
const session={projectId,id:sessionId,roleId:"researcher",cwd:"/fixture",authorizationScope:"task",
  sandbox:"read-only",state:"ready"} as RuntimeSessionRecord;
const run={projectId,sessionId,actorId:"executor"} as RuntimeRunRecord;

test("static Run sources reject persisted dynamic Sessions despite an identical static grant",async()=>{
  let grantReads=0;
  const authority={runtimeEnabled:true,isBoundDynamicSession:async()=>true,
    hasRuntimeGrant:()=>{grantReads++;return true;},allowedRuntimeCwd:async()=>true};
  assert.equal(await staticRunSessionAvailable(projectId,run,session,authority),false);
  assert.equal(grantReads,0,"a bound dynamic Session must not fall back to a colliding static grant");
  assert.equal(await staticRunSessionAvailable(projectId,run,session,{...authority,isBoundDynamicSession:async()=>false}),true,
    "the same tuple remains eligible when its actual Session is statically owned");
  assert.equal(await staticRunSessionAvailable(projectId,run,session,{...authority,runtimeEnabled:false}),false);
  assert.equal(await staticRunSessionAvailable(projectId,run,session,{...authority,
    isBoundDynamicSession:async()=>false,hasRuntimeGrant:()=>false}),false);
  assert.equal(await staticRunSessionAvailable(randomUUID(),run,session,authority),false);
});
