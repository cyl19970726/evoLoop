import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { PgAllocationRelations } from "../src/allocation-relations.ts";
import { PgDiscussionQueries } from "../src/discussions.ts";
import { WorkflowService } from "@evoloop/core";
import { AllocationRelationsService } from "@evoloop/core/allocation-relations";
import { buildServer } from "../../../apps/coordinator/src/server.ts";
import { runCli } from "../../../apps/cli/src/application.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Allocation relation test requires a dedicated evoloop_*_test database");
const schema = `el_alloc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const id = randomUUID;
const p = id(), otherP = id(), role = id(), otherRole = id(), rev = id(), otherRev = id();
const goal = id(), doc = id(), docRev = id(), taskDoc = id(), taskDocRev = id(), task = id(), taskRev = id(), oldTaskRev = id();
const d = id(), prepared = id(), decision = id(), roleAction = id(), taskAction = id(), otherRoleAction = id();
const a = id(), b = id(), now = "2026-10-26T00:00:00.000Z", ackBefore = "2026-10-25T00:00:00.000Z";
const q = async (client: pg.PoolClient, sql: string, args: unknown[] = []) => client.query(sql, args);
const source = (client: pg.PoolClient, scope = "lead|read") => new PgAllocationRelations(client, p, scope);

before(async () => {
  await migrate(url!, schema);
  const c = await pool.connect();
  try {
    await q(c, "BEGIN");
    await q(c, "INSERT INTO project(project_id,title,created_at) VALUES($1,'allocation',$3),($2,'other',$3)", [p,otherP,now]);
    for (const [rid,rr] of [[role,rev],[otherRole,otherRev]]) {
      await q(c, `INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
        VALUES($1,$2,1,$3,'active','lead',$4,$4)`, [p,rid,rr,now]);
      await q(c, `INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
        VALUES($1,$2,$3,1,'active','{}'::jsonb,'lead','fixture',$4,$4)`, [p,rid,rr,now]);
    }
    await q(c, `INSERT INTO project_goal(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,created_at)
      VALUES($1,$2,1,'outcome','none','lead','lead','test','lead','lead',$3)`, [p,goal,now]);
    await q(c, `INSERT INTO goal_revision(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,reason,created_at)
      VALUES($1,$2,1,'outcome','none','lead','lead','test','lead','lead','fixture',$3)`, [p,goal,now]);
    await q(c, "INSERT INTO process_document(project_id,document_id,title,version,current_revision_id) VALUES($1,$2,'旧决议正文',1,$3)", [p,doc,docRev]);
    await q(c, `INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Fixed decision body','markdown',$4,'lead',$5,'fixture')`, [p,doc,docRev,"0".repeat(64),now]);
    await q(c, "INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Task primary',1,$3,'task','draft')", [p,taskDoc,taskDocRev]);
    await q(c, `INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Task body','markdown',$4,'lead',$5,'fixture')`, [p,taskDoc,taskDocRev,"1".repeat(64),now]);
    await q(c, `INSERT INTO task(project_id,task_id,version,current_revision_id,title,content_document_id,content_revision_id,acceptance,owner,state)
      VALUES($1,$2,2,$3,'Task',$5,$6,'acceptance',$4,'todo')`, [p,task,taskRev,role,taskDoc,taskDocRev]);
    for (const [rid,v] of [[oldTaskRev,1],[taskRev,2]] as const) await q(c, `INSERT INTO task_revision(project_id,task_id,revision_id,version,title,content_document_id,content_revision_id,acceptance,owner,state,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,'Task',$7,$8,'acceptance',$5,'todo','lead','fixture',$6)`, [p,task,rid,v,role,now,taskDoc,taskDocRev]);
    for (const [link,ref] of [[a,"codex://threads/"+id()],[b,"codex://threads/"+id()]]) {
      await q(c, "INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,1,'registered')", [p,link,role]);
      await q(c, `INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,verified_capabilities,state,actor_id,reason,created_at_utc)
        VALUES($1,$2,1,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,'registered','lead','fixture',$5)`, [p,link,role,JSON.stringify({kind:"external",provider:"codex-desktop",ref}),now]);
    }
    await q(c, `INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,prepared_document_revision_id,
      current_document_revision_id,latest_decision_event_id,goal_id,goal_version,question,options,authorization_boundary,
      target_session_label,actor_id,created_at,updated_at)
      VALUES($1,$2,5,'allocation','linked',$3,$4,$4,$5,$6,1,'q','[]'::jsonb,'lead','lead','lead',$7,$7)`, [p,d,doc,docRev,decision,goal,now]);
    await q(c, `INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at)
      VALUES($1,$2,$3,1,'prepared',$4,$5,'lead',$6)`, [p,d,prepared,doc,docRev,now]);
    await q(c, `INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at,choice)
      VALUES($1,$2,$3,2,'decision',$4,$5,'lead',$6,'select')`, [p,d,decision,doc,docRev,now]);
    for (const [action,version,kind,target,targetRevision] of [[roleAction,3,"role",role,rev],[taskAction,4,"task",task,taskRev],[otherRoleAction,5,"role",otherRole,otherRev]] as const)
      await q(c, `INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at,decision_event_id,target_kind,target_id,target_revision_id)
        VALUES($1,$2,$3,$4,'action',$5,$6,'lead',$7,$8,$9,$10,$11)`, [p,d,action,version,doc,docRev,now,decision,kind,target,targetRevision]);
    await q(c, `INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,
      ack_method,ack_actor_id,ack_observer_actor_id,ack_evidence,ack_at,actor_id,reason,updated_at)
      VALUES($1,$2,3,$3,'external',$4,'worker','accepted','direct','worker','worker','proof',$5,'lead','fixture',$6)`, [p,task,taskRev,a,ackBefore,now]);
    await q(c, `INSERT INTO task_session_assignment_revision(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,
      ack_method,ack_actor_id,ack_observer_actor_id,ack_evidence,ack_at,actor_id,reason,updated_at)
      VALUES($1,$2,3,$3,'external',$4,'worker','accepted','direct','worker','worker','proof',$5,'lead','fixture',$6)`, [p,task,taskRev,a,ackBefore,now]);
    await q(c, `INSERT INTO task_session_assignment_revision(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,actor_id,reason,updated_at)
      VALUES($1,$2,1,$3,'external',$4,'worker','assigned','lead','no acceptance',$5)`,[p,task,taskRev,b,now]);
    await q(c, `INSERT INTO task_session_assignment_revision(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,
      ack_method,ack_actor_id,ack_observer_actor_id,ack_evidence,ack_at,actor_id,reason,updated_at)
      VALUES($1,$2,2,$3,'external',$4,'worker','accepted','direct','worker','worker','older revision proof',$5,'lead','old fixed revision',$5)`,[p,task,oldTaskRev,b,now]);
    await q(c, "COMMIT");
  } catch (e) { await q(c, "ROLLBACK"); throw e; } finally { c.release(); }
});
after(async () => { await pool.end(); const c = new pg.Client({connectionString:url}); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); } });

test("formal role, discussion, and exact accepted Session paths stay distinct", async () => {
  const c=await pool.connect(); try {
    const r=source(c), byRole=await r.list({roleId:role,limit:50});
    assert.equal(byRole.items.filter(x=>x.relation.kind==="decision-target").length,2);
    assert.ok(byRole.items.every(x=>x.relation.kind==="task-recipient" || x.relation.target.id!==otherRole));
    const byA=await r.list({sessionKey:`external:${a}`,limit:50});
    const byB=await r.list({sessionKey:`external:${b}`,limit:50});
    assert.equal(byA.items.length,1); assert.equal(byB.items.length,0);
    assert.equal((await q(c,"SELECT count(*)::int AS n FROM task_session_assignment_revision WHERE project_id=$1 AND task_id=$2 AND target_id=$3",[p,task,b])).rows[0].n,2);
    assert.equal(byA.items[0]?.decisionDocumentRevisionId,docRev);
    assert.equal(byA.items[0]?.sources[0]?.id,d);
    assert.equal(byA.items[0]?.sources[0]?.revision,taskAction);
    assert.equal(byA.items[0]?.sources[0]?.href,`#/p/${p}/discussions/${d}`);
    assert.equal(byA.metadata.sourceObservedAt,now);
    assert.equal(byA.items[0]?.relation.kind,"task-recipient");
    assert.equal((byA.items[0]?.relation as {assignment:{target:{linkId:string}}}).assignment.target.linkId,a);
    const byD=await r.list({discussionId:d,limit:50}); assert.equal(byD.items.length,4);
    assert.equal(byD.items[0]?.sources[0]?.id,d);
    assert.ok(byD.items.every(x=>x.decisionIsLatest));
  } finally {c.release();}
});

test("cursor binds identity and filter, and a committed generation change requires reset",async()=>{
  const c=await pool.connect(); try {
    const r=source(c), first=await r.list({discussionId:d,limit:1}); assert.ok(first.nextCursor);
    await assert.rejects(r.list({roleId:role,limit:1,cursor:first.nextCursor!}),{code:"INVALID_CURSOR"});
    await assert.rejects(source(c,"other").list({discussionId:d,limit:1,cursor:first.nextCursor!}),{code:"INVALID_CURSOR"});
    await assert.rejects(r.list({discussionId:d,limit:1,cursor:""}),{code:"INVALID_CURSOR"});
    const [payload,mac]=first.nextCursor!.split(".");
    const forged=JSON.parse(Buffer.from(payload!,"base64url").toString("utf8"));
    forged.after=`a:${id()}`;
    await assert.rejects(r.list({discussionId:d,limit:1,cursor:`${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`}),{code:"INVALID_CURSOR"});
    const second=await r.list({discussionId:d,limit:1,cursor:first.nextCursor!}); assert.notEqual(second.items[0]?.id,first.items[0]?.id);
    await q(c, `INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
      state,version,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp','fixture','read-only','on-request','reserved',1,$4,'lead',$5,$5)`, [p,id(),role,id(),now]);
    const reset=await r.list({discussionId:d,limit:1,cursor:first.nextCursor!});
    assert.equal(reset.resetRequired,true); assert.deepEqual(reset.items,[]);
  } finally {c.release();}
});

test("discussion kind filter preserves default and does not skip records",async()=>{
  const c=await pool.connect(); try {
    const reader=new PgDiscussionQueries(c,p);
    const all=await reader.listDiscussions(10); const filtered=await reader.listDiscussions(10,undefined,"allocation");
    assert.ok(all.items.some(x=>x.id===d)); assert.deepEqual(filtered.items.map(x=>x.id),[d]);
    assert.ok(Buffer.byteLength(JSON.stringify(filtered),"utf8")<=256*1024);
  } finally {c.release();}
});

test("more than twenty native aliases resolve to one exact recipient without joining another chat",async()=>{
  const c=await pool.connect(); try {
    const refRow=await q(c,`SELECT host->>'ref' AS ref FROM role_host_link_revision WHERE project_id=$1 AND link_id=$2`,[p,a]);
    const native=(refRow.rows[0]!.ref as string).slice(16).toUpperCase();
    const aliases:string[]=[];
    await q(c,"BEGIN");
    for(let i=0;i<24;i++) {
      const link=id(); aliases.push(link);
      await q(c,"INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,1,'registered')",[p,link,role]);
      await q(c,`INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,verified_capabilities,state,actor_id,reason,created_at_utc)
        VALUES($1,$2,1,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,'registered','lead','alias',$5)`,
        [p,link,role,JSON.stringify({kind:"external",provider:"codex-desktop",ref:i%2 ? native : `codex://threads/${native}`}),now]);
    }
    await q(c,"COMMIT");
    const r=source(c), canonical=await r.list({sessionKey:`external:${a}`,limit:5});
    assert.equal(canonical.items.length,1);
    const deep=await r.list({sessionKey:`external:${aliases[23]}`,limit:5});
    assert.equal(deep.canonicalSessionKey,canonical.canonicalSessionKey);
    assert.equal((await r.list({sessionKey:`EXTERNAL:${aliases[23].toUpperCase()}`,limit:5})).canonicalSessionKey,canonical.canonicalSessionKey);
    assert.equal(deep.items.length,1);
    assert.equal((deep.items[0]!.relation as {assignment:{target:{linkId:string}}}).assignment.target.linkId,a);
    assert.equal((await r.list({sessionKey:`external:${b}`,limit:5})).items.length,0);
  } catch(e){await q(c,"ROLLBACK").catch(()=>{});throw e;} finally {c.release();}
});

test("historical direct acceptance and later observed acceptance remain separate from task revision status",async()=>{
  const c=await pool.connect(); try {
    await q(c,"BEGIN");
    await q(c,`UPDATE task_session_assignment SET version=4,target_id=$3,state='released',ack_method=NULL,ack_actor_id=NULL,
      ack_observer_actor_id=NULL,ack_evidence=NULL,ack_at=NULL,reason='release' WHERE project_id=$1 AND task_id=$2`,[p,task,b]);
    await q(c,`INSERT INTO task_session_assignment_revision SELECT * FROM task_session_assignment WHERE project_id=$1 AND task_id=$2`,[p,task]);
    await q(c,`UPDATE task_session_assignment SET version=5,state='accepted',ack_method='lead-observed',ack_actor_id=NULL,
      ack_observer_actor_id='lead',ack_evidence='manual proof',ack_at=$3,reason='observed' WHERE project_id=$1 AND task_id=$2`,[p,task,now]);
    await q(c,`INSERT INTO task_session_assignment_revision SELECT * FROM task_session_assignment WHERE project_id=$1 AND task_id=$2`,[p,task]);
    await q(c,"COMMIT");
    const r=source(c), old=await r.list({sessionKey:`external:${a}`,limit:10}), recent=await r.list({sessionKey:`external:${b}`,limit:10});
    assert.equal(old.items.length,1); assert.equal(recent.items.length,1);
    assert.equal((old.items[0]!.relation as any).assignment.method,"direct");
    assert.equal((old.items[0]!.relation as any).assignmentStatus,"historical");
    assert.equal((recent.items[0]!.relation as any).assignment.method,"lead-observed");
    assert.equal((recent.items[0]!.relation as any).assignment.actorId,null);
    assert.equal((recent.items[0]!.relation as any).assignmentStatus,"current");
    // A later Task revision changes fixed-target status, not the historical acceptance record.
    const next=id();
    await q(c,"BEGIN");
    await q(c,`UPDATE task SET version=3,current_revision_id=$3 WHERE project_id=$1 AND task_id=$2`,[p,task,next]);
    await q(c,`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,content_document_id,content_revision_id,acceptance,owner,state,actor_id,reason,created_at)
      VALUES($1,$2,$3,3,'Task',$4,$5,'acceptance',$6,'todo','lead','next',$7)`,[p,task,next,taskDoc,taskDocRev,role,now]);
    await q(c,"COMMIT");
    const again=await r.list({sessionKey:`external:${b}`,limit:10});
    assert.equal((again.items[0]!.relation as any).taskRevisionStatus,"changed");
    assert.equal((again.items[0]!.relation as any).assignmentStatus,"current");
  } catch(e){await q(c,"ROLLBACK").catch(()=>{});throw e;} finally {c.release();}
});

test("a superseded decision keeps its fixed document and path without becoming latest",async()=>{
  const c=await pool.connect(); try {
    const replacement=id(), nextDocRev=id();
    await q(c,"BEGIN");
    await q(c,`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason)
      VALUES($1,$2,$3,'New fixed decision body','markdown',$4,'lead',$5,$6,'supersede')`,[p,doc,nextDocRev,"2".repeat(64),now,docRev]);
    await q(c,`UPDATE process_document SET version=2,current_revision_id=$3,title='新决议正文'
      WHERE project_id=$1 AND document_id=$2`,[p,doc,nextDocRev]);
    await q(c,`UPDATE discussion SET version=6,status='decided',latest_decision_event_id=$3,current_document_revision_id=$5,updated_at=$4
      WHERE project_id=$1 AND discussion_id=$2`,[p,d,replacement,now,nextDocRev]);
    await q(c,`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,
      actor_id,created_at,choice,supersedes_decision_event_id)
      VALUES($1,$2,$3,6,'decision',$4,$5,'lead',$6,'new direction',$7)`,[p,d,replacement,doc,nextDocRev,now,decision]);
    await q(c,"COMMIT");
    const page=await source(c).list({discussionId:d,limit:50});
    assert.equal(page.items.length,5);
    assert.ok(page.items.every(x=>x.decisionEventId===decision && !x.decisionIsLatest));
    assert.ok(page.items.every(x=>x.decisionDocumentRevisionId===docRev && x.discussion.document.revisionId===nextDocRev && x.discussion.latestDecisionEventId===replacement));
    const byOtherRole=await source(c).list({roleId:otherRole,limit:50});
    assert.equal(byOtherRole.items.length,1);
    assert.equal(byOtherRole.items[0]?.relation.kind,"decision-target");
    await assert.rejects(source(c).list({roleId:id(),limit:20}),{code:"NOT_FOUND"});
    await assert.rejects(source(c).list({discussionId:id(),limit:20}),{code:"NOT_FOUND"});
  } catch(e){await q(c,"ROLLBACK").catch(()=>{});throw e;} finally {c.release();}
});

test("ten thousand unrelated allocation actions stay outside the fixed filter with three SQL reads",async()=>{
  const c=await pool.connect(); try {
    const noiseD=id(), noisePrepared=id(), noiseDecision=id(), stage=id(), stageRev=id();
    const docAction="00000000-0000-4000-8000-000000000001", stageAction="00000000-0000-4000-8000-000000000002";
    await q(c,"BEGIN");
    await q(c,`INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,prepared_document_revision_id,
      current_document_revision_id,latest_decision_event_id,goal_id,goal_version,question,options,authorization_boundary,
      target_session_label,actor_id,created_at,updated_at)
      VALUES($1,$2,10005,'allocation','linked',$3,$4,$4,$5,$6,1,'noise','[]'::jsonb,'lead','lead','lead',$7,$7)`,
      [p,noiseD,doc,docRev,noiseDecision,goal,now]);
    await q(c,`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at)
      VALUES($1,$2,$3,1,'prepared',$4,$5,'lead',$6)`,[p,noiseD,noisePrepared,doc,docRev,now]);
    await q(c,`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at,choice)
      VALUES($1,$2,$3,2,'decision',$4,$5,'lead',$6,'noise')`,[p,noiseD,noiseDecision,doc,docRev,now]);
    await q(c,`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,
      actor_id,created_at,decision_event_id,target_kind,target_id,target_revision_id)
      SELECT $1,$2,gen_random_uuid(),n,'action',$3,$4,'lead',$5,$6,'role',$7,$8
      FROM generate_series(3,10003) AS n`,[p,noiseD,doc,docRev,now,noiseDecision,otherRole,otherRev]);
    await q(c,`INSERT INTO project_stage(project_id,stage_id,goal_id,version,deliverable,learning_question,state,actor_id,created_at)
      VALUES($1,$2,$3,1,'stage','question','active','lead',$4)`,[p,stage,goal,now]);
    await q(c,`INSERT INTO stage_revision(project_id,stage_id,revision_id,version,state,deliverable,learning_question,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'active','stage','question','lead','fixture',$4)`,[p,stage,stageRev,now]);
    await q(c,`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,
      actor_id,created_at,decision_event_id,target_kind,target_id,target_revision_id)
      VALUES($1,$2,$3,10004,'action',$4,$5,'lead',$6,$7,'document',$4,$5)`,[p,noiseD,docAction,doc,docRev,now,noiseDecision]);
    await q(c,`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,
      actor_id,created_at,decision_event_id,target_kind,target_id,target_version)
      VALUES($1,$2,$3,10005,'action',$4,$5,'lead',$6,$7,'stage',$8,1)`,[p,noiseD,stageAction,doc,docRev,now,noiseDecision,stage]);
    await q(c,"COMMIT");
    let calls=0, relationSql="", relationArgs:unknown[]=[];
    const original=c.query.bind(c);
    (c as any).query=(sql:string,args?:unknown[])=>{
      calls++;
      if (sql.startsWith("WITH actions AS")) { relationSql=sql; relationArgs=args ?? []; }
      return original(sql,args);
    };
    let first, second;
    try {
      first=await source(c).list({discussionId:d,limit:2});
      assert.equal(calls,3,"target existence, generation, and bounded relation query");
      calls=0;
      second=await source(c).list({discussionId:d,limit:2,cursor:first.nextCursor!});
      assert.equal(calls,3);
    } finally { (c as any).query=original; }
    assert.equal(first.items.length,2); assert.equal(second.items.length,2);
    assert.notEqual(second.items[0]?.id,first.items[0]?.id);
    assert.ok(Buffer.byteLength(JSON.stringify(first),"utf8") <= 256*1024);
    assert.ok(first.items.every(x=>x.sources.length<=3));
    const targetPage=await source(c).list({discussionId:noiseD,limit:50});
    const docPath=targetPage.items.find(x=>x.relation.kind==="decision-target" && x.relation.actionEventId===docAction);
    const stagePath=targetPage.items.find(x=>x.relation.kind==="decision-target" && x.relation.actionEventId===stageAction);
    assert.ok(docPath && stagePath,"fixed Document and Stage paths are present");
    assert.ok(docPath.sources.some(x=>x.kind==="document" && x.id===doc && x.revision===docRev &&
      x.href===`#/p/${p}/documents/${doc}?revision=${docRev}`));
    assert.ok(stagePath.sources.some(x=>x.kind==="stage" && x.id===stage && x.revision==="1" && x.href===`#/p/${p}/journey`));
    const explained=await original(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${relationSql}`,relationArgs);
    const plan=explained.rows[0]["QUERY PLAN"][0];
    const nodes: Array<{node:string;table:string|null;index:string|null;rows:number}> = [];
    const walk=(value:any):void=>{nodes.push({node:value["Node Type"],table:value["Relation Name"]??null,
      index:value["Index Name"]??null,rows:value["Actual Rows"]??0});for(const child of value.Plans??[]) walk(child);};
    walk(plan.Plan);
    assert.ok(nodes.some(x=>x.table==="discussion_event"),"real Discussion action table participates in plan");
    assert.ok(!/\bOFFSET\b/i.test(relationSql),"keyset query does not cap the source history");
    const wideSql=relationSql, wideArgs=[...relationArgs];
    wideArgs[2]=noiseD;
    wideArgs[5]="";
    const wide=await original(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${wideSql}`,wideArgs);
    const widePlan=wide.rows[0]["QUERY PLAN"][0];
    const wideNodes: Array<{node:string;table:string|null;index:string|null;rows:number}> = [];
    const walkWide=(value:any):void=>{wideNodes.push({node:value["Node Type"],table:value["Relation Name"]??null,
      index:value["Index Name"]??null,rows:value["Actual Rows"]??0});for(const child of value.Plans??[]) walkWide(child);};
    walkWide(widePlan.Plan);
    assert.ok(wideNodes.some(x=>x.table==="discussion_event" && x.rows>=10001),"matching history is read, not silently capped");
    // Evidence is visible in the test output; this fixture makes no latency promise for larger projects.
    console.log(JSON.stringify({allocationPlan:{focusedMs:plan["Execution Time"],focusedEventNodes:nodes.filter(x=>x.table==="discussion_event"),
      matchingMs:widePlan["Execution Time"],matchingEventNodes:wideNodes.filter(x=>x.table==="discussion_event"),queryCalls:3,noiseActions:10003}}));
  } catch(e){await q(c,"ROLLBACK").catch(()=>{});throw e;} finally {c.release();}
});

test("invalid external references stay isolated and project boundaries return not found",async()=>{
  const c=await pool.connect(); try {
    const x=id(), y=id();
    await q(c,"BEGIN");
    for (const [link,ref] of [[x,"chat:ambiguous"],[y,"https://example.invalid/chat"]]) {
      await q(c,"INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,1,'registered')",[p,link,role]);
      await q(c,`INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,verified_capabilities,state,actor_id,reason,created_at_utc)
        VALUES($1,$2,1,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,'registered','lead','invalid ref',$5)`,
        [p,link,role,JSON.stringify({kind:"external",provider:"codex-desktop",ref}),now]);
    }
    await q(c,"COMMIT");
    const r=source(c), px=await r.list({sessionKey:`external:${x}`,limit:5}), py=await r.list({sessionKey:`external:${y}`,limit:5});
    assert.equal(px.canonicalSessionKey,`external:${x}`);
    assert.equal(py.canonicalSessionKey,`external:${y}`);
    assert.deepEqual(px.items,[]); assert.deepEqual(py.items,[]);
    const foreign=new PgAllocationRelations(c,otherP,"lead|read");
    await assert.rejects(foreign.list({roleId:role,limit:5}),{code:"NOT_FOUND"});
    await assert.rejects(foreign.list({discussionId:d,limit:5}),{code:"NOT_FOUND"});
    await assert.rejects(foreign.list({sessionKey:`external:${a}`,limit:5}),{code:"NOT_FOUND"});
  } catch(e){await q(c,"ROLLBACK").catch(()=>{});throw e;} finally {c.release();}
});

test("UTF-8 title clipping and a filtered page stay below the byte ceiling",async()=>{
  const c=await pool.connect(); try {
    const giant="界".repeat(100_000);
    await q(c,"UPDATE process_document SET version=3,title=$3 WHERE project_id=$1 AND document_id=$2",[p,doc,giant]);
    const page=await source(c).list({discussionId:d,limit:50});
    assert.equal(page.items.length,5);
    assert.ok(page.items.every(x=>x.discussion.title.length<=240));
    assert.ok(Buffer.byteLength(JSON.stringify(page),"utf8")<=256*1024);
    const filtered=await new PgDiscussionQueries(c,p).listDiscussions(50,undefined,"allocation");
    assert.ok(filtered.items.length>=1);
    assert.ok(Buffer.byteLength(JSON.stringify(filtered),"utf8")<=256*1024);
  } finally {c.release();}
});

test("composed PG service, authenticated HTTP and CLI expose the same read-only paths", async () => {
  const uow = new PostgresUnitOfWork(pool), token = randomUUID() + randomUUID();
  const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: value => value } });
  const app = await buildServer({ service: workflow, allocationRelations: new AllocationRelationsService({ uow }),
    credentials: [{ token, actorId: "allocation-reader", projectIds: [p], permissions: ["read"] }] });
  const headers = { authorization: `Bearer ${token}` };
  const prefix = `/api/projects/${p}`;
  const counts = () => pool.query(`SELECT
    (SELECT count(*)::int FROM runtime_run WHERE project_id=$1) AS runs,
    (SELECT count(*)::int FROM operation_journal WHERE project_id=$1) AS operations`, [p]);
  const before = (await counts()).rows;
  try {
    const result = await app.inject({ url: `${prefix}/allocation-relations?roleId=${role}`, headers });
    assert.equal(result.statusCode, 200, result.body);
    const page = result.json();
    assert.ok(page.items.some((item: { relation: { kind: string } }) => item.relation.kind === "task-recipient"));
    assert.equal(page.resetRequired, false);
    assert.equal((await app.inject({ url: `${prefix}/allocation-relations?roleId=${id()}`, headers })).statusCode, 404);
    assert.equal((await app.inject({ url: `${prefix}/allocation-relations?roleId=${role}&discussionId=${d}`, headers })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/projects/${otherP}/allocation-relations?roleId=${role}`, headers })).statusCode, 403);
    assert.equal((await app.inject({ url: `${prefix}/allocation-relations?roleId=${role}` })).statusCode, 401);
    const discussions = await app.inject({ url: `${prefix}/discussions?kind=allocation`, headers });
    assert.equal(discussions.statusCode, 200, discussions.body);
    assert.ok(discussions.json().items.every((item: { kind: string }) => item.kind === "allocation"));
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    let stdout = "", stderr = "";
    const code = await runCli(["allocations", "--role", role],
      { EVOLOOP_API_URL: origin, EVOLOOP_TOKEN: token, EVOLOOP_PROJECT: p },
      { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).items, page.items);
    assert.deepEqual((await counts()).rows, before, "reads do not reserve Runs or record business operations");
  } finally { await app.close(); }
});

test('Task targets explain absent, unaccepted and other-revision assignments without inventing a recipient', async () => {
  const c = await pool.connect();
  try {
    await q(c, 'BEGIN');
    const gapDiscussion = id(), gapDecision = id();
    await q(c, `INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,prepared_document_revision_id,
      current_document_revision_id,latest_decision_event_id,goal_id,goal_version,question,options,authorization_boundary,
      target_session_label,actor_id,created_at,updated_at)
      VALUES($1,$2,4,'allocation','linked',$3,$4,$4,$5,$6,1,'gaps','[]','lead','lead','lead',$7,$7)`,
      [p, gapDiscussion, doc, docRev, gapDecision, goal, now]);
    await q(c, `INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at,choice)
      VALUES($1,$2,$3,1,'decision',$4,$5,'lead',$6,'Select')`, [p, gapDiscussion, gapDecision, doc, docRev, now]);
    const expected = new Map<string, string>();
    for (const [offset, gap] of ['no-assignment', 'not-accepted', 'different-task-revision'].entries()) {
      const target = id(), primary = id(); expected.set(target, gap);
      await q(c, `INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
        VALUES($1,$2,'Gap primary',1,$3,'task','draft')`, [p, primary, taskDocRev]);
      await q(c, `INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
        VALUES($1,$2,$3,'Gap work','markdown',$4,'lead',$5,'fixture')`, [p, primary, taskDocRev, 'c'.repeat(64), now]);
      await q(c, `INSERT INTO task(project_id,task_id,version,current_revision_id,title,content_document_id,content_revision_id,acceptance,owner,state)
        VALUES($1,$2,2,$3,'Gap Task',$4,$5,'acceptance',$6,'todo')`, [p, target, taskRev, primary, taskDocRev, role]);
      await q(c, `INSERT INTO task_revision(project_id,task_id,revision_id,version,title,content_document_id,content_revision_id,acceptance,owner,state,actor_id,reason,created_at)
        SELECT project_id,$3,revision_id,version,title,$4,content_revision_id,acceptance,owner,state,actor_id,reason,created_at
        FROM task_revision WHERE project_id=$1 AND task_id=$2`, [p, task, target, primary]);
      await q(c, `INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at,
        decision_event_id,target_kind,target_id,target_revision_id)
        VALUES($1,$2,$3,$4,'action',$5,$6,'lead',$7,$8,'task',$9,$10)`,
        [p, gapDiscussion, id(), offset + 2, doc, docRev, now, gapDecision, target, taskRev]);
      if (gap !== 'no-assignment') {
        const fixed = gap === 'different-task-revision' ? oldTaskRev : taskRev;
        await q(c, `INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,target_kind,target_id,
          recipient_actor_id,state,actor_id,reason,updated_at) VALUES($1,$2,1,$3,'external',$4,'worker','assigned','lead','fixture',$5)`, [p, target, fixed, a, now]);
        await q(c, `INSERT INTO task_session_assignment_revision SELECT * FROM task_session_assignment WHERE project_id=$1 AND task_id=$2`, [p, target]);
      }
    }
    const page = await source(c).list({ discussionId: gapDiscussion, limit: 50 });
    assert.equal(page.items.length, 3);
    for (const item of page.items) {
      assert.equal(item.relation.kind, 'decision-target');
      if (item.relation.kind === 'decision-target') assert.equal(item.relation.taskAcceptanceGap, expected.get(item.relation.target.id));
    }
    const accepted = (await source(c).list({ discussionId: d, limit: 1 })).items;
    const full = (await source(c).list({ discussionId: d, limit: 50 })).items;
    assert.ok(full.some(x => x.relation.kind === 'decision-target' && x.relation.target.kind === 'task' && x.relation.taskAcceptanceGap === null));
    assert.ok(accepted.length, 'bounded pages remain independent of this gap summary');
    await q(c, 'ROLLBACK');
  } catch (error) { await q(c, 'ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
});
