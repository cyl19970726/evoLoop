import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { DeliveryIntent } from "@evoloop/contracts/orchestration";

/** Persist a sealed worker-intent fixture so Run attribution is read from authority, never from Delivery input. */
export async function seedSealingWorkerSubmission(pool: pg.Pool, projectId: string, taskId: string,
  runId: string, submittedBy: string, deliveryOperationId: string, expectedTaskVersion: number,
  deliveryIntent: DeliveryIntent): Promise<void> {
  const run = (await pool.query(`SELECT task_revision_id,input_hash FROM runtime_run
    WHERE project_id=$1 AND run_id=$2 AND task_id=$3`, [projectId,runId,taskId])).rows[0];
  if (!run) throw new Error("fixed Run is required for the signed submission fixture");
  const loopId=randomUUID(),policyId=randomUUID(),inboxId=randomUUID(),dispatchId=randomUUID(),submissionId=randomUUID();
  const createdAtUtc=new Date().toISOString();
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO orchestration_loop(project_id,loop_id,version,state,data,current_policy_revision_id)
      VALUES($1,$2,1,'active','{}'::jsonb,$3)`, [projectId,loopId,policyId]);
    await client.query(`INSERT INTO loop_policy_revision(project_id,policy_id,loop_id,version,
      allowed_business_role_ids,binding_by_role,actor_id,created_at_utc,data)
      VALUES($1,$2,$3,1,'[]'::jsonb,'{}'::jsonb,'fixture-sealer',$4,$5::jsonb)`,[projectId,policyId,loopId,
        createdAtUtc,JSON.stringify({projectId,id:policyId,loopId,version:1,previousId:null,
          allowedBusinessRoleIds:[],bindingByRole:{},changedBindingId:null,decisionOperationId:null,
          actorId:'fixture-sealer',createdAtUtc})]);
    await client.query(`INSERT INTO orchestration_inbox(project_id,inbox_id,loop_id,source_event_id,
      recipient_role_id,purpose,version,state,data) VALUES($1,$2,$3,$4,'fixture-worker','next_action',1,'acknowledged','{}'::jsonb)`,
      [projectId,inboxId,loopId,randomUUID()]);
    await client.query(`INSERT INTO orchestration_dispatch(project_id,dispatch_id,loop_id,inbox_id,task_id,
      task_version,version,state,data,policy_revision_id) VALUES($1,$2,$3,$4,$5,$6,1,'accepted',$8::jsonb,$7)`,
      [projectId,dispatchId,loopId,inboxId,taskId,expectedTaskVersion,policyId,
        JSON.stringify({policyRevisionId:policyId,bindingId:null})]);
    await client.query(`INSERT INTO orchestration_submission(project_id,submission_id,dispatch_id,loop_id,version,state,data)
      VALUES($1,$2,$3,$4,2,'sealing',$5::jsonb)`, [projectId,submissionId,dispatchId,loopId,JSON.stringify({
        projectId,id:submissionId,dispatchId,runId,taskId,taskRevisionId:run.task_revision_id,
        runInputHash:run.input_hash,deliveryOperationId,deliveryIntent,submittedBy,
        expectedTaskVersion,state:"sealing",sealedBy:"fixture-sealer",
      })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
