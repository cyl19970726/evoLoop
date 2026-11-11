import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { type AcceptanceArrangeInput, type AcceptanceCapacityView } from "@evoloop/contracts/acceptance-relay";
import type { WorkflowService } from "@evoloop/core";
import type { SessionMessageService } from "@evoloop/core/session-messages";
export interface AcceptanceRelayRecord {
  projectId: string; relayId: string; operationId: string; taskId: string; taskRevisionId: string;
  version: number; supersedesRelayId: string | null;
  deliveryId: string; stage: "candidate" | "formal"; scopeKey: string; mode: "human" | "leader" | "session";
  scopeDescription: string; entrypoint: string | null; publicationRef: string | null; reason: string;
  recipientActorId: string; sessionId: string | null; nativeThreadId: string | null; senderActorId: string | null;
  roleId: string | null;
  messageId: string | null; messageOperationId: string | null; state: "pending" | "linked" | "blocked" | "superseded" | "released";
  blockedReason: string | null; arrangedBy: string; createdAt: string; updatedAt: string;
}
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  value && typeof value === "object" ? `{${Object.entries(value).filter(([,v])=>v!==undefined)
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>`${JSON.stringify(key)}:${canonical(v)}`).join(",")}}` :
  JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const row = (r: Record<string, unknown>): AcceptanceRelayRecord => ({
  projectId: String(r.project_id), relayId: String(r.relay_id), operationId: String(r.operation_id),
  version: Number(r.version), supersedesRelayId: r.supersedes_relay_id as string | null,
  taskId: String(r.task_id), taskRevisionId: String(r.task_revision_id), deliveryId: String(r.delivery_id),
  stage: r.stage as AcceptanceRelayRecord["stage"], scopeKey: String(r.scope_key),
  scopeDescription:String(r.scope_description),entrypoint:r.entrypoint as string|null,
  publicationRef:r.publication_ref as string|null,reason:String(r.reason),
  mode: r.mode as AcceptanceRelayRecord["mode"], recipientActorId: String(r.recipient_actor_id),
  sessionId: r.session_id as string | null, nativeThreadId: r.native_thread_id as string | null,
  roleId: r.role_id as string | null,
  senderActorId: r.sender_actor_id as string | null, messageId: r.message_id as string | null,
  messageOperationId: r.message_operation_id as string | null, state: r.state as AcceptanceRelayRecord["state"],
  blockedReason: r.blocked_reason as string | null, arrangedBy: String(r.arranged_by),
  createdAt: new Date(r.created_at as string).toISOString(), updatedAt: new Date(r.updated_at as string).toISOString(),
});
const required = <T>(value: T | null, label: string): T => {
  if (!value) throw new DomainError("NOT_FOUND", `${label} not found`);
  return value;
};
const messageContent = (item: AcceptanceRelayRecord) =>
  `验收接力 ${item.stage} / ${item.scopeKey}\nTask ${item.taskId}@${item.taskRevisionId}\n当前 Delivery ${item.deliveryId}。范围：${item.scopeDescription}。入口：${item.entrypoint??"按当前交付读取"}。请先读当前 Task、固定 Delivery 和验收安排 ${item.relayId}，按声明范围独立使用；先用 session.message.receipt 记录本人已读，再以 ${item.recipientActorId} 留 observation，回报原 Leader。保存或排队不代表已开始、已使用或通过。`;

/** A durable handoff to the existing ordinary message queue. The saved message ID is never replaced on an unknown outcome. */
export class AcceptanceRelayService {
  constructor(private readonly deps: {
    pool: Pool; workflow: WorkflowService; messages: SessionMessageService;
    principals(): Promise<Principal[]>; canWrite(): boolean;
    leaderSession(projectId: string): Promise<string | null>;
    qualify(input: { projectId: string; session: RuntimeSessionRecord; senderActorId: string; receiverActorId: string }): Promise<string | null>;
    /** Capability gaps for one exact Session and sender. Read-only; no grant is created here. */
    capabilities(input: { projectId: string; session: RuntimeSessionRecord; senderActorId: string; receiverActorId: string }): Promise<string[]>;
    /** The business CLI identity this Session signs as: who an arrangement would name as recipient. Null when none is bound. */
    boundRecipient?(projectId: string, session: RuntimeSessionRecord): Promise<string | null>;
  }) {}

  async arrange(principal: Principal, input: AcceptanceArrangeInput): Promise<AcceptanceRelayRecord> {
    if (!principal.projectIds.includes(input.projectId) || !principal.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "Acceptance arrangement requires project review authority");
    if (input.mode !== "human" && input.senderActorId !== principal.actorId)
      throw new DomainError("SENDER_MISMATCH", "The arranging reviewer must be the declared message sender");
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      // Project lock first, as core, Leader work and relay tick writes do. It serializes arrangements of
      // one project, so the project row itself is not locked: a FOR UPDATE on it waited on every
      // writer's foreign-key share and formed cycles with writers that hold the Task or relay row.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[input.projectId]);
      // Serialize decisions for one Task before looking up the operation. A concurrent retry
      // must see the first commit and return its original result, even with an old version.
      const task = required((await client.query("SELECT task_id,version,current_revision_id,state FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE",
        [input.projectId, input.taskId])).rows[0] ?? null, "Task");
      const prior = await client.query("SELECT * FROM task_acceptance_relay WHERE project_id=$1 AND operation_id=$2", [input.projectId, input.operationId]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash([principal.actorId, input])) throw new DomainError("OPERATION_REUSED", "Acceptance operation changed");
        await client.query("COMMIT"); return row(prior.rows[0]);
      }
      if (task.version !== input.expectedTaskVersion) throw new DomainError("VERSION_CONFLICT", "Task changed", task.version);
      if (task.state === "done" || task.state === "cancelled") throw new DomainError("TASK_NOT_ACTIVE", "Task no longer accepts arrangements");
      const latest = required((await client.query("SELECT delivery_id,task_revision_id,run_id FROM delivery WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC,delivery_id DESC LIMIT 1",
        [input.projectId, input.taskId])).rows[0] ?? null, "current Delivery");
      if (latest.delivery_id !== input.deliveryId || latest.task_revision_id !== task.current_revision_id)
        throw new DomainError("DELIVERY_CHANGED", "Only the current Task Delivery may be arranged");
      if (!input.supersedesRelayId && (await client.query(`SELECT 1 FROM task_acceptance_relay
        WHERE project_id=$1 AND delivery_id=$2 AND stage=$3 AND scope_key=$4
          AND state NOT IN ('superseded','released') LIMIT 1`,
        [input.projectId,input.deliveryId,input.stage,input.scopeKey])).rows[0])
        throw new DomainError("ACCEPTANCE_ALREADY_ASSIGNED", "This Delivery and acceptance scope already have a current arrangement");
      // Execution/basis revisions inherit the most recent declared policy; they do not insert a new proposal row.
      const proposal = (await client.query(`SELECT p.consumer,p.acceptance_mode,p.acceptance_target
        FROM task_proposal p JOIN task_revision r ON r.project_id=p.project_id AND r.task_id=p.task_id
          AND r.revision_id=p.task_revision_id
        WHERE p.project_id=$1 AND p.task_id=$2 ORDER BY r.version DESC LIMIT 1`,
        [input.projectId, input.taskId])).rows[0];
      if (!proposal?.consumer || proposal.consumer !== input.recipientActorId ||
        proposal.acceptance_mode !== (input.mode === "human" ? "human_required" : "independent_agent"))
        throw new DomainError("CONSUMER_MISMATCH", "Recipient must match the Task's current declared consumer and mode");
      if (input.mode === "leader" && proposal.acceptance_target !== "leader" ||
        input.mode === "session" && proposal.acceptance_target && proposal.acceptance_target !== "business_session" ||
        input.mode === "human" && proposal.acceptance_target && proposal.acceptance_target !== "human")
        throw new DomainError("ACCEPTANCE_TARGET_MISMATCH", "Task does not permit this acceptance target");
      const leaderSession=await this.deps.leaderSession(input.projectId);
      if (input.mode === "leader" && (!leaderSession || leaderSession !== input.sessionId) ||
        input.mode === "session" && leaderSession === input.sessionId)
        throw new DomainError("LEADER_TARGET_MISMATCH", "Select the explicitly permitted Leader or an independent business Session");
      let thread: string | null = null;
      let roleId: string | null = null;
      if (input.mode !== "human") {
        if (!latest.run_id) throw new DomainError("AUTHOR_SESSION_UNVERIFIED", "Current Delivery has no bound author Run");
        const author=(await client.query("SELECT session_id FROM runtime_run WHERE project_id=$1 AND run_id=$2 AND task_id=$3",
          [input.projectId,latest.run_id,input.taskId])).rows[0];
        if (!author?.session_id || author.session_id === input.sessionId)
          throw new DomainError("INDEPENDENT_SESSION_REQUIRED", "Author and acceptance Session must be verified and distinct");
        const session = required((await client.query(`SELECT s.session_id,s.native_thread_id,s.state,s.role_id,
          EXISTS(SELECT 1 FROM role_session_binding b WHERE b.project_id=s.project_id AND b.session_id=s.session_id AND b.role_id::text=s.role_id) AS bound
          FROM runtime_session s WHERE s.project_id=$1 AND s.session_id=$2`, [input.projectId, input.sessionId])).rows[0] ?? null, "recipient Session");
        if (session.state !== "ready" || !session.native_thread_id || !session.bound)
          throw new DomainError("SESSION_NOT_READY", "Recipient must be a ready Role-bound Session");
        thread = session.native_thread_id;
        roleId = session.role_id;
        const bound = await this.deps.workflow.getRuntimeSession(principal,input.projectId,input.sessionId!);
        const problem = await this.deps.qualify({projectId:input.projectId,session:bound,
          senderActorId:input.senderActorId!,receiverActorId:input.recipientActorId});
        if(problem)throw new DomainError(problem,"Recipient lacks the current native, CLI or message authorization");
      }
      if (!!input.supersedesRelayId !== !!input.expectedRelayVersion)
        throw new DomainError("INVALID_REASSIGNMENT", "Reassignment needs the exact earlier arrangement and version");
      if(input.supersedesRelayId){
        const earlier=required((await client.query("SELECT * FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2 FOR UPDATE",
          [input.projectId,input.supersedesRelayId])).rows[0]??null,"earlier arrangement");
        if(earlier.version!==input.expectedRelayVersion||earlier.delivery_id!==input.deliveryId||
          earlier.stage!==input.stage||earlier.scope_key!==input.scopeKey||earlier.state==='superseded')
          throw new DomainError("REASSIGNMENT_CHANGED","Earlier acceptance arrangement changed",earlier.version);
        if((await client.query("SELECT 1 FROM task_acceptance_human_read WHERE project_id=$1 AND relay_id=$2 UNION ALL SELECT 1 FROM task_acceptance_observation_link WHERE project_id=$1 AND relay_id=$2 LIMIT 1",
          [input.projectId,input.supersedesRelayId])).rows[0])
          throw new DomainError("ACCEPTANCE_IN_FLIGHT","Read or observed acceptance cannot be reassigned");
        if(earlier.message_id){
          const message=(await client.query("SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2 FOR UPDATE",
            [input.projectId,earlier.message_id])).rows[0];
          if(message && !["queued","cancelled","failed"].includes(message.state))
            throw new DomainError("ACCEPTANCE_IN_FLIGHT","Started or unknown acceptance must settle before reassignment");
          if(message?.state==='queued')await client.query("UPDATE session_message SET state='cancelled',version=version+1,blocked_reason='Acceptance reassigned',updated_at=now() WHERE project_id=$1 AND message_id=$2",
            [input.projectId,earlier.message_id]);
        }
        await client.query("UPDATE task_acceptance_relay SET state='superseded',version=version+1,blocked_reason='Reassigned',updated_at=now() WHERE project_id=$1 AND relay_id=$2",
          [input.projectId,input.supersedesRelayId]);
      }
      const inserted = await client.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,task_revision_id,
        delivery_id,stage,scope_key,scope_description,entrypoint,publication_ref,reason,
        mode,recipient_actor_id,session_id,native_thread_id,role_id,sender_actor_id,message_id,message_operation_id,
        state,blocked_reason,arranged_by,supersedes_relay_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'pending',NULL,$22,$23,now(),now()) RETURNING *`,
        [input.projectId,input.relayId,input.operationId,hash([principal.actorId,input]),input.taskId,task.current_revision_id,
          input.deliveryId,input.stage,input.scopeKey,input.scopeDescription,input.entrypoint,input.publicationRef,input.reason,
          input.mode,input.recipientActorId,input.sessionId,thread,roleId,input.senderActorId,
          input.messageId,input.messageOperationId,principal.actorId,input.supersedesRelayId??null]);
      await client.query("COMMIT");
      return row(inserted.rows[0]);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async list(projectId: string, taskId: string): Promise<unknown[]> {
    const result = await this.deps.pool.query(`SELECT a.*,m.state AS message_state,m.blocked_reason AS message_blocked_reason,
      p.state AS processing_state,p.native_turn_id,rr.actor_id AS read_actor_id,
      hr.read_at AS human_read_at,l.evidence_level,
      o.result AS observation_result,o.observer AS observation_actor_id,o.observation_id,
      (SELECT r.session_id FROM delivery d JOIN runtime_run r
        ON r.project_id=d.project_id AND r.run_id=d.run_id
        WHERE d.project_id=a.project_id AND d.delivery_id=a.delivery_id LIMIT 1) AS author_session_id
      FROM task_acceptance_relay a
      LEFT JOIN session_message m ON m.project_id=a.project_id AND m.message_id=a.message_id
      LEFT JOIN session_message_processing p ON p.project_id=m.project_id AND p.message_id=m.message_id
      LEFT JOIN session_message_read_receipt rr ON rr.project_id=m.project_id AND rr.message_id=m.message_id
        AND rr.actor_id=a.recipient_actor_id
      LEFT JOIN task_acceptance_human_read hr ON hr.project_id=a.project_id AND hr.relay_id=a.relay_id
      LEFT JOIN task_acceptance_observation_link l ON l.project_id=a.project_id AND l.relay_id=a.relay_id
      LEFT JOIN consumer_observation o ON o.project_id=l.project_id AND o.observation_id=l.observation_id
      WHERE a.project_id=$1 AND a.task_id=$2 ORDER BY a.created_at DESC,a.relay_id DESC LIMIT 50`, [projectId,taskId]);
    return result.rows.map(r => ({ ...row(r), messageState:r.message_state ?? null, messageBlockedReason:r.message_blocked_reason ?? null,
      processingState:r.processing_state ?? null, nativeTurnId:r.native_turn_id ?? null,
      readActorId:r.read_actor_id ?? null, humanReadAt:r.human_read_at ? new Date(r.human_read_at).toISOString() : null,
      observationId:r.observation_id ?? null, observationResult:r.observation_result ?? null,
      observationActorId:r.observation_actor_id ?? null, evidenceLevel:r.evidence_level ?? null,
      independenceEvidence:r.mode === "human" ? "human_credential" :
        r.session_id && r.author_session_id && r.session_id !== r.author_session_id
          ? "distinct_runtime_session" : "unverified" }));
  }

  async mine(principal: Principal, projectId: string): Promise<unknown[]> {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN", "Project read authority required");
    const result = await this.deps.pool.query(`SELECT a.project_id,a.relay_id,a.task_id,a.task_revision_id,a.delivery_id,a.version,
      a.stage,a.scope_key,a.scope_description,a.entrypoint,a.publication_ref,a.created_at,
      hr.read_at,l.observation_id
      FROM task_acceptance_relay a
      LEFT JOIN task_acceptance_human_read hr ON hr.project_id=a.project_id AND hr.relay_id=a.relay_id
      LEFT JOIN task_acceptance_observation_link l ON l.project_id=a.project_id AND l.relay_id=a.relay_id
      WHERE a.project_id=$1 AND a.mode='human' AND a.recipient_actor_id=$2
        AND a.state NOT IN ('superseded','released')
      ORDER BY a.created_at DESC,a.relay_id DESC LIMIT 100`,[projectId,principal.actorId]);
    return result.rows.map(r=>({projectId:r.project_id,relayId:r.relay_id,taskId:r.task_id,
      taskRevisionId:r.task_revision_id,deliveryId:r.delivery_id,stage:r.stage,scopeKey:r.scope_key,
      scopeDescription:r.scope_description,entrypoint:r.entrypoint,publicationRef:r.publication_ref,version:r.version,
      createdAt:new Date(r.created_at).toISOString(),readAt:r.read_at ? new Date(r.read_at).toISOString() : null,
      observationId:r.observation_id ?? null}));
  }

  /** Capacity is a snapshot of persisted obligations. It does not claim native writer ownership. */
  async capacity(principal: Principal, projectId: string): Promise<unknown[]> {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN", "Project read authority required");
    const leaderSession = await this.deps.leaderSession(projectId);
    const result = await this.deps.pool.query(`SELECT s.session_id,s.role_id,s.actor_id,s.cwd,s.state,s.native_thread_id,
      p.tenure,
      (SELECT count(*)::int FROM runtime_run r WHERE r.project_id=s.project_id AND r.session_id=s.session_id
        AND r.state IN ('requested','dispatching','running','unknown')) AS active_runs,
      (SELECT count(*)::int FROM session_message m WHERE m.project_id=s.project_id AND m.session_id=s.session_id
        AND m.state IN ('queued','processing','unknown')) AS pending_messages,
      (SELECT count(*)::int FROM resident_queue_entry e WHERE e.project_id=s.project_id AND e.session_id=s.session_id
        AND e.state<>'released') AS queue_entries,
      (SELECT count(*)::int FROM task_session_assignment a JOIN task t ON t.project_id=a.project_id AND t.task_id=a.task_id
        WHERE a.project_id=s.project_id AND a.target_kind='owned' AND a.target_id=s.session_id
          AND a.state<>'released' AND t.state NOT IN ('done','cancelled')) AS open_assignments,
      (SELECT count(*)::int FROM task_acceptance_relay a WHERE a.project_id=s.project_id AND a.session_id=s.session_id
        AND a.state NOT IN ('superseded','released') AND NOT EXISTS (
          SELECT 1 FROM task_acceptance_observation_link l WHERE l.project_id=a.project_id AND l.relay_id=a.relay_id
        ) AND NOT EXISTS (
          SELECT 1 FROM session_message tm WHERE tm.project_id=a.project_id AND tm.message_id=a.message_id
            AND tm.state IN ('failed','cancelled')
        )) AS open_acceptance
      FROM runtime_session s LEFT JOIN session_profile p ON p.project_id=s.project_id
        AND p.target_kind='owned' AND p.target_id=s.session_id
      WHERE s.project_id=$1 AND s.state<>'closed' ORDER BY s.role_id,s.session_id LIMIT 200`,[projectId]);
    const capacity: AcceptanceCapacityView[] = [];
    for (const r of result.rows) {
      const persistedWorkIdle = r.state === "ready" && !!r.native_thread_id &&
        [r.active_runs,r.pending_messages,r.queue_entries,r.open_assignments,r.open_acceptance]
          .every((n:number) => n === 0);
      let missingCapabilities: string[] = [];
      if (r.state === "ready" && r.native_thread_id) {
        try {
          const session = await this.deps.workflow.getRuntimeSession(principal, projectId, r.session_id);
          // An arrangement names the Session's CLI-bound identity, not the Session creator (runtime_session.actor_id);
          // with no binding the creator is kept, so RECIPIENT_BINDING_MISSING is still reported for real.
          const receiverActorId = await this.deps.boundRecipient?.(projectId, session) ?? r.actor_id;
          missingCapabilities = await this.deps.capabilities({ projectId, session,
            senderActorId: principal.actorId, receiverActorId });
        } catch {
          missingCapabilities = ["SESSION_READBACK_FAILED"];
        }
      } else {
        missingCapabilities = ["SESSION_NOT_READY"];
      }
      capacity.push({ sessionId:r.session_id, roleId:r.role_id, sessionActorId:r.actor_id, cwd:r.cwd,
        state:r.state, nativeThreadId:r.native_thread_id, tenure:r.tenure ?? "unknown",
        isLeader:r.session_id === leaderSession,
        activeRuns:r.active_runs, pendingMessages:r.pending_messages, queueEntries:r.queue_entries,
        openAssignments:r.open_assignments, openAcceptance:r.open_acceptance,
        persistedWorkIdle, missingCapabilities,
        readyForAcceptance:persistedWorkIdle && missingCapabilities.length === 0 });
    }
    return capacity;
  }

  async humanRead(principal: Principal, projectId: string, taskId: string, relayId: string, operationId: string,
    expectedVersion: number, evidence: string): Promise<void> {
    if (principal.identityKind !== "human" || !principal.projectIds.includes(projectId) ||
      !principal.permissions.includes("read")) throw new DomainError("TRUSTED_HUMAN_REQUIRED","Human recipient credential required");
    const client=await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const item=required((await client.query("SELECT * FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2 FOR UPDATE",
        [projectId,relayId])).rows[0]??null,"acceptance arrangement");
      if(item.task_id!==taskId)throw new DomainError("TARGET_MISMATCH","Arrangement belongs to another Task");
      const prior=(await client.query("SELECT * FROM task_acceptance_human_read WHERE project_id=$1 AND relay_id=$2",
        [projectId,relayId])).rows[0];
      if(prior){
        if(prior.operation_id!==operationId || prior.actor_id!==principal.actorId || prior.evidence!==evidence)
          throw new DomainError("OPERATION_REUSED","Human read has a different fixed operation");
      }else{
        if(item.mode!=="human" || item.recipient_actor_id!==principal.actorId || item.state!=="pending" ||
          item.version!==expectedVersion)throw new DomainError("ACCEPTANCE_CHANGED","Human acceptance arrangement changed",item.version);
        if(!await this.current(row(item)) || !await this.publicationReady(row(item)))
          throw new DomainError("ACCEPTANCE_NOT_READY","Current Delivery or publication is not ready for human review");
        await client.query("INSERT INTO task_acceptance_human_read(project_id,relay_id,operation_id,actor_id,evidence,read_at) VALUES($1,$2,$3,$4,$5,now())",
          [projectId,relayId,operationId,principal.actorId,evidence]);
        await client.query("UPDATE task_acceptance_relay SET version=version+1,updated_at=now() WHERE project_id=$1 AND relay_id=$2",
          [projectId,relayId]);
      }
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }

  /** Links an existing workflow observation; the actor credential and saved native Turn are distinct evidence. */
  async linkObservation(principal: Principal, projectId: string, taskId: string, relayId: string, observationId: string,
    operationId: string, expectedVersion: number): Promise<void> {
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN","Project read authority required");
    const client=await this.deps.pool.connect();
    try{
      await client.query("BEGIN");
      const item=required((await client.query("SELECT * FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2 FOR UPDATE",
        [projectId,relayId])).rows[0]??null,"acceptance arrangement");
      if(item.task_id!==taskId)throw new DomainError("TARGET_MISMATCH","Arrangement belongs to another Task");
      const prior=(await client.query("SELECT * FROM task_acceptance_observation_link WHERE project_id=$1 AND relay_id=$2",
        [projectId,relayId])).rows[0];
      if(prior){
        if(prior.observation_id!==observationId||prior.operation_id!==operationId||prior.actor_id!==principal.actorId)
          throw new DomainError("OPERATION_REUSED","Observation link has a different fixed operation");
      }else{
        if(item.version!==expectedVersion||!['pending','linked'].includes(item.state)||
          item.recipient_actor_id!==principal.actorId)
          throw new DomainError("ACCEPTANCE_CHANGED","Current acceptance recipient or version changed",item.version);
        if(!await this.current(row(item)) || !await this.publicationReady(row(item)))
          throw new DomainError("ACCEPTANCE_NOT_READY","Current Delivery or publication changed");
        const observation=required((await client.query(`SELECT * FROM consumer_observation
          WHERE project_id=$1 AND observation_id=$2`,[projectId,observationId])).rows[0]??null,"consumer observation");
        if(observation.task_id!==item.task_id||observation.delivery_id!==item.delivery_id||
          observation.observer!==principal.actorId||observation.actor_id!==principal.actorId||
          Date.parse(observation.created_at)<Date.parse(item.created_at))
          throw new DomainError("OBSERVATION_MISMATCH","Observation does not belong to this recipient, Delivery and arrangement");
        if(item.mode==='human'){
          if(principal.identityKind!=="human"||observation.observer_kind!=="human"||
            !(await client.query("SELECT 1 FROM task_acceptance_human_read WHERE project_id=$1 AND relay_id=$2",[projectId,relayId])).rows[0])
            throw new DomainError("HUMAN_READ_REQUIRED","Human recipient must read this arrangement first");
        }else{
          if(principal.identityKind==="human"||observation.observer_kind!=="agent")
            throw new DomainError("AGENT_OBSERVER_REQUIRED","Agent recipient credential required");
          const process=(await client.query(`SELECT p.state,p.native_turn_id,p.session_id,
            rr.actor_id,o.created_at>=p.updated_at AS after_completion,
            o.created_at>=rr.recorded_at AS after_read FROM session_message_processing p
            LEFT JOIN session_message_read_receipt rr ON rr.project_id=p.project_id AND rr.message_id=p.message_id
              AND rr.actor_id=$3 JOIN consumer_observation o ON o.project_id=p.project_id AND o.observation_id=$4
            WHERE p.project_id=$1 AND p.message_id=$2`,
            [projectId,item.message_id,principal.actorId,observationId])).rows[0];
          if(process?.state!=="completed"||!process.native_turn_id||!process.actor_id||
            process.session_id!==item.session_id||!process.after_completion||!process.after_read)
            throw new DomainError("ACCEPTANCE_NOT_USED","Recipient message, native Turn and read receipt must be observed");
        }
        await client.query(`INSERT INTO task_acceptance_observation_link(project_id,relay_id,observation_id,
          operation_id,actor_id,evidence_level,linked_at) VALUES($1,$2,$3,$4,$5,$6,now())`,
          [projectId,relayId,observationId,operationId,principal.actorId,
            item.mode==='human'?'human_credential':'actor_message_turn']);
        await client.query("UPDATE task_acceptance_relay SET version=version+1,updated_at=now() WHERE project_id=$1 AND relay_id=$2",
          [projectId,relayId]);
      }
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }

  async retirementStatus(principal: Principal, projectId: string, sessionId: string): Promise<unknown> {
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN","Project read authority required");
    const result=await this.deps.pool.query(`SELECT s.session_id,s.role_id,s.cwd,s.version,s.state,
      s.native_thread_id,s.close_operation_id,s.close_verified_at,p.tenure,
      (SELECT count(*)::int FROM runtime_run r WHERE r.project_id=s.project_id AND r.session_id=s.session_id
        AND r.state IN ('requested','dispatching','running','unknown')) AS active_runs,
      (SELECT count(*)::int FROM session_message m WHERE m.project_id=s.project_id AND m.session_id=s.session_id
        AND m.state IN ('queued','processing','unknown')) AS pending_messages,
      (SELECT count(*)::int FROM resident_queue_entry e WHERE e.project_id=s.project_id AND e.session_id=s.session_id
        AND e.state<>'released') AS queue_entries,
      (SELECT count(*)::int FROM task_session_assignment a JOIN task t ON t.project_id=a.project_id AND t.task_id=a.task_id
        WHERE a.project_id=s.project_id AND a.target_kind='owned' AND a.target_id=s.session_id
          AND a.state<>'released' AND t.state NOT IN ('done','cancelled')) AS open_assignments,
      (SELECT count(*)::int FROM task_acceptance_relay a WHERE a.project_id=s.project_id AND a.session_id=s.session_id
        AND a.state NOT IN ('superseded','released') AND NOT EXISTS (
          SELECT 1 FROM task_acceptance_observation_link l WHERE l.project_id=a.project_id AND l.relay_id=a.relay_id
        ) AND NOT EXISTS (
          SELECT 1 FROM session_message tm WHERE tm.project_id=a.project_id AND tm.message_id=a.message_id
            AND tm.state IN ('failed','cancelled')
        )) AS open_acceptance,
      (SELECT row_to_json(d) FROM (SELECT decision_id,close_operation_id,expected_session_version,actor_id,
        reason,handoff_evidence,created_at FROM session_retirement_decision d WHERE d.project_id=s.project_id
        AND d.session_id=s.session_id ORDER BY d.created_at DESC LIMIT 1) d) AS decision
      FROM runtime_session s LEFT JOIN session_profile p ON p.project_id=s.project_id AND p.target_kind='owned'
        AND p.target_id=s.session_id WHERE s.project_id=$1 AND s.session_id=$2`,[projectId,sessionId]);
    const x=required(result.rows[0]??null,"Session");
    const blockers={activeRuns:x.active_runs,pendingMessages:x.pending_messages,queueEntries:x.queue_entries,
      openAssignments:x.open_assignments,openAcceptance:x.open_acceptance};
    const idle=Object.values(blockers).every(value=>value===0);
    return {sessionId:x.session_id,roleId:x.role_id,cwd:x.cwd,version:x.version,state:x.state,
      nativeThreadId:x.native_thread_id,tenure:x.tenure??"unknown",closeOperationId:x.close_operation_id,
      closeVerifiedAt:x.close_verified_at ? new Date(x.close_verified_at).toISOString() : null,
      nativeArchiveVerified:!!x.close_verified_at,
      blockers,
      nextAction:x.state==="closed" ? "closed and native archive verified; keep history and dependent resources"
        :x.state==="closing" ? "closing; reconcile the original close operation before retrying archive"
        :!idle ? "settle the listed Run, message, queue, assignment or acceptance responsibility first"
        :x.tenure!=="temporary" ? "resident or unknown tenure stays reusable; retirement is not automatic"
        :x.decision ? "approved; submit runtime.session.close with the recorded close operation"
        :"record an exact retirement decision with handoff evidence before close",
      decision:x.decision??null};
  }

  async approveRetirement(principal: Principal, input: {projectId:string;sessionId:string;decisionId:string;
    closeOperationId:string;expectedSessionVersion:number;reason:string;handoffEvidence:string}): Promise<unknown> {
    if(!principal.projectIds.includes(input.projectId)||!principal.permissions.includes("review"))
      throw new DomainError("FORBIDDEN","Session retirement needs project review authority");
    const client=await this.deps.pool.connect();
    try{
      await client.query("BEGIN");
      const prior=(await client.query("SELECT * FROM session_retirement_decision WHERE project_id=$1 AND decision_id=$2",
        [input.projectId,input.decisionId])).rows[0];
      const requestHash=hash([principal.actorId,input]);
      if(prior){
        if(prior.request_hash!==requestHash)throw new DomainError("OPERATION_REUSED","Retirement decision changed");
      }else{
        const s=required((await client.query(`SELECT s.*,p.tenure FROM runtime_session s
          LEFT JOIN session_profile p ON p.project_id=s.project_id AND p.target_kind='owned' AND p.target_id=s.session_id
          WHERE s.project_id=$1 AND s.session_id=$2 FOR UPDATE OF s`,[input.projectId,input.sessionId])).rows[0]??null,"Session");
        if(s.version!==input.expectedSessionVersion||s.state!=="ready"||!s.native_thread_id||s.tenure!=="temporary")
          throw new DomainError("RETIREMENT_CHANGED","Only a current ready temporary Session can be approved",s.version);
        const pending=await client.query(`SELECT
          EXISTS(SELECT 1 FROM runtime_run r WHERE r.project_id=$1 AND r.session_id=$2 AND r.state IN ('requested','dispatching','running','unknown'))
          OR EXISTS(SELECT 1 FROM session_message m WHERE m.project_id=$1 AND m.session_id=$2 AND m.state IN ('queued','processing','unknown'))
          OR EXISTS(SELECT 1 FROM resident_queue_entry e WHERE e.project_id=$1 AND e.session_id=$2 AND e.state<>'released')
          OR EXISTS(SELECT 1 FROM task_session_assignment a JOIN task t ON t.project_id=a.project_id AND t.task_id=a.task_id
            WHERE a.project_id=$1 AND a.target_kind='owned' AND a.target_id=$2 AND a.state<>'released'
              AND t.state NOT IN ('done','cancelled'))
          OR EXISTS(SELECT 1 FROM task_acceptance_relay a WHERE a.project_id=$1 AND a.session_id=$2
            AND a.state NOT IN ('superseded','released') AND NOT EXISTS(
              SELECT 1 FROM task_acceptance_observation_link l WHERE l.project_id=a.project_id AND l.relay_id=a.relay_id)
            AND NOT EXISTS(
              SELECT 1 FROM session_message tm WHERE tm.project_id=a.project_id AND tm.message_id=a.message_id
                AND tm.state IN ('failed','cancelled')))
          AS blocked`,[input.projectId,input.sessionId]);
        if(pending.rows[0]?.blocked)throw new DomainError("RETIREMENT_BLOCKED","Session still has active or unhanded work");
        await client.query(`INSERT INTO session_retirement_decision(project_id,decision_id,session_id,
          close_operation_id,request_hash,expected_session_version,actor_id,reason,handoff_evidence,
          role_id,native_thread_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
          [input.projectId,input.decisionId,input.sessionId,input.closeOperationId,requestHash,
            input.expectedSessionVersion,principal.actorId,input.reason,input.handoffEvidence,s.role_id,s.native_thread_id]);
      }
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    return this.retirementStatus(principal,input.projectId,input.sessionId);
  }

  async tick(projectIds: string[]): Promise<void> {
    if (!this.deps.canWrite()) return;
    for (const projectId of projectIds) {
      const active = await this.deps.pool.query(`SELECT a.*,m.state AS message_state
        FROM task_acceptance_relay a LEFT JOIN session_message m
          ON m.project_id=a.project_id AND m.message_id=a.message_id
        WHERE a.project_id=$1 AND (a.state='pending' OR
          (a.state='linked' AND m.state IN ('failed','cancelled')))
        ORDER BY a.created_at,a.relay_id LIMIT 30`, [projectId]);
      let firstError: unknown = null;
      for (const value of active.rows) {
        try {
          const item = row(value);
          // Human work has no message to cancel; a changed Delivery or Task revision still retires it.
          if (!await this.current(item)) { await this.setState(item,"superseded","Current Delivery or Task revision changed"); continue; }
          if (value.message_state === "failed" || value.message_state === "cancelled") {
            await this.setState(item,"blocked",`ACCEPTANCE_MESSAGE_${String(value.message_state).toUpperCase()}`);
            continue;
          }
          if (item.mode === "human" || item.state === "linked") continue;
          await this.dispatch(item);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    }
  }

  private async dispatch(item: AcceptanceRelayRecord): Promise<void> {
    if (item.mode === "human" || !item.sessionId || !item.senderActorId || !item.messageId || !item.messageOperationId) return;
    const current = await this.current(item);
    if (!current) { await this.setState(item,"superseded","Current Delivery or Session binding changed"); return; }
    if(!await this.publicationReady(item)){await this.note(item,"PUBLICATION_PENDING");return;}
    const principals = await this.deps.principals();
    const sender = principals.find(p => p.actorId === item.senderActorId && p.projectIds.includes(item.projectId) &&
      p.permissions.includes("read") && p.permissions.includes("write"));
    if (!sender) { await this.note(item,"SENDER_UNAVAILABLE"); return; }
    const session = await this.deps.workflow.getRuntimeSession(sender,item.projectId,item.sessionId);
    const problem = await this.deps.qualify({projectId:item.projectId,session,senderActorId:item.senderActorId,receiverActorId:item.recipientActorId});
    if (problem) { await this.note(item,problem); return; }
    const command = {type:"session.message.post" as const,projectId:item.projectId,operationId:item.messageOperationId,
      messageId:item.messageId,target:{kind:"owned" as const,sessionId:item.sessionId},
      context:{taskId:item.taskId,taskRevisionId:item.taskRevisionId},
      content:messageContent(item)};
    let operation = await this.deps.workflow.getOperation(sender,item.projectId,item.messageOperationId);
    if (!operation) {
      try { await this.deps.workflow.execute(sender,command); } catch { /* Preserve the original ID until journal readback. */ }
      operation = await this.deps.workflow.getOperation(sender,item.projectId,item.messageOperationId);
    }
    if (!operation) { await this.note(item,"MESSAGE_POST_UNCONFIRMED"); return; }
    if (operation.result.status !== "applied" || operation.result.entityId !== item.messageId) {
      await this.setState(item,"blocked",`MESSAGE_POST_${operation.result.status}`); return;
    }
    const message = await this.deps.messages.get(item.projectId,item.messageId);
    if (message.state === "failed" || message.state === "cancelled") {
      await this.setState(item,"blocked",`ACCEPTANCE_MESSAGE_${message.state.toUpperCase()}`);
      return;
    }
    if (message.operationId !== item.messageOperationId || message.senderActorId !== item.senderActorId ||
      message.target.kind !== "owned" || message.target.sessionId !== item.sessionId ||
      message.context?.taskId !== item.taskId || message.context?.taskRevisionId !== item.taskRevisionId ||
      message.content !== command.content)
      { await this.setState(item,"blocked","MESSAGE_BINDING_CHANGED"); return; }
    await this.setState(item,"linked",null);
  }

  private async current(item: AcceptanceRelayRecord): Promise<boolean> {
    const r = await this.deps.pool.query(`SELECT t.state,t.current_revision_id,d.delivery_id,s.native_thread_id,s.role_id,s.state AS session_state
      FROM task t LEFT JOIN LATERAL (SELECT delivery_id FROM delivery WHERE project_id=t.project_id AND task_id=t.task_id
        ORDER BY created_at DESC,delivery_id DESC LIMIT 1) d ON true
      LEFT JOIN runtime_session s ON s.project_id=t.project_id AND s.session_id=$3
      WHERE t.project_id=$1 AND t.task_id=$2`, [item.projectId,item.taskId,item.sessionId]);
    const x = r.rows[0];
    return !!x && x.state !== "done" && x.state !== "cancelled" && x.current_revision_id === item.taskRevisionId &&
      x.delivery_id === item.deliveryId && (item.mode === "human" ||
        x.session_state === "ready" && x.native_thread_id === item.nativeThreadId && x.role_id === item.roleId);
  }
  private async publicationReady(item:AcceptanceRelayRecord):Promise<boolean>{
    if(item.stage!=="formal")return true;
    const publication=await this.deps.pool.query("SELECT publication,task_revision_id FROM task_attention_follow_up WHERE project_id=$1 AND task_id=$2",[item.projectId,item.taskId]);
    return publication.rows[0]?.task_revision_id===item.taskRevisionId &&
      publication.rows[0]?.publication?.publicationRef===item.publicationRef;
  }
  /**
   * A relay update locks its row and then, through leader_result_notice_acceptance_block, inserts a
   * notice whose foreign keys share the project row; a session message update fires its own triggers.
   * Each such write runs in a short transaction that takes the project lock first, like core writes,
   * so an arrangement holding the project lock and waiting on this relay row cannot meet it in a cycle.
   */
  private async write(projectId: string, action: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.deps.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[projectId]);
      await action(client);
      await client.query("COMMIT");
    } catch (error) {
      // A failed ROLLBACK must not replace the original error; discard that connection instead.
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  private async note(item: AcceptanceRelayRecord, reason: string): Promise<void> {
    await this.write(item.projectId, async client => {
      await client.query("UPDATE task_acceptance_relay SET blocked_reason=$4,version=version+1,updated_at=now() WHERE project_id=$1 AND relay_id=$2 AND state=$3 AND blocked_reason IS DISTINCT FROM $4",
        [item.projectId,item.relayId,"pending",reason]);
    });
  }
  /** Returns how many arrangements changed: 1, or 0 when its state moved on since it was read. */
  private async updateState(client: PoolClient, item: AcceptanceRelayRecord, state: AcceptanceRelayRecord["state"], reason: string | null): Promise<number> {
    const changed = await client.query("UPDATE task_acceptance_relay SET state=$3,blocked_reason=$4,version=version+1,updated_at=now() WHERE project_id=$1 AND relay_id=$2 AND state=$5",
      [item.projectId,item.relayId,state,reason,item.state]);
    return changed.rowCount ?? 0;
  }
  private async setState(item: AcceptanceRelayRecord, state: AcceptanceRelayRecord["state"], reason: string | null): Promise<void> {
    await this.write(item.projectId, async client => { await this.updateState(client, item, state, reason); });
  }
  /** Called before native start. A stale queued handoff is retired; a started one remains immutable evidence. */
  async messageAdmission(projectId: string, messageId: string): Promise<boolean> {
    const r = await this.deps.pool.query("SELECT * FROM task_acceptance_relay WHERE project_id=$1 AND message_id=$2",[projectId,messageId]);
    if (!r.rows[0]) return true;
    const item = row(r.rows[0]);
    if (item.state !== "linked" && item.state !== "pending") return false;
    if (await this.current(item)) {
      if(!await this.publicationReady(item)){await this.note(item,"PUBLICATION_PENDING");return false;}
      const m=await this.deps.pool.query(`SELECT operation_id,sender_actor_id,session_id,
        context_task_id,context_task_revision_id,content,state FROM session_message
        WHERE project_id=$1 AND message_id=$2`,[projectId,messageId]);
      if (m.rows[0]?.state === "failed" || m.rows[0]?.state === "cancelled") {
        await this.setState(item,"blocked",`ACCEPTANCE_MESSAGE_${String(m.rows[0].state).toUpperCase()}`);
        return false;
      }
      if(m.rows[0]?.operation_id===item.messageOperationId && m.rows[0]?.sender_actor_id===item.senderActorId &&
        m.rows[0]?.session_id===item.sessionId && m.rows[0]?.context_task_id===item.taskId &&
        m.rows[0]?.context_task_revision_id===item.taskRevisionId && m.rows[0]?.content===messageContent(item))return true;
    }
    const currentMessage=await this.deps.pool.query("SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2",
      [projectId,messageId]);
    // Never retire an in-flight or unknown native source; its original operation must settle first.
    if(["processing","unknown"].includes(currentMessage.rows[0]?.state))return false;
    if(["failed","cancelled"].includes(currentMessage.rows[0]?.state)){
      await this.setState(item,"superseded",`Current Delivery changed after message ${String(currentMessage.rows[0].state)}`);
      return false;
    }
    // The reads above ran without locks. Under the project lock, lock this arrangement and its message and
    // judge again: retire only the arrangement exactly as read, never with an in-flight message, and cancel
    // the queued message only when that retirement applied, so both commit together or not at all.
    await this.write(projectId, async client => {
      const locked = (await client.query("SELECT state,version FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2 FOR UPDATE",
        [projectId,item.relayId])).rows[0];
      if (locked?.state !== item.state || locked?.version !== item.version) return;
      const message = (await client.query("SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2 FOR UPDATE",
        [projectId,messageId])).rows[0];
      if (["processing","unknown"].includes(message?.state)) return;
      if (await this.updateState(client,item,"superseded","Current Delivery or recipient changed") !== 1) return;
      await client.query(`UPDATE session_message SET state='cancelled',version=version+1,
        blocked_reason='Acceptance source superseded',updated_at=now() WHERE project_id=$1 AND message_id=$2 AND state='queued'`,
        [projectId,messageId]);
    });
    return false;
  }
}
