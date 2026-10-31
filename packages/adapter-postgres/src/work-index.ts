import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { CommandResult, Principal } from "@evoloop/contracts";
import type {
  LeaderWorkChange, LeaderWorkChangesPage, LeaderWorkDependenciesCommand, LeaderWorkDocument, LeaderWorkPage,
  LeaderWorkPhase, LeaderWorkPlanCommand, LeaderWorkReviewCommand, LeaderWorkTask,
} from "@evoloop/contracts/work-index";
import {
  leaderWorkDependenciesCommandSchema, leaderWorkPlanCommandSchema, leaderWorkReviewCommandSchema,
} from "@evoloop/contracts/work-index";
import { DomainError } from "@evoloop/contracts/ports";

type Database = Pick<Pool | PoolClient, "query">;
export type LeaderWorkView = "tasks" | "documents";
export interface LeaderWorkQuery {
  view: LeaderWorkView;
  limit: number;
  cursor?: string;
  includeClosed?: boolean;
  taskId?: string;
}

const phaseOrder: Record<LeaderWorkPhase, number> = {
  unknown: 0, rework: 1, blocked: 2, awaiting_acceptance: 3, awaiting_delivery: 4,
  awaiting_assignment: 5, ready: 6, running: 7, unassigned: 8, closed: 9, cancelled: 10,
};

interface SnapshotCursor {
  version: 1; view: LeaderWorkView; projectId: string; includeClosed: boolean; taskId?: string;
  sequence: number; offset: number;
}
interface ChangesCursor { version: 1; view: "changes"; projectId: string; sequence: number }

function encodeCursor(value: SnapshotCursor | ChangesCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(value: string | undefined, expected: LeaderWorkView | "changes"): SnapshotCursor | ChangesCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || parsed.view !== expected || typeof parsed.projectId !== "string" ||
      !Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence) < 0 ||
      parsed.taskId !== undefined && typeof parsed.taskId !== "string" ||
      expected !== "changes" && (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0))
      throw new Error("invalid");
    return parsed as unknown as SnapshotCursor | ChangesCursor;
  } catch {
    throw new DomainError("INVALID_CURSOR", "待处理工作游标无效；请从第一页重新核对");
  }
}
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new DomainError("INVALID_WORK_FACT", "待处理工作时间字段格式无效");
}
function optionalIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
function int(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** Changes that affect a Task itself or the current acceptance state of its direct prerequisites. */
function relatedTaskChangeScope(projectColumn: string, taskColumn: string, changeAlias: string): string {
  return `(
    ${changeAlias}.task_id=${taskColumn}
    OR (
      ${changeAlias}.entity_kind IN ('task','closure','queue')
      AND EXISTS (
        SELECT 1 FROM task_dependency related_dependency
        WHERE related_dependency.project_id=${projectColumn}
          AND related_dependency.task_id=${taskColumn}
          AND related_dependency.depends_on_task_id=${changeAlias}.task_id
      )
    )
  )`;
}

function taskPhase(row: QueryResultRow): LeaderWorkPhase {
  if (row.phase) return row.phase as LeaderWorkPhase;
  if (row.state === "cancelled") return "cancelled";
  if (row.state === "done" || row.has_closure === true) return "closed";
  if (row.latest_run_state === "unknown") return "unknown";
  if (["requested", "dispatching", "running"].includes(row.latest_run_state ?? "")) return "running";
  if (int(row.pending_impact_count) > 0) return "blocked";
  if (row.latest_run_state === "failed" || row.latest_run_state === "interrupted") return "rework";
  if ((row.dependency_facts ?? []).some((dependency: { acceptanceSatisfied: boolean }) => !dependency.acceptanceSatisfied)) return "blocked";
  if (row.queue_hold && row.queue_hold !== "awaiting_acceptance") return "blocked";
  if (row.state === "in_progress" && row.latest_run_state === "completed" &&
    (!row.delivery_id || !row.run_updated_at || !row.delivery_created_at ||
      Date.parse(String(row.delivery_created_at)) < Date.parse(String(row.run_updated_at)))) return "awaiting_delivery";
  if (row.observation_result === "failed" &&
    (!row.run_updated_at || !row.observation_created_at ||
      Date.parse(String(row.observation_created_at)) >= Date.parse(String(row.run_updated_at)))) return "rework";
  if (row.delivery_id && row.delivery_result === "failed" &&
    (!row.run_updated_at || !row.delivery_created_at ||
      Date.parse(String(row.delivery_created_at)) >= Date.parse(String(row.run_updated_at)))) return "rework";
  if (row.state === "in_progress" && row.delivery_id) return "awaiting_acceptance";
  if (row.assignment_state === "assigned") return "awaiting_assignment";
  if (row.state === "todo" && (!row.assignment_state || row.assignment_state === "released")) return "unassigned";
  return "ready";
}

function taskFactsSql(includeClosed: boolean, taskParam?: 2 | 4): string {
  return `WITH facts AS (
    SELECT t.project_id,t.task_id,t.version,t.current_revision_id,t.title,t.kind,t.owner,t.state,
      tr.created_at AS business_changed_at,
      first_revision.first_at AS created_at,
      first_run.started_at,
      closure.closed_at AS completed_at,
      assignment.state AS assignment_state,assignment.target_kind AS assignment_target_kind,
      assignment.target_id AS assignment_target_id,assignment.recipient_actor_id AS assignment_recipient_actor_id,
      effective_run.run_id AS latest_run_id,effective_run.state AS latest_run_state,
      effective_run.updated_at AS run_updated_at,
      effective_delivery.delivery_id,effective_delivery.task_revision_id AS delivery_task_revision_id,
      effective_delivery.technical_result AS delivery_result,effective_delivery.created_at AS delivery_created_at,
      observation.result AS observation_result,observation.observer AS observation_actor_id,
      observation.observer_kind AS observation_kind,observation.created_at AS observation_created_at,
      pending_impact.pending_impact_count,queue_gate.hold_code AS queue_hold,
      work_change_latest.work_change_sequence,
      latest_change.sequence AS latest_change_sequence,latest_change.entity_kind AS latest_change_kind,
      latest_change.entity_id AS latest_change_entity_id,latest_change.changed_at AS latest_change_at,
      dependency_head.version AS dependency_version,
      plan.version AS plan_version,plan.planned_start_at,plan.due_at,plan.priority,plan.actor_id AS plan_actor_id,
      plan.updated_at AS plan_updated_at,
      review_latest.review_id,review_latest.decision AS review_decision,review_latest.actor_id AS review_actor_id,
      review_latest.reason AS review_reason,review_latest.operation_id AS review_operation_id,
      review_latest.created_at AS review_created_at,
      review_latest.reviewed_change_sequence AS review_change_sequence,
      closure.closure_id IS NOT NULL AS has_closure,
      CASE
        WHEN t.state='cancelled' THEN 'cancelled'
        WHEN t.state='done' OR closure.closure_id IS NOT NULL THEN 'closed'
        WHEN effective_run.state='unknown' THEN 'unknown'
        WHEN effective_run.state IN ('requested','dispatching','running') THEN 'running'
        WHEN pending_impact.pending_impact_count>0 THEN 'blocked'
        WHEN effective_run.state IN ('failed','interrupted') THEN 'rework'
        WHEN dependency_gate.blocked THEN 'blocked'
        WHEN queue_gate.hold_code IS NOT NULL AND queue_gate.hold_code<>'awaiting_acceptance' THEN 'blocked'
        WHEN t.state='in_progress' AND effective_run.state='completed' AND
          (effective_delivery.delivery_id IS NULL OR effective_run.updated_at IS NULL OR
           effective_delivery.created_at IS NULL OR effective_delivery.created_at<effective_run.updated_at) THEN 'awaiting_delivery'
        WHEN observation.result='failed' AND
          (effective_run.updated_at IS NULL OR observation.created_at IS NULL OR
           observation.created_at>=effective_run.updated_at) THEN 'rework'
        WHEN effective_delivery.delivery_id IS NOT NULL AND effective_delivery.technical_result='failed' AND
          (effective_run.updated_at IS NULL OR effective_delivery.created_at IS NULL OR
           effective_delivery.created_at>=effective_run.updated_at) THEN 'rework'
        WHEN t.state='in_progress' AND effective_delivery.delivery_id IS NOT NULL THEN 'awaiting_acceptance'
        WHEN assignment.state='assigned' THEN 'awaiting_assignment'
        WHEN t.state='todo' AND (assignment.state IS NULL OR assignment.state='released') THEN 'unassigned'
        ELSE 'ready'
      END AS phase
    FROM task t
    JOIN task_revision tr ON tr.project_id=t.project_id AND tr.task_id=t.task_id
      AND tr.revision_id=t.current_revision_id
    LEFT JOIN LATERAL (SELECT min(r.created_at) AS first_at FROM task_revision r
      WHERE r.project_id=t.project_id AND r.task_id=t.task_id) first_revision ON true
    LEFT JOIN LATERAL (SELECT min(e.created_at) AS started_at FROM runtime_record_event e
      JOIN runtime_run r ON r.project_id=e.project_id AND r.run_id=e.run_id
      WHERE e.project_id=t.project_id AND r.task_id=t.task_id AND e.kind='run.bound') first_run ON true
    LEFT JOIN LATERAL (SELECT c.closure_id,c.delivery_id,c.created_at AS closed_at FROM task_closure c
      WHERE c.project_id=t.project_id AND c.task_id=t.task_id
        AND c.task_revision_id=t.current_revision_id
      ORDER BY c.created_at DESC,c.closure_id DESC LIMIT 1) closure ON true
    LEFT JOIN LATERAL (SELECT a.state,a.target_kind,a.target_id,a.recipient_actor_id
      FROM task_session_assignment a
      WHERE a.project_id=t.project_id AND a.task_id=t.task_id
      ORDER BY a.version DESC LIMIT 1) assignment ON true
    LEFT JOIN LATERAL (SELECT d.delivery_id,d.task_revision_id,d.technical_result,d.created_at,d.run_id
      FROM delivery d
      WHERE d.project_id=t.project_id AND d.task_id=t.task_id AND
        ((closure.delivery_id IS NOT NULL AND d.delivery_id=closure.delivery_id) OR
         (closure.delivery_id IS NULL AND d.task_revision_id=t.current_revision_id))
      ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT 1) effective_delivery ON true
    LEFT JOIN LATERAL (SELECT r.run_id,r.state,r.updated_at FROM runtime_run r
      WHERE r.project_id=t.project_id AND r.task_id=t.task_id AND
        ((effective_delivery.run_id IS NOT NULL AND r.run_id=effective_delivery.run_id) OR
         (effective_delivery.delivery_id IS NULL AND r.task_revision_id=t.current_revision_id))
        AND r.state IN ('requested','dispatching','running','unknown','completed','failed','interrupted')
      ORDER BY r.updated_at DESC,r.run_id DESC LIMIT 1) effective_run ON true
    LEFT JOIN LATERAL (SELECT o.result,o.observer,o.observer_kind,o.created_at FROM consumer_observation o
      WHERE o.project_id=t.project_id AND o.delivery_id=effective_delivery.delivery_id
      ORDER BY o.sequence DESC LIMIT 1) observation ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS pending_impact_count FROM impact_review i
      WHERE i.project_id=t.project_id AND i.task_id=t.task_id AND i.state='pending') pending_impact ON true
    LEFT JOIN LATERAL (SELECT e.hold_code FROM resident_queue_entry e
      WHERE e.project_id=t.project_id AND e.task_id=t.task_id AND e.hold_code IS NOT NULL
      ORDER BY e.position,e.entry_id LIMIT 1) queue_gate ON true
    LEFT JOIN LATERAL (SELECT GREATEST(
        COALESCE((SELECT MAX(c.sequence) FROM leader_work_change c
          WHERE c.project_id=t.project_id AND c.task_id=t.task_id),0),
        COALESCE((SELECT MAX(c.sequence) FROM task_dependency d
          JOIN leader_work_change c ON c.project_id=d.project_id AND c.task_id=d.depends_on_task_id
          WHERE d.project_id=t.project_id AND d.task_id=t.task_id
            AND c.entity_kind IN ('task','closure','queue')),0)
      )::bigint AS work_change_sequence) work_change_latest ON true
    LEFT JOIN LATERAL (SELECT c.sequence,c.entity_kind,c.entity_id,c.changed_at
      FROM leader_work_change c
      WHERE c.project_id=t.project_id AND c.task_id=t.task_id
      ORDER BY c.sequence DESC LIMIT 1) latest_change ON true
    LEFT JOIN task_dependency_head dependency_head
      ON dependency_head.project_id=t.project_id AND dependency_head.task_id=t.task_id
    LEFT JOIN task_work_plan plan ON plan.project_id=t.project_id AND plan.task_id=t.task_id
    LEFT JOIN LATERAL (SELECT r.review_id,r.decision,r.actor_id,r.reason,r.operation_id,r.created_at,
        r.reviewed_change_sequence
      FROM leader_work_review r WHERE r.project_id=t.project_id AND r.task_id=t.task_id
        AND r.task_version=t.version AND r.task_revision_id=t.current_revision_id
        AND NOT EXISTS(SELECT 1 FROM leader_work_change c
          WHERE c.project_id=r.project_id AND c.sequence>r.reviewed_change_sequence
            AND c.entity_kind<>'review'
            AND ${relatedTaskChangeScope("r.project_id", "r.task_id", "c")})
      ORDER BY r.review_sequence DESC LIMIT 1) review_latest ON true
    LEFT JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM task_dependency d JOIN task dt
          ON dt.project_id=d.project_id AND dt.task_id=d.depends_on_task_id
        WHERE d.project_id=t.project_id AND d.task_id=t.task_id AND NOT (
          EXISTS(SELECT 1 FROM task_closure c
            WHERE c.project_id=d.project_id AND c.task_id=d.depends_on_task_id
              AND c.task_revision_id=dt.current_revision_id)
          OR EXISTS(SELECT 1 FROM resident_queue_claim q
            JOIN resident_queue_attempt a ON a.project_id=q.project_id AND a.claim_id=q.claim_id
            WHERE q.project_id=d.project_id AND q.task_id=d.depends_on_task_id
              AND q.release_kind='accepted' AND a.task_revision_id=dt.current_revision_id))
      ) AS blocked
    ) dependency_gate ON true
    WHERE t.project_id=$1 ${includeClosed ? "" : "AND t.state NOT IN ('done','cancelled')"}
      ${taskParam ? `AND t.task_id=$${taskParam}::uuid` : ""}
  )`;
}

const taskOrderSql = `CASE facts.phase
    WHEN 'unknown' THEN 0 WHEN 'rework' THEN 1 WHEN 'blocked' THEN 2
    WHEN 'awaiting_acceptance' THEN 3 WHEN 'awaiting_delivery' THEN 4
    WHEN 'awaiting_assignment' THEN 5 WHEN 'ready' THEN 6 WHEN 'running' THEN 7
    WHEN 'unassigned' THEN 8 WHEN 'closed' THEN 9 WHEN 'cancelled' THEN 10
  END,
  COALESCE(facts.due_at, 'infinity'::timestamptz),COALESCE(facts.priority,99),
  facts.title,facts.task_id`;

function documentFactsSql(includeClosed: boolean): string {
  return `WITH facts AS (
    SELECT d.project_id,d.document_id,d.version,d.title,d.kind,d.status,d.current_revision_id,d.adopted_revision_id,
      current.created_at AS current_at,first_revision.created_at,
      adopted.created_at AS adopted_at,changed.changed_at
    FROM process_document d
    JOIN document_revision current ON current.project_id=d.project_id AND current.document_id=d.document_id
      AND current.revision_id=d.current_revision_id
    JOIN LATERAL (SELECT min(r.created_at) AS created_at FROM document_revision r
      WHERE r.project_id=d.project_id AND r.document_id=d.document_id) first_revision ON true
    LEFT JOIN LATERAL (SELECT dd.created_at FROM document_decision dd
      WHERE dd.project_id=d.project_id AND dd.document_id=d.document_id
        AND dd.revision_id=d.adopted_revision_id
      ORDER BY dd.created_at DESC,dd.decision_id DESC LIMIT 1) adopted ON true
    LEFT JOIN LATERAL (SELECT max(c.changed_at) AS changed_at FROM leader_work_change c
      WHERE c.project_id=d.project_id AND c.document_id=d.document_id) changed ON true
    WHERE d.project_id=$1 ${includeClosed ? "" : "AND d.status<>'archived'"}
  )`;
}

function taskAction(phase: LeaderWorkPhase): string {
  switch (phase) {
    case "unknown": return "先按原 Run 与 operation 对账；结果不明时不要重复派发";
    case "rework": return "核对失败结果与当前交付，在原 Task 安排明确返工";
    case "blocked": return "先处理待复核依据、依赖或队列阻断，再决定承接";
    case "awaiting_delivery": return "核对 Run 终态与本人提交；缺交付时保留缺口，不猜结果";
    case "awaiting_acceptance": return "由声明验收责任者核对当前交付与实际使用";
    case "ready": return "核对当前版本后按既有 assignment/queue 规则安排执行";
    case "awaiting_assignment": return "等待承接者确认当前 assignment 与 Task 修订";
    case "running": return "等待当前 Run 的真实终态，运行结束不代表验收";
    case "unassigned": return "负责人选择真实 Role/Session 并按当前版本正式分派";
    case "closed": return "查看固定交付、使用与关闭证据";
    case "cancelled": return "如需继续，先核对取消理由并重新打开";
  }
}

function taskResponsibility(row: QueryResultRow, phase: LeaderWorkPhase): LeaderWorkTask["responsible"] {
  if (phase === "awaiting_acceptance" && row.consumer) return { kind: "consumer", id: row.consumer, label: `验收者 ${row.consumer}` };
  if (["running", "awaiting_delivery", "awaiting_assignment"].includes(phase) && row.assignment_target_id)
    return { kind: "session", id: row.assignment_target_id,
      label: `${row.assignment_target_kind === "owned" ? "受管 Session" : "外部 HostLink"} ${row.assignment_target_id}` };
  if (row.owner) return { kind: "role", id: row.owner, label: `负责 Role ${row.owner}` };
  return { kind: "unknown", id: null, label: "责任者未登记" };
}

function latestProgressEventName(row: QueryResultRow): string {
  switch (row.latest_change_kind as LeaderWorkChange["entityKind"] | undefined) {
    case "task": return "任务内容或状态更新";
    case "document": return "关联文档事件更新";
    case "assignment":
      return row.assignment_state === "accepted" ? "承接已接受"
        : row.assignment_state === "released" ? "承接已释放" : "任务已分派";
    case "delivery": return "交付已登记";
    case "observation": return "使用观察已登记";
    case "closure": return "任务已关闭";
    case "run": return "运行状态已更新";
    case "impact": return "依据影响已更新";
    case "queue": return "队列状态已更新";
    case "plan": return "工作计划已更新";
    case "dependency": return "任务依赖已更新";
    case "review":
      return row.review_decision === "acknowledged" ? "负责人已核对" : "负责人已暂缓";
    default: return "业务事件已更新";
  }
}

export function leaderWorkTaskFromRow(row: QueryResultRow, observedAt: string): LeaderWorkTask {
  const phase = taskPhase(row);
  const assignment = row.assignment_state ? {
    state: row.assignment_state as "assigned" | "accepted" | "released",
    targetKind: row.assignment_target_kind as "owned" | "external",
    targetId: row.assignment_target_id as string,
    recipientActorId: row.assignment_recipient_actor_id as string | null,
  } : null;
  return {
    kind: "task", taskId: row.task_id, version: int(row.version),
    currentRevisionId: row.current_revision_id, workChangeSequence: int(row.work_change_sequence ?? 0),
    title: row.title, taskKind: row.kind, taskState: row.state,
    phase, nextAction: taskAction(phase), responsible: taskResponsibility(row, phase), assignment,
    latestRun: row.latest_run_id ? { runId: row.latest_run_id, state: row.latest_run_state } : null,
    delivery: row.delivery_id ? {
      deliveryId: row.delivery_id, taskRevisionId: row.delivery_task_revision_id,
      technicalResult: row.delivery_result, consumer: row.consumer ?? null,
      useRequired: row.use_required === true, observationResult: row.observation_result ?? null,
      observationActorId: row.observation_actor_id ?? null, observationKind: row.observation_kind ?? null,
    } : null,
    pendingImpactCount: int(row.pending_impact_count),
    queueHold: row.queue_hold ?? null,
    goal: row.goal_id ? { goalId: row.goal_id, outcome: row.goal_outcome } : null,
    stage: row.stage_id ? { stageId: row.stage_id, deliverable: row.stage_deliverable } : null,
    plan: row.plan_version === null || row.plan_version === undefined ? null : {
      plannedStartAt: optionalIso(row.planned_start_at), dueAt: optionalIso(row.due_at),
      priority: row.priority === null || row.priority === undefined ? null : int(row.priority),
      version: int(row.plan_version), actorId: row.plan_actor_id ?? null, updatedAt: optionalIso(row.plan_updated_at),
    },
    dependencies: row.dependency_facts ?? [],
    dependencyVersion: int(row.dependency_version ?? 0),
    review: row.review_id ? {
      reviewId: row.review_id, decision: row.review_decision, actorId: row.review_actor_id,
      reason: row.review_reason, operationId: row.review_operation_id, at: iso(row.review_created_at),
      reviewedChangeSequence: int(row.review_change_sequence),
    } : null,
    dates: {
      createdAt: iso(row.created_at), businessChangedAt: iso(row.business_changed_at),
      startedAt: optionalIso(row.started_at), completedAt: optionalIso(row.completed_at), observedAt,
    },
    latestProgress: row.latest_change_sequence === null || row.latest_change_sequence === undefined ? null : {
      sequence: int(row.latest_change_sequence),
      entityKind: row.latest_change_kind,
      entityId: row.latest_change_entity_id,
      eventName: latestProgressEventName(row),
      changedAt: iso(row.latest_change_at),
    },
    actionKey: `task:${row.task_id}:v${int(row.version)}:${phase}:${int(row.work_change_sequence ?? 0)}`,
  };
}

async function currentChangeSequence(db: Database, projectId: string): Promise<number> {
  const result = await db.query("SELECT COALESCE(MAX(sequence),0)::bigint AS sequence FROM leader_work_change WHERE project_id=$1", [projectId]);
  return int(result.rows[0]?.sequence ?? 0);
}

async function withReadSnapshot<T>(db: Database, action: (snapshot: Database) => Promise<T>): Promise<T> {
  const maybePool = db as Partial<Pool>;
  if (typeof maybePool.connect !== "function") return action(db);
  const client = await maybePool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function assertSnapshot(cursor: SnapshotCursor | null, view: LeaderWorkView, projectId: string,
  includeClosed: boolean, sequence: number, taskId?: string): void {
  if (cursor && (cursor.projectId !== projectId || cursor.view !== view || cursor.includeClosed !== includeClosed ||
    cursor.sequence !== sequence || cursor.taskId !== taskId))
    throw new DomainError("WORK_INDEX_CHANGED", "待处理工作已变化；请从第一页重新核对，不能把旧页当成完整快照");
}

export async function readLeaderWorkTasks(db: Database, projectId: string, query: LeaderWorkQuery): Promise<LeaderWorkPage<LeaderWorkTask>> {
  return withReadSnapshot(db, async snapshot => {
    const sequence = await currentChangeSequence(snapshot, projectId);
    const cursor = decodeCursor(query.cursor, "tasks") as SnapshotCursor | null;
    assertSnapshot(cursor, "tasks", projectId, query.includeClosed === true, sequence, query.taskId);
    const offset = cursor?.offset ?? 0;
    const summary = await snapshot.query(`${taskFactsSql(query.includeClosed === true, query.taskId ? 2 : undefined)}
      SELECT count(*)::int AS total,
        ${Object.keys(phaseOrder).map(phase =>
          `count(*) FILTER (WHERE phase='${phase}')::int AS ${phase}`).join(",")},
        count(*) FILTER (WHERE review_decision='acknowledged')::int AS review_acknowledged,
        count(*) FILTER (WHERE review_decision='deferred')::int AS review_deferred
      FROM facts`, query.taskId ? [projectId, query.taskId] : [projectId]);
    const total = int(summary.rows[0]?.total ?? 0);
    if (offset > total) throw new DomainError("INVALID_CURSOR", "待处理工作分页位置超出当前快照");
    const pageResult = await snapshot.query(`${taskFactsSql(query.includeClosed === true, query.taskId ? 4 : undefined)}
      SELECT facts.*,proposal.consumer,proposal.use_required,
        stage.stage_id,stage.deliverable AS stage_deliverable,
        goal.goal_id,goal.outcome AS goal_outcome,
        COALESCE(dependencies.items,'[]'::jsonb) AS dependency_facts
      FROM facts
      LEFT JOIN LATERAL (SELECT p.consumer,p.use_required,p.stage_id FROM task_proposal p
        JOIN task_revision r ON r.project_id=p.project_id AND r.task_id=p.task_id
          AND r.revision_id=p.task_revision_id
        WHERE p.project_id=facts.project_id AND p.task_id=facts.task_id
        ORDER BY r.version DESC LIMIT 1) proposal ON true
      LEFT JOIN project_stage stage ON stage.project_id=facts.project_id AND stage.stage_id=proposal.stage_id
      LEFT JOIN project_goal goal ON goal.project_id=stage.project_id AND goal.goal_id=stage.goal_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('taskId',d.depends_on_task_id,'title',dt.title,'state',dt.state,
          'currentRevisionId',dt.current_revision_id,'actorId',d.actor_id,'reason',d.reason,'createdAt',d.created_at,
          'acceptanceSatisfied',EXISTS(SELECT 1 FROM task_closure c
            WHERE c.project_id=d.project_id AND c.task_id=d.depends_on_task_id
              AND c.task_revision_id=dt.current_revision_id)
            OR EXISTS(SELECT 1 FROM resident_queue_claim q
              JOIN resident_queue_attempt a ON a.project_id=q.project_id AND a.claim_id=q.claim_id
              WHERE q.project_id=d.project_id AND q.task_id=d.depends_on_task_id AND q.release_kind='accepted'
                AND a.task_revision_id=dt.current_revision_id))
          ORDER BY dt.title,d.depends_on_task_id) AS items
        FROM task_dependency d JOIN task dt ON dt.project_id=d.project_id AND dt.task_id=d.depends_on_task_id
        WHERE d.project_id=facts.project_id AND d.task_id=facts.task_id) dependencies ON true
      ORDER BY ${taskOrderSql}
      LIMIT $2 OFFSET $3`, query.taskId ? [projectId, query.limit, offset, query.taskId] : [projectId, query.limit, offset]);
    const observedAt = new Date().toISOString();
    const items = pageResult.rows.map(row => leaderWorkTaskFromRow(row, observedAt));
    const nextOffset = offset + items.length;
    const counts = Object.fromEntries(Object.keys(phaseOrder).map(phase =>
      [phase, int(summary.rows[0]?.[phase] ?? 0)]));
    counts.review_acknowledged = int(summary.rows[0]?.review_acknowledged ?? 0);
    counts.review_deferred = int(summary.rows[0]?.review_deferred ?? 0);
    return {
      items, total, counts, changeSequence: sequence, observedAt, partial: false,
      nextCursor: nextOffset < total ? encodeCursor({ version: 1, view: "tasks", projectId,
        includeClosed: query.includeClosed === true, ...(query.taskId ? { taskId: query.taskId } : {}),
        sequence, offset: nextOffset }) : null,
    };
  });
}

export async function readLeaderWorkTask(
  db: Database,
  projectId: string,
  taskId: string,
): Promise<LeaderWorkTask | null> {
  const page = await readLeaderWorkTasks(db, projectId, {
    view: "tasks", limit: 1, includeClosed: true, taskId,
  });
  return page.items[0] ?? null;
}

interface DocumentRow extends QueryResultRow {
  document_id: string; version: number; title: string; kind: string | null; status: "draft" | "published" | "archived";
  current_revision_id: string; adopted_revision_id: string | null; current_at: Date; created_at: Date;
  adopted_at: Date | null; changed_at: Date | null; references: LeaderWorkDocument["references"] | null;
}

export function leaderWorkDocumentFromRow(row: DocumentRow, observedAt: string): LeaderWorkDocument {
  return {
    kind: "document", documentId: row.document_id, version: int(row.version), title: row.title,
    documentKind: row.kind as LeaderWorkDocument["documentKind"], status: row.status,
    currentRevisionId: row.current_revision_id, adoptedRevisionId: row.adopted_revision_id,
    nextAction: row.status === "archived" ? "恢复前先核对历史用途与引用任务"
      : row.status === "published" ? "核对已采纳修订是否仍适用于引用任务"
      : "审阅当前修订，再发布或归档",
    dates: { createdAt: iso(row.created_at), currentRevisionAt: iso(row.current_at),
      adoptedAt: optionalIso(row.adopted_at), changedAt: optionalIso(row.changed_at), observedAt },
    references: row.references ?? [],
    actionKey: `document:${row.document_id}:v${int(row.version)}:${row.status}`,
  };
}

async function documentRows(db: Database, projectId: string, limit: number, offset: number,
  includeClosed: boolean): Promise<DocumentRow[]> {
  const result = await db.query(`${documentFactsSql(includeClosed)}
    SELECT facts.*,COALESCE(refs.items,'[]'::jsonb) AS refs
    FROM facts
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('taskId',x.task_id,'title',x.title,'state',x.state,
        'relations',x.relations) ORDER BY x.title,x.task_id) AS items
      FROM (
        SELECT t.task_id,t.title,t.state,array_agg(DISTINCT relation ORDER BY relation) AS relations
        FROM (
          SELECT t.task_id,'content'::text AS relation FROM task t
            WHERE t.project_id=facts.project_id AND t.content_document_id=facts.document_id
          UNION ALL
          SELECT t.task_id,'link'::text AS relation FROM task_document_link l
            JOIN task t ON t.project_id=l.project_id AND t.task_id=l.task_id
            WHERE l.project_id=facts.project_id AND l.document_id=facts.document_id
          UNION ALL
          SELECT t.task_id,'basis'::text AS relation FROM task t
            JOIN task_revision tr ON tr.project_id=t.project_id AND tr.task_id=t.task_id AND tr.revision_id=t.current_revision_id
            JOIN basis_member bm ON bm.project_id=tr.project_id AND bm.task_id=tr.task_id
              AND bm.task_revision_id=tr.revision_id AND bm.basis_set_id=tr.basis_set_id
            WHERE t.project_id=facts.project_id AND bm.document_id=facts.document_id
        ) relations
        JOIN task t ON t.project_id=facts.project_id AND t.task_id=relations.task_id
        GROUP BY t.task_id,t.title,t.state
      ) x
    ) refs ON true
    ORDER BY CASE facts.status WHEN 'archived' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      facts.title,facts.document_id
    LIMIT $2 OFFSET $3`, [projectId, limit, offset]);
  return result.rows.map(row => ({ ...row, references: row.refs })) as DocumentRow[];
}

export async function readLeaderWorkDocuments(db: Database, projectId: string, query: LeaderWorkQuery): Promise<LeaderWorkPage<LeaderWorkDocument>> {
  return withReadSnapshot(db, async snapshot => {
    const sequence = await currentChangeSequence(snapshot, projectId);
    const cursor = decodeCursor(query.cursor, "documents") as SnapshotCursor | null;
    assertSnapshot(cursor, "documents", projectId, query.includeClosed === true, sequence);
    const offset = cursor?.offset ?? 0;
    const summary = await snapshot.query(`${documentFactsSql(query.includeClosed === true)}
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status='draft')::int AS draft,
        count(*) FILTER (WHERE status='published')::int AS published,
        count(*) FILTER (WHERE status='archived')::int AS archived
      FROM facts`, [projectId]);
    const total = int(summary.rows[0]?.total ?? 0);
    if (offset > total) throw new DomainError("INVALID_CURSOR", "文档分页位置超出当前快照");
    const rows = await documentRows(snapshot, projectId, query.limit, offset, query.includeClosed === true);
    const observedAt = new Date().toISOString();
    const items = rows.map(row => leaderWorkDocumentFromRow(row, observedAt));
    const nextOffset = offset + items.length;
    const counts = Object.fromEntries(["draft", "published", "archived"].map(status =>
      [status, int(summary.rows[0]?.[status] ?? 0)]));
    return {
      items, total, counts, changeSequence: sequence, observedAt, partial: false,
      nextCursor: nextOffset < total ? encodeCursor({ version: 1, view: "documents", projectId,
        includeClosed: query.includeClosed === true, sequence, offset: nextOffset }) : null,
    };
  });
}

export async function readLeaderWorkIndex(db: Database, projectId: string, query: LeaderWorkQuery) {
  return query.view === "tasks" ? readLeaderWorkTasks(db, projectId, query) : readLeaderWorkDocuments(db, projectId, query);
}

export async function readLeaderWorkChanges(db: Database, projectId: string, limit: number, cursor?: string): Promise<LeaderWorkChangesPage> {
  return withReadSnapshot(db, async snapshot => {
    const cursorValue = decodeCursor(cursor, "changes") as ChangesCursor | null;
    if (cursorValue && cursorValue.projectId !== projectId)
      throw new DomainError("INVALID_CURSOR", "变化游标属于另一个项目");
    const after = cursorValue?.sequence ?? 0;
    const sequence = await currentChangeSequence(snapshot, projectId);
    const result = await snapshot.query(`SELECT sequence,entity_kind,entity_id,task_id,document_id,version,changed_at
      FROM leader_work_change WHERE project_id=$1 AND sequence>$2 AND sequence<=$3
      ORDER BY sequence LIMIT $4`, [projectId, after, sequence, limit + 1]);
    const items: LeaderWorkChange[] = result.rows.slice(0, limit).map(row => ({
      sequence: int(row.sequence), entityKind: row.entity_kind, entityId: row.entity_id, taskId: row.task_id ?? null,
      documentId: row.document_id ?? null, version: row.version === null ? null : int(row.version), changedAt: iso(row.changed_at),
    }));
    return {
      items, changeSequence: sequence, observedAt: new Date().toISOString(),
      nextCursor: encodeCursor({ version: 1, view: "changes", projectId,
        sequence: items.at(-1)?.sequence ?? sequence }),
    };
  });
}

function commandHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export class PgLeaderWorkWriter {
  constructor(private readonly pool: Pool) {}

  async setTaskPlan(principal: Principal, projectId: string, input: LeaderWorkPlanCommand): Promise<CommandResult> {
    const command = leaderWorkPlanCommandSchema.parse({ ...input, projectId });
    return this.perform(projectId, principal, command, "work.plan.set", async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`leader-work:${projectId}`]);
      const task = await client.query("SELECT version FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE",
        [projectId, command.taskId]);
      if (!task.rows[0]) throw new DomainError("TASK_UNAVAILABLE", "Task does not exist in this project");
      if (int(task.rows[0].version) !== command.expectedTaskVersion)
        throw new DomainError("VERSION_CONFLICT", "Task changed before the plan update", int(task.rows[0].version));
      const existing = await client.query("SELECT version FROM task_work_plan WHERE project_id=$1 AND task_id=$2 FOR UPDATE",
        [projectId, command.taskId]);
      const observed = existing.rows[0] ? int(existing.rows[0].version) : 0;
      if (observed !== command.expectedPlanVersion)
        throw new DomainError("VERSION_CONFLICT", "Task plan changed", observed);
      const version = observed + 1;
      await client.query(`INSERT INTO task_work_plan(project_id,task_id,version,planned_start_at,due_at,priority,
          actor_id,reason,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(project_id,task_id) DO UPDATE SET version=EXCLUDED.version,
          planned_start_at=EXCLUDED.planned_start_at,due_at=EXCLUDED.due_at,priority=EXCLUDED.priority,
          actor_id=EXCLUDED.actor_id,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`,
        [projectId, command.taskId, version, command.plannedStartAt, command.dueAt, command.priority,
          principal.actorId, command.reason, new Date().toISOString()]);
      return { status: "applied", operationId: command.operationId, entityId: command.taskId, version };
    });
  }

  async setTaskDependencies(principal: Principal, projectId: string, input: LeaderWorkDependenciesCommand): Promise<CommandResult> {
    const command = leaderWorkDependenciesCommandSchema.parse({ ...input, projectId });
    return this.perform(projectId, principal, command, "work.dependencies.set", async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`leader-work:${projectId}`]);
      const task = await client.query("SELECT version FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE",
        [projectId, command.taskId]);
      if (!task.rows[0]) throw new DomainError("TASK_UNAVAILABLE", "Task does not exist in this project");
      if (int(task.rows[0].version) !== command.expectedTaskVersion)
        throw new DomainError("VERSION_CONFLICT", "Task changed before the dependency update", int(task.rows[0].version));
      const existing = await client.query("SELECT version FROM task_dependency_head WHERE project_id=$1 AND task_id=$2 FOR UPDATE",
        [projectId, command.taskId]);
      const observed = existing.rows[0] ? int(existing.rows[0].version) : 0;
      if (observed !== command.expectedDependencyVersion)
        throw new DomainError("VERSION_CONFLICT", "Task dependencies changed", observed);
      if (command.dependsOnTaskIds.includes(command.taskId))
        throw new DomainError("DEPENDENCY_CYCLE", "A Task cannot depend on itself");
      if (command.dependsOnTaskIds.length) {
        const found = await client.query("SELECT task_id FROM task WHERE project_id=$1 AND task_id=ANY($2::uuid[])",
          [projectId, command.dependsOnTaskIds]);
        if (found.rowCount !== command.dependsOnTaskIds.length)
          throw new DomainError("TASK_UNAVAILABLE", "One or more dependency Tasks do not exist in this project");
        const cycle = await client.query(`WITH RECURSIVE reach(task_id) AS (
            SELECT unnest($2::uuid[])
            UNION
            SELECT d.depends_on_task_id FROM task_dependency d
              JOIN reach r ON r.task_id=d.task_id WHERE d.project_id=$1
          ) SELECT EXISTS(SELECT 1 FROM reach WHERE task_id=$3) AS cycle`,
          [projectId, command.dependsOnTaskIds, command.taskId]);
        if (cycle.rows[0]?.cycle === true) throw new DomainError("DEPENDENCY_CYCLE", "Dependency update would create a cycle");
      }
      const version = observed + 1;
      await client.query("DELETE FROM task_dependency WHERE project_id=$1 AND task_id=$2", [projectId, command.taskId]);
      for (const dependencyId of command.dependsOnTaskIds)
        await client.query(`INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,actor_id,reason,created_at)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [projectId, command.taskId, dependencyId, principal.actorId, command.reason, new Date().toISOString()]);
      await client.query(`INSERT INTO task_dependency_head(project_id,task_id,version,updated_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(project_id,task_id) DO UPDATE SET version=EXCLUDED.version,updated_at=EXCLUDED.updated_at`,
        [projectId, command.taskId, version, new Date().toISOString()]);
      return { status: "applied", operationId: command.operationId, entityId: command.taskId, version };
    });
  }

  async setTaskReview(principal: Principal, projectId: string, input: LeaderWorkReviewCommand): Promise<CommandResult> {
    const command = leaderWorkReviewCommandSchema.parse({ ...input, projectId });
    return this.perform(projectId, principal, command, "work.review.set", async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`leader-work:${projectId}`]);
      const task = await client.query("SELECT version,current_revision_id FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE",
        [projectId, command.taskId]);
      if (!task.rows[0]) throw new DomainError("TASK_UNAVAILABLE", "Task does not exist in this project");
      if (int(task.rows[0].version) !== command.expectedTaskVersion)
        throw new DomainError("VERSION_CONFLICT", "Task changed before the review decision", int(task.rows[0].version));
      if (task.rows[0].current_revision_id !== command.expectedTaskRevisionId)
        throw new DomainError("VERSION_CONFLICT", "Task revision changed before the review decision");
      const sequence = await client.query(`SELECT COALESCE(MAX(sequence),0)::bigint AS sequence
        FROM leader_work_change c WHERE c.project_id=$1
          AND ${relatedTaskChangeScope("$1", "$2", "c")}`, [projectId, command.taskId]);
      if (int(sequence.rows[0]?.sequence ?? 0) !== command.expectedWorkChangeSequence)
        throw new DomainError("WORK_INDEX_CHANGED",
          "Task-related work changed after the Leader read; reload before recording a review");
      await client.query(`INSERT INTO leader_work_review(project_id,review_id,task_id,task_version,task_revision_id,
        reviewed_change_sequence,decision,reason,actor_id,operation_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [projectId, randomUUID(), command.taskId, command.expectedTaskVersion, command.expectedTaskRevisionId,
          command.expectedWorkChangeSequence, command.decision, command.reason, principal.actorId,
          command.operationId, new Date().toISOString()]);
      return { status: "applied", operationId: command.operationId, entityId: command.taskId,
        version: command.expectedTaskVersion };
    });
  }

  private async perform(projectId: string, principal: Principal,
    command: LeaderWorkPlanCommand | LeaderWorkDependenciesCommand | LeaderWorkReviewCommand, commandType: string,
    action: (client: PoolClient) => Promise<Extract<CommandResult, { status: "applied" }>>): Promise<CommandResult> {
    const client = await this.pool.connect();
    const hash = commandHash({ ...command, actorId: principal.actorId, projectId });
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [projectId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`leader-work-operation:${command.operationId}`]);
      const existing = await client.query(`SELECT actor_id,command_hash,command_type,result FROM operation_journal
        WHERE project_id=$1 AND operation_id=$2 FOR UPDATE`, [projectId, command.operationId]);
      if (existing.rows[0]) {
        if (existing.rows[0].actor_id !== principal.actorId || existing.rows[0].command_hash !== hash ||
          existing.rows[0].command_type !== commandType)
          throw new DomainError("OPERATION_CONFLICT", "Operation ID was already used for another command");
        await client.query("COMMIT");
        return existing.rows[0].result as CommandResult;
      }
      const result = await action(client);
      await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [projectId, command.operationId, principal.actorId, hash, commandType, JSON.stringify(result), new Date().toISOString()]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
