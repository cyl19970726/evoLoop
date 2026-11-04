import assert from "node:assert/strict";
import { test } from "node:test";
import { PgTaskAttention, attentionItem } from "../src/task-attention.ts";

test("a malformed attention cursor fails as INVALID_CURSOR before querying PostgreSQL",async()=>{
  const projectId="11111111-1111-4111-8111-111111111111";
  const store=new PgTaskAttention({query:async()=>{throw Error("Unexpected query");}} as never,projectId);
  const cursor=Buffer.from(JSON.stringify({projectId,taskId:null,state:null,phase:null,signal:null,
    waitingOnKind:null,waitingOnId:null,at:"2026-11-04T00:00:00.000Z",id:"forged"})).toString("base64url");
  await assert.rejects(store.items({limit:50,cursor}),{code:"INVALID_CURSOR"});
});
test("attention list row exposes reason, evidence, and saved waiting party",()=>{
  const at="2026-11-04T00:00:00.000Z";
  const item=attentionItem({item_id:"item",task_id:"task",task_revision_id:"revision",stage_id:null,
    phase:"awaiting_acceptance",signal:"stage_overdue",waiting_on:{kind:"consumer",id:"qa"},
    reason:"NEXT_CHECKPOINT_DUE",state:"open",severity:"watch",version:1,
    first_detected_at:at,last_detected_at:at,source_observed_at:at,
    evidence:{nextCheckAt:at},notice_id:null,resolved_at:null,resolution_reason:null});
  assert.equal(item.reason,"NEXT_CHECKPOINT_DUE");
  assert.deepEqual(item.waitingOn,{kind:"consumer",id:"qa"});
  assert.deepEqual(item.evidence,{nextCheckAt:at});
});
