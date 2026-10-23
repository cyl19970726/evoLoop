import type { Pool } from "pg";
import type { WorkerIdentity } from "./types.js";
import type { WorkerGuardFacts } from "./guard.js";

/** Authorization facts are project-scoped reads of the authoritative records, not caller supplied labels. */
export function workerGuardFacts(pool: Pool, identity: WorkerIdentity): WorkerGuardFacts {
  const scope = identity.scope;
  const one = async (sql: string, args: unknown[]) => (await pool.query(sql, [scope.projectId, ...args])).rows[0] ?? null;
  const loop = async () => (await one("SELECT data FROM orchestration_loop WHERE project_id=$1 AND loop_id=$2", [scope.loopId]))?.data ?? null;
  const task = async (taskId: string) => {
    const enrolled = await loop();
    if (!enrolled) return null;
    const row = await one(`SELECT t.task_id,t.owner,p.stage_id,s.goal_id FROM task t
      JOIN LATERAL (SELECT p.stage_id FROM task_proposal p JOIN task_revision r
        ON r.project_id=p.project_id AND r.task_id=p.task_id AND r.revision_id=p.task_revision_id
        WHERE p.project_id=t.project_id AND p.task_id=t.task_id ORDER BY r.version DESC LIMIT 1) p ON true
      JOIN project_stage s ON s.project_id=t.project_id AND s.stage_id=p.stage_id
      WHERE t.project_id=$1 AND t.task_id=$2`, [taskId]);
    return row && row.goal_id === enrolled.goalId && (!enrolled.stageId || row.stage_id === enrolled.stageId) ?
      {projectId: scope.projectId, loopId: scope.loopId, ownerRoleId: row.owner} : null;
  };
  const authorizedTaskIds = async (): Promise<string[]> => {
    if (scope.kind === "business") return [scope.taskId];
    const enrolled = await loop();
    if (!enrolled) return [];
    const rows = await pool.query(`SELECT t.task_id FROM task t JOIN LATERAL
      (SELECT p.stage_id FROM task_proposal p JOIN task_revision r
        ON r.project_id=p.project_id AND r.task_id=p.task_id AND r.revision_id=p.task_revision_id
        WHERE p.project_id=t.project_id AND p.task_id=t.task_id ORDER BY r.version DESC LIMIT 1) p ON true
      JOIN project_stage s
      ON s.project_id=t.project_id AND s.stage_id=p.stage_id
      WHERE t.project_id=$1 AND s.goal_id=$2 AND ($3::uuid IS NULL OR s.stage_id=$3)`,
      [scope.projectId, enrolled.goalId, enrolled.stageId]);
    return rows.rows.map(row => row.task_id as string);
  };
  const deliveredDocument = async (documentId: string, revisionId?: string) => {
    if (scope.kind !== "cognition") return false;
    const enrolled = await loop();
    if (!enrolled) return false;
    const rows = await pool.query(`SELECT 1 FROM delivery d
      JOIN orchestration_dispatch x ON x.project_id=d.project_id AND x.task_id=d.task_id
        AND x.loop_id=$4 AND x.state='completed' AND x.data->>'outcome'='delivered'
        AND x.data->>'deliveryId'=d.delivery_id::text AND x.data->>'runtimeRunId'=d.run_id::text
      JOIN orchestration_submission s ON s.project_id=x.project_id AND s.dispatch_id=x.dispatch_id
        AND s.state='sealed' AND s.data->>'deliveryId'=d.delivery_id::text
        AND s.data->>'submittedBy'=d.actor_id
      JOIN task_revision delivered_revision ON delivered_revision.project_id=d.project_id
        AND delivered_revision.task_id=d.task_id AND delivered_revision.revision_id=d.task_revision_id
      JOIN LATERAL (SELECT proposal.stage_id FROM task_proposal proposal
        JOIN task_revision proposal_revision ON proposal_revision.project_id=proposal.project_id
          AND proposal_revision.task_id=proposal.task_id AND proposal_revision.revision_id=proposal.task_revision_id
        WHERE proposal.project_id=d.project_id AND proposal.task_id=d.task_id
          AND proposal_revision.version<=delivered_revision.version
        ORDER BY proposal_revision.version DESC LIMIT 1) historical_proposal ON true
      JOIN project_stage historical_stage ON historical_stage.project_id=d.project_id
        AND historical_stage.stage_id=historical_proposal.stage_id
      JOIN process_document p ON p.project_id=d.project_id AND p.document_id=$2 AND p.kind='report'
      JOIN document_revision r ON r.project_id=p.project_id AND r.document_id=p.document_id
      WHERE d.project_id=$1 AND ($3::uuid IS NULL OR r.revision_id=$3)
        AND historical_stage.goal_id=$5 AND ($6::uuid IS NULL OR historical_stage.stage_id=$6)
        AND d.artifact_ref=('#/p/' || d.project_id || '/documents/' || p.document_id || '?revision=' || r.revision_id)
        AND d.artifact_revision=r.revision_id::text AND d.content_hash=r.content_hash
      LIMIT 1`, [scope.projectId, documentId, revisionId ?? null, scope.loopId, enrolled.goalId, enrolled.stageId]);
    return (rows.rowCount ?? 0) > 0;
  };
  const adoptedLinkedDocument = async (documentId: string, revisionId: string) => {
    if (scope.kind !== "cognition") return false;
    const rows = await pool.query(`SELECT DISTINCT l.task_id FROM task_document_link l
      JOIN task t ON t.project_id=l.project_id AND t.task_id=l.task_id
      JOIN process_document p ON p.project_id=l.project_id AND p.document_id=l.document_id
      WHERE l.project_id=$1 AND l.document_id=$2 AND p.adopted_revision_id=$3
      LIMIT 21`, [scope.projectId, documentId, revisionId]);
    if (rows.rows.length > 20) return false;
    for (const row of rows.rows) if (await task(row.task_id)) return true;
    return false;
  };
  const fixedDocument = async (taskId: string, documentId: string, revisionId: string) => {
    if (!await task(taskId)) return false;
    const ids = scope.kind === "business" ? [taskId] : await authorizedTaskIds();
    if (await one(`SELECT 1 FROM task_revision r WHERE r.project_id=$1 AND r.task_id=ANY($2::uuid[])
      AND (r.revision_id=(SELECT task_revision_id FROM runtime_run WHERE project_id=$1 AND run_id=$5)
        OR ($6 AND r.revision_id=(SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=r.task_id)))
      AND ((r.content_document_id=$3 AND r.content_revision_id=$4) OR EXISTS
        (SELECT 1 FROM basis_member b WHERE b.project_id=r.project_id AND b.task_id=r.task_id
          AND b.task_revision_id=r.revision_id AND b.document_id=$3 AND b.document_revision_id=$4)) LIMIT 1`,
      [ids, documentId, revisionId, scope.runId, scope.kind === "cognition"])) return true;
    return await adoptedLinkedDocument(documentId, revisionId) || await deliveredDocument(documentId, revisionId);
  };
  // Resolve the single gap that this cognition Run actually received. Current Task ownership is deliberately
  // absent: the original Task may have moved after its immutable dispatch/version was accepted.
  const recoveryGap = async () => {
    if (scope.kind !== "cognition") return null;
    const enrolled = await loop();
    if (!enrolled) return null;
    const row = await one(`SELECT origin.dispatch_id, e.event_id, original_run.run_id,
        origin.task_id, fixed.revision_id AS task_revision_id
      FROM orchestration_dispatch current_dispatch
      JOIN orchestration_inbox inbox ON inbox.project_id=current_dispatch.project_id
        AND inbox.inbox_id=current_dispatch.inbox_id AND inbox.loop_id=current_dispatch.loop_id
        AND inbox.source_event_id=(current_dispatch.data->>'sourceEventId')::uuid
      JOIN runtime_run current_run ON current_run.project_id=current_dispatch.project_id
        AND current_run.run_id=(current_dispatch.data->>'runtimeRunId')::uuid
        AND current_run.task_id=current_dispatch.task_id
      JOIN orchestration_event e ON e.project_id=inbox.project_id AND e.event_id=inbox.source_event_id
        AND e.loop_id=inbox.loop_id AND e.kind='dispatch.gap' AND e.entity_type='dispatch'
      JOIN orchestration_operation op ON op.project_id=e.project_id AND op.operation_id=e.operation_id
      JOIN orchestration_dispatch origin ON origin.project_id=e.project_id AND origin.dispatch_id=e.entity_id
        AND origin.loop_id=e.loop_id AND origin.state='accepted' AND origin.data->>'outcome' IS NULL
      JOIN runtime_run original_run ON original_run.project_id=origin.project_id
        AND original_run.run_id=(origin.data->>'runtimeRunId')::uuid AND original_run.task_id=origin.task_id
        AND original_run.state IN ('completed','failed','interrupted')
      JOIN task_revision fixed ON fixed.project_id=origin.project_id AND fixed.task_id=origin.task_id
        AND fixed.version>=origin.task_version AND fixed.revision_id=original_run.task_revision_id
      JOIN task_revision dispatch_fixed ON dispatch_fixed.project_id=origin.project_id
        AND dispatch_fixed.task_id=origin.task_id AND dispatch_fixed.version=origin.task_version
      JOIN LATERAL (SELECT p.stage_id FROM task_proposal p JOIN task_revision pr
        ON pr.project_id=p.project_id AND pr.task_id=p.task_id AND pr.revision_id=p.task_revision_id
        WHERE p.project_id=dispatch_fixed.project_id AND p.task_id=dispatch_fixed.task_id
          AND pr.version<=dispatch_fixed.version
        ORDER BY pr.version DESC LIMIT 1) historical ON true
      JOIN project_stage stage ON stage.project_id=fixed.project_id AND stage.stage_id=historical.stage_id
      JOIN LATERAL (SELECT p.stage_id FROM task_proposal p JOIN task_revision pr
        ON pr.project_id=p.project_id AND pr.task_id=p.task_id AND pr.revision_id=p.task_revision_id
        WHERE p.project_id=fixed.project_id AND p.task_id=fixed.task_id AND pr.version<=fixed.version
        ORDER BY pr.version DESC LIMIT 1) run_scope ON true
      JOIN project_stage run_stage ON run_stage.project_id=fixed.project_id AND run_stage.stage_id=run_scope.stage_id
      WHERE current_dispatch.project_id=$1 AND current_dispatch.loop_id=$2
        AND current_dispatch.state='accepted'
        AND current_dispatch.data->>'runtimeRunId'=$3 AND current_dispatch.task_id=$4
        AND current_run.session_id=$8
        AND current_dispatch.data->>'recipientRoleId'=$5
        AND current_dispatch.data->>'sourceEventId'=inbox.source_event_id::text
        AND inbox.purpose='cognitive_review' AND inbox.state IN ('acknowledged','disposed')
        AND COALESCE(e.detail->>'runId',original_run.run_id::text)=original_run.run_id::text
        AND COALESCE(e.detail->>'taskId',origin.task_id::text)=origin.task_id::text
        AND COALESCE((e.detail->>'taskVersion')::integer,origin.task_version)=origin.task_version
        AND op.actor_id=e.actor_id AND op.result->>'entityType'='dispatch'
        AND (op.result->>'entityId')=origin.dispatch_id::text
        AND COALESCE((e.detail->>'dispatchVersion')::integer,(op.result->>'version')::integer)
          =(op.result->>'version')::integer
        AND (op.result->>'version')::integer<=origin.version
        AND stage.goal_id=$6 AND ($7::uuid IS NULL OR stage.stage_id=$7)
        AND run_stage.goal_id=$6 AND ($7::uuid IS NULL OR run_stage.stage_id=$7)
        AND NOT EXISTS (SELECT 1 FROM orchestration_submission s WHERE s.project_id=origin.project_id AND s.dispatch_id=origin.dispatch_id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_decision d WHERE d.project_id=origin.project_id AND d.dispatch_id=origin.dispatch_id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_event earlier WHERE earlier.project_id=e.project_id
          AND earlier.loop_id=e.loop_id AND earlier.entity_id=e.entity_id AND earlier.kind='dispatch.gap'
          AND (earlier.created_at_utc,earlier.event_id)<(e.created_at_utc,e.event_id))
      LIMIT 1`, [scope.loopId, scope.runId, scope.taskId, scope.roleId, enrolled.goalId, enrolled.stageId, scope.sessionId]);
    return row ? {projectId: scope.projectId, loopId: scope.loopId, dispatchId: row.dispatch_id,
      eventId: row.event_id, runId: row.run_id, taskId: row.task_id, taskRevisionId: row.task_revision_id} : null;
  };
  const recoveryDocument = async (documentId: string, revisionId: string) => {
    const gap = await recoveryGap();
    if (!gap) return false;
    return !!await one(`SELECT 1 FROM task_revision r
      JOIN document_revision doc ON doc.project_id=r.project_id AND doc.document_id=$4 AND doc.revision_id=$5
      WHERE r.project_id=$1 AND r.task_id=$2 AND r.revision_id=$3
        AND ((r.content_document_id=$4 AND r.content_revision_id=$5) OR EXISTS
          (SELECT 1 FROM basis_member b WHERE b.project_id=r.project_id AND b.task_id=r.task_id
            AND b.task_revision_id=r.revision_id AND b.document_id=$4 AND b.document_revision_id=$5))
      LIMIT 1`, [gap.taskId, gap.taskRevisionId, documentId, revisionId]);
  };
  const sourceIssueDocumentRevision = async (documentId: string, revisionId: string) => {
    if (scope.kind !== "cognition") return false;
    const enrolled = await loop();
    if (!enrolled) return false;
    return !!await one(`SELECT 1 FROM orchestration_dispatch dispatch
      JOIN orchestration_inbox inbox ON inbox.project_id=dispatch.project_id AND inbox.inbox_id=dispatch.inbox_id
        AND inbox.loop_id=dispatch.loop_id AND inbox.purpose='cognitive_review'
      JOIN outbox_event event ON event.project_id=inbox.project_id AND event.event_id=inbox.source_event_id
        AND event.kind='document' AND event.version=1
      JOIN operation_journal operation ON operation.project_id=event.project_id AND operation.operation_id=event.operation_id
        AND operation.command_type='document.create' AND operation.result->>'status'='applied'
        AND operation.result->>'entityId'=event.entity_id::text AND operation.result->>'revisionId'=$3::text
      JOIN process_document document ON document.project_id=event.project_id AND document.document_id=event.entity_id
        AND document.kind='issue' AND document.origin_task_id IS NOT NULL
      JOIN document_revision revision ON revision.project_id=document.project_id AND revision.document_id=document.document_id
        AND revision.revision_id=$3::uuid AND revision.previous_revision_id IS NULL AND revision.author=operation.actor_id
      JOIN task_revision original ON original.project_id=document.project_id AND original.task_id=document.origin_task_id
        AND original.revision_id=document.origin_task_revision_id
      JOIN LATERAL (SELECT proposal.stage_id FROM task_proposal proposal JOIN task_revision proposal_revision
        ON proposal_revision.project_id=proposal.project_id AND proposal_revision.task_id=proposal.task_id
          AND proposal_revision.revision_id=proposal.task_revision_id
        WHERE proposal.project_id=original.project_id AND proposal.task_id=original.task_id
          AND proposal_revision.version<=original.version ORDER BY proposal_revision.version DESC LIMIT 1) fixed_scope ON true
      JOIN project_stage stage ON stage.project_id=original.project_id AND stage.stage_id=fixed_scope.stage_id
      WHERE dispatch.project_id=$1 AND dispatch.loop_id=$4 AND dispatch.data->>'runtimeRunId'=$5
        AND dispatch.data->>'recipientRoleId'=$6 AND document.document_id=$2
        AND stage.goal_id=$7 AND ($8::uuid IS NULL OR stage.stage_id=$8::uuid) LIMIT 1`,
      [documentId, revisionId, scope.loopId, scope.runId, scope.roleId, enrolled.goalId, enrolled.stageId]);
  };
  return {
    loop: async id => id === scope.loopId ? loop() : null,
    task,
    recoveryGap,
    recoveryDocument,
    sourceIssueDocumentRevision,
    taskRevision: async (taskId, revisionId) => !!await task(taskId) && !!await one(
      "SELECT 1 FROM task_revision WHERE project_id=$1 AND task_id=$2 AND revision_id=$3", [taskId, revisionId]),
    run: async id => {
      const row = await one("SELECT task_id,session_id FROM runtime_run WHERE project_id=$1 AND run_id=$2", [id]);
      return row ? {projectId: scope.projectId, taskId: row.task_id, sessionId: row.session_id} : null;
    },
    delivery: async id => {
      const row = await one("SELECT task_id,run_id FROM delivery WHERE project_id=$1 AND delivery_id=$2", [id]);
      return row ? {projectId: scope.projectId, taskId: row.task_id, runId: row.run_id} : null;
    },
    inbox: async id => (await one("SELECT data FROM orchestration_inbox WHERE project_id=$1 AND inbox_id=$2", [id]))?.data ?? null,
    document: async id => {
      const row = await one(`SELECT t.task_id AS primary_task_id FROM process_document d LEFT JOIN task t
        ON t.project_id=d.project_id AND t.content_document_id=d.document_id
        WHERE d.project_id=$1 AND d.document_id=$2`, [id]);
      if (!row) return null;
      if (row.primary_task_id && await task(row.primary_task_id)) return {projectId: scope.projectId, taskId: row.primary_task_id, loopId: scope.loopId};
      const linked = await one(`SELECT 1 FROM task_document_link l WHERE l.project_id=$1 AND l.document_id=$2
        AND l.task_id=ANY($3::uuid[]) LIMIT 1`, [id, await authorizedTaskIds()]);
      const own = await one("SELECT 1 FROM document_revision WHERE project_id=$1 AND document_id=$2 AND author=$3 LIMIT 1", [id, identity.principal.actorId]);
      if (linked || own) return {projectId: scope.projectId, taskId: own ? scope.taskId : null, loopId: scope.loopId};
      return await deliveredDocument(id) ?
        {projectId: scope.projectId, taskId: null, loopId: scope.loopId} : null;
    },
    fixedDocument,
    ownedDocumentRevision: async (documentId, revisionId) => !!await one(`SELECT 1 FROM document_revision r
      JOIN process_document d ON d.project_id=r.project_id AND d.document_id=r.document_id
      WHERE r.project_id=$1 AND r.document_id=$2 AND r.revision_id=$3 AND r.author=$4 AND d.kind IN ('report','issue')`,
      [documentId, revisionId, identity.principal.actorId]),
    fixedReference: async (taskId, kind, referenceId, revisionId) => {
      if (await task(taskId) && await one(`SELECT 1
        FROM task_external_ref_snapshot s JOIN task_external_ref_decision d
          ON d.project_id=s.project_id AND d.decision_id=s.decision_id
        WHERE s.project_id=$1 AND s.task_id=ANY($2::uuid[]) AND (s.task_revision_id=
          (SELECT task_revision_id FROM runtime_run WHERE project_id=$1 AND run_id=$3) OR
          ($7 AND s.task_revision_id=(SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=s.task_id)))
        AND d.source_kind=$4 AND d.reference_id=$5 AND ($6::text IS NULL OR d.source_revision=$6) LIMIT 1`,
        [scope.kind === "cognition" ? await authorizedTaskIds() : [taskId], scope.runId, kind, referenceId, revisionId ?? null, scope.kind === "cognition"])) return true;
      const gap = await recoveryGap();
      if (!gap || kind === "wiki" && !revisionId) return false;
      return !!await one(`SELECT 1 FROM task_external_ref_snapshot s
        JOIN task_external_ref_decision d ON d.project_id=s.project_id AND d.decision_id=s.decision_id
        WHERE s.project_id=$1 AND s.task_id=$2 AND s.task_revision_id=$3
          AND d.source_kind=$4 AND d.reference_id=$5
          AND ($6::text IS NULL OR d.source_revision=$6) LIMIT 1`,
        [gap.taskId, gap.taskRevisionId, kind, referenceId, revisionId ?? null]);
    },
    fixedRunTrace: async targetRunId => !!await one(`SELECT 1 FROM runtime_run reader_run
      JOIN runtime_session reader_session ON reader_session.project_id=reader_run.project_id
        AND reader_session.session_id=reader_run.session_id
      JOIN orchestration_dispatch dispatch ON dispatch.project_id=reader_run.project_id
        AND dispatch.data->>'runtimeRunId'=reader_run.run_id::text
      JOIN task_external_ref_snapshot snapshot ON snapshot.project_id=reader_run.project_id
        AND snapshot.task_id=reader_run.task_id AND snapshot.task_revision_id=reader_run.task_revision_id
      JOIN task_external_ref_decision decision ON decision.project_id=snapshot.project_id
        AND decision.decision_id=snapshot.decision_id AND decision.source_kind='run'
      JOIN runtime_run target_run ON target_run.project_id=reader_run.project_id
        AND target_run.run_id::text=decision.reference_id
      JOIN runtime_session target_session ON target_session.project_id=target_run.project_id
        AND target_session.session_id=target_run.session_id
      WHERE reader_run.project_id=$1 AND reader_run.run_id=$2 AND reader_run.task_id=$3
        AND reader_run.session_id=$4 AND reader_session.role_id=$5 AND reader_session.state='ready'
        AND reader_run.native_turn_id IS NOT NULL AND dispatch.loop_id=$6
        AND dispatch.data->>'recipientRoleId'=$5 AND target_run.run_id=$7
        AND decision.source_revision=target_run.task_revision_id::text
        AND decision.content_hash=target_run.input_hash
        AND target_run.state IN ('completed','failed','interrupted') AND target_run.native_turn_id IS NOT NULL
        AND target_session.state='ready' AND target_session.native_thread_id IS NOT NULL
      LIMIT 1`, [scope.runId,scope.taskId,scope.sessionId,scope.roleId,scope.loopId,targetRunId]),
    operation: async id => {
      const row = await one(`SELECT actor_id FROM operation_journal WHERE project_id=$1 AND operation_id=$2
        UNION ALL SELECT actor_id FROM orchestration_operation WHERE project_id=$1 AND operation_id=$2`, [id]);
      return row ? {projectId: scope.projectId, actorId: row.actor_id} : null;
    },
    dispatchForRun: async id => (await one("SELECT data FROM orchestration_dispatch WHERE project_id=$1 AND data->>'runtimeRunId'=$2", [id]))?.data ?? null,
    dispatch: async id => (await one("SELECT data FROM orchestration_dispatch WHERE project_id=$1 AND dispatch_id=$2", [id]))?.data ?? null,
    submission: async id => (await one("SELECT data FROM orchestration_submission WHERE project_id=$1 AND submission_id=$2", [id]))?.data ?? null,
    decision: async id => {
      const row = await one(`SELECT q.data,d.loop_id FROM orchestration_decision q
        JOIN orchestration_dispatch d ON d.project_id=q.project_id AND d.dispatch_id=q.dispatch_id
        WHERE q.project_id=$1 AND q.decision_id=$2`, [id]);
      return row ? {...row.data, loopId: row.loop_id} : null;
    },
  };
}
