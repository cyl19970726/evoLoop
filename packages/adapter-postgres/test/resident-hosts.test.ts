import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const connectionString=process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required");
const name=decodeURIComponent(new URL(connectionString).pathname.slice(1)).toLowerCase();
if (!name.includes("evoloop") || !name.includes("test")) throw new Error("dedicated evoloop test database required");
const schema=`el_resident_${randomUUID().replaceAll("-","").slice(0,16)}`;
const pool=new pg.Pool({connectionString,options:`-c search_path=${schema}`});
const projectId=randomUUID(),roleId=randomUUID(),now="2026-10-25T10:00:00.000Z";
const principal={actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
const service=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>now},ids:{next:randomUUID},
  hasher:{hash:(value:string)=>createHash("sha256").update(value).digest("hex")}});
before(async()=>{
  await migrate(connectionString,schema);
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)",[projectId,"P1a test",now]);
    const revisionId=randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'active','reviewer',$4,$4)`,[projectId,roleId,revisionId,now]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'active',$4::jsonb,'reviewer','fixture',$5,$5)`,
      [projectId,roleId,revisionId,JSON.stringify({title:"Functional development",roleClass:"business"}),now]);
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});
after(async()=>{
  await pool.end();
  const cleanup=new pg.Client({connectionString});
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
});
test("026 persists domain and external manual route with immutable history",async()=>{
  const domainId=randomUUID(),linkId=randomUUID();
  const created=await service.execute(principal,{type:"domain.create",projectId,operationId:randomUUID(),domainId,
    title:"Functional development",roleId,observedRoleVersion:1,routingReason:"reviewed work allocation",
    authorizationEvidence:"accepted Role decision"});
  assert.equal(created.status,"applied");
  assert.equal((await service.getDomainRoute(principal,projectId,domainId)).status,"unlinked");
  const registered=await service.execute(principal,{type:"host.register",projectId,operationId:randomUUID(),linkId,
    roleId,expectedRoleVersion:1,host:{kind:"external",provider:"codex-desktop",ref:"chat:01a158d7"},
    claimedCapabilities:["open","read","manual-claim"],reason:"human handoff"});
  assert.equal(registered.status,"applied");
  assert.equal((await service.getDomainRoute(principal,projectId,domainId)).status,"host-unverified");
  await service.execute(principal,{type:"host.verify",projectId,operationId:randomUUID(),linkId,expectedVersion:1,
    expectedRoleVersion:1,verifiedCapabilities:["open","read","manual-claim"],
    evidence:"reviewer opened and read the chat; human accepted handoff",observedAtUtc:now,reason:"observed"});
  const route=await service.getDomainRoute(principal,projectId,domainId);
  assert.equal(route.status,"external-manual");
  assert.equal(route.automaticStart,false);
  assert.equal(route.session,null);
  assert.equal((await service.listHostLinkRevisions(principal,projectId,linkId)).length,2);
  assert.equal((await service.listBusinessDomainRevisions(principal,projectId,domainId)).length,1);
});
test("Task revisions pin the domain independently of kind and keep old revisions",async()=>{
  const domainId=randomUUID(),taskId=randomUUID();
  await service.execute(principal,{type:"domain.create",projectId,operationId:randomUUID(),domainId,
    title:"Knowledge research",roleId,observedRoleVersion:1,routingReason:"research owner",
    authorizationEvidence:"reviewed assignment"});
  const created=await service.execute(principal,{type:"task.create",projectId,operationId:randomUUID(),taskId,
    title:"Study",content:"Fixed problem",acceptance:"Evidence read",owner:"reviewer",kind:"research",domainId});
  assert.equal(created.status,"applied");
  const first=await service.getTask(principal,projectId,taskId);
  assert.equal(first.revision.domainId,domainId);
  assert.equal(first.revision.kind,"research");
  await service.execute(principal,{type:"task.update",projectId,operationId:randomUUID(),taskId,expectedVersion:1,
    title:"Study",content:"Fixed problem",acceptance:"Evidence read",owner:"reviewer",kind:"research",domainId:null,
    reason:"unassign domain after review"});
  const current=await service.getTask(principal,projectId,taskId);
  assert.equal(current.revision.domainId,null);
  const history=await service.listTaskRevisions(principal,projectId,taskId);
  assert.equal(history[0]?.revision.domainId,domainId);
  assert.equal(history[1]?.revision.domainId,null);
});
