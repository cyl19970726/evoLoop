import { createHash, randomUUID } from "node:crypto";
import pg, { type Pool, type PoolClient, type QueryResultRow } from "pg";
import type { CommandResult, Principal } from "@evoloop/contracts";
import type {
  LeaderWorkChange, LeaderWorkChangesPage, LeaderWorkDependenciesCommand, LeaderWorkDocument, LeaderWorkPage,
  LeaderWorkPhase, LeaderWorkPlanCommand, LeaderWorkReviewCommand, LeaderWorkTask,
  LeaderWorkTaskTiming, LeaderWorkTimingInterval, LeaderWorkTimingStage, LeaderWorkWaitingFor,
} from "@evoloop/contracts/work-index";
import { acceptanceReadiness, preconditionText } from "@evoloop/contracts/acceptance-convention";
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
    (!row.delivery_id || row.delivery_run_id && row.delivery_run_id !== row.latest_run_id ||
      !row.delivery_run_id && (!row.run_updated_at || !row.delivery_created_at ||
        Date.parse(String(row.delivery_created_at)) < Date.parse(String(row.run_updated_at))))) return "awaiting_delivery";
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
      assignment.task_revision_id AS assignment_task_revision_id,
      effective_run.run_id AS latest_run_id,effective_run.state AS latest_run_state,
      effective_run.session_id AS latest_run_session_id,effective_run.native_turn_id AS latest_run_native_turn_id,
      effective_run.updated_at AS run_updated_at,
      effective_delivery.delivery_id,effective_delivery.task_revision_id AS delivery_task_revision_id,
      effective_delivery.technical_result AS delivery_result,effective_delivery.created_at AS delivery_created_at,
      effective_delivery.run_id AS delivery_run_id,
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
          (effective_delivery.delivery_id IS NULL OR
           (effective_delivery.run_id IS NOT NULL AND effective_delivery.run_id<>effective_run.run_id) OR
           (effective_delivery.run_id IS NULL AND (effective_run.updated_at IS NULL OR
            effective_delivery.created_at IS NULL OR effective_delivery.created_at<effective_run.updated_at))) THEN 'awaiting_delivery'
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
    LEFT JOIN LATERAL (SELECT a.state,a.target_kind,a.target_id,a.recipient_actor_id,a.task_revision_id
      FROM task_session_assignment a
      WHERE a.project_id=t.project_id AND a.task_id=t.task_id
      ORDER BY a.version DESC LIMIT 1) assignment ON true
    LEFT JOIN LATERAL (SELECT d.delivery_id,d.task_revision_id,d.technical_result,d.created_at,d.run_id
      FROM delivery d
      WHERE d.project_id=t.project_id AND d.task_id=t.task_id AND
        ((closure.delivery_id IS NOT NULL AND d.delivery_id=closure.delivery_id) OR
         (closure.delivery_id IS NULL AND d.task_revision_id=t.current_revision_id))
      ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT 1) effective_delivery ON true
    LEFT JOIN LATERAL (SELECT r.run_id,r.session_id,r.native_turn_id,r.state,r.created_at,r.updated_at FROM runtime_run r
      WHERE r.project_id=t.project_id AND r.task_id=t.task_id AND
        (r.task_revision_id=t.current_revision_id OR r.run_id=effective_delivery.run_id OR
         (effective_delivery.delivery_id IS NOT NULL AND r.created_at<=effective_delivery.created_at
          AND NOT EXISTS (SELECT 1 FROM task_revision newer_revision
            WHERE newer_revision.project_id=t.project_id AND newer_revision.task_id=t.task_id
              AND newer_revision.created_at>r.created_at AND newer_revision.state='todo')))
        AND r.state IN ('requested','dispatching','running','unknown','completed','failed','interrupted')
      ORDER BY r.created_at DESC,r.run_id DESC LIMIT 1) effective_run ON true
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

/** What the Task declared about acceptance, with whether the delivery can be checked yet. Null when it declared nothing. */
function acceptanceConvention(row: QueryResultRow): NonNullable<LeaderWorkTask["acceptanceConvention"]> | null {
  if (!row.acceptance_target && !row.acceptance_precondition) return null;
  return { acceptanceTarget: row.acceptance_target ?? null,
    acceptancePrecondition: row.acceptance_precondition ?? null,
    readiness: row.delivery_id ? acceptanceReadiness(row.acceptance_precondition, row.precondition_marked === true) : null,
    namedAgent: row.acceptance_target === "named_agent" ? String(row.consumer ?? "") || null : null };
}
/** A delivery that is waiting for its precondition is not "ready to accept"; a named-agent Task needs no arrangement. */
function conventionAction(row: QueryResultRow, phase: LeaderWorkPhase, base: string): string {
  if (phase !== "awaiting_acceptance") return base;
  const waiting = row.acceptance_precondition && row.acceptance_precondition !== "none" && row.precondition_marked !== true;
  const who = row.acceptance_target === "named_agent" ? `由声明的业务身份 ${row.consumer || "（未写明）"} 直接验收，不经验收接力，不要安排接力` : base;
  return waiting ? `等待${preconditionText[row.acceptance_precondition as keyof typeof preconditionText]}后才可验收（尚未标记已满足）；${who}` : who;
}
function conventionResponsible(row: QueryResultRow, phase: LeaderWorkPhase, base: LeaderWorkTask["responsible"]): LeaderWorkTask["responsible"] {
  return phase === "awaiting_acceptance" && row.acceptance_target === "named_agent" && row.consumer
    ? { kind: "consumer", id: String(row.consumer), label: `验收者 ${row.consumer}（直接验收）` } : base;
}

function taskResponsibility(row: QueryResultRow, phase: LeaderWorkPhase,
  timing: LeaderWorkTaskTiming): LeaderWorkTask["responsible"] {
  if (phase === "awaiting_acceptance") {
    const waiting = timing.current.waitingFor;
    if (waiting.kind === "consumer" && waiting.id)
      return { kind: "consumer", id: waiting.id, label: `验收者 ${waiting.id}` };
    if (waiting.kind === "leader" && waiting.id)
      return { kind: "leader", id: waiting.id, label: `项目 Leader ${waiting.id}` };
    if (waiting.kind === "role" && waiting.id)
      return { kind: "role", id: waiting.id, label: `负责 Role ${waiting.id}` };
    if (waiting.kind === "session" && waiting.id)
      return { kind: "session", id: waiting.id, label: `Session ${waiting.id}` };
    if (waiting.kind === "publisher" && waiting.id)
      return { kind: "publisher", id: waiting.id, label: `发布维护者 ${waiting.id}` };
    if (waiting.kind === "user" && waiting.id)
      return { kind: "user", id: waiting.id, label: `用户 ${waiting.id}` };
    if (waiting.kind === "task" && waiting.id)
      return { kind: "task", id: waiting.id, label: `前置任务 ${waiting.id}` };
    return { kind: "unknown", id: null, label: "下一责任未登记" };
  }
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
    case "submission": return "作者已提交封存意图";
    case "impact": return "依据影响已更新";
    case "queue": return "队列状态已更新";
    case "plan": return "工作计划已更新";
    case "dependency": return "任务依赖已更新";
    case "review":
      return row.review_decision === "acknowledged" ? "负责人已核对" : "负责人已暂缓";
    default: return "业务事件已更新";
  }
}

interface TimingEvent {
  kind: string; id: string; at: string; state?: string | null;
  targetId?: string | null; runId?: string | null; deliveryId?: string | null;
  reservationRunId?: string | null;
  taskRevisionId?: string | null; sequence?: number | null; taskVersion?: number | null;
}
const eventOrder: Record<string, number> = {
  task: 0, assignment: 1, ack: 2, run_reserved: 3, run_bound: 4,
  run_terminal: 5, submission: 6, delivery: 7, observation: 8,
  publication_ready: 9, publication_published: 10, closure: 11, review: 12,
};
function validTime(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function duration(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
function timingWaitingFor(stage: LeaderWorkTimingStage, row: QueryResultRow,
  targetId: string | null, observationUsed = false): LeaderWorkWaitingFor {
  if (["awaiting_ack", "awaiting_run", "run_reserved", "running", "awaiting_submission", "awaiting_delivery"].includes(stage))
    return targetId ? { kind: "session", id: targetId } : { kind: "unknown", id: null };
  if (stage === "awaiting_acceptance") return !observationUsed && row.use_required && row.consumer
    ? { kind: "consumer", id: String(row.consumer) }
    : row.owner ? { kind: "role", id: String(row.owner) } : { kind: "unknown", id: null };
  if (stage === "awaiting_publication") return { kind: "publisher", id: targetId ?? row.publication_owner ?? null };
  if (stage === "blocked") {
    const blocked = (row.dependency_facts as Array<{ taskId: string; acceptanceSatisfied: boolean }> | undefined)
      ?.find(item => !item.acceptanceSatisfied);
    if (blocked) return { kind: "task", id: blocked.taskId };
  }
  if (["unassigned", "rework"].includes(stage)) return row.owner
    ? { kind: "role", id: String(row.owner) } : { kind: "unknown", id: null };
  return { kind: "unknown", id: null };
}

function taskTiming(row: QueryResultRow, observedAt: string): LeaderWorkTaskTiming {
  const observed = validTime(observedAt) ?? new Date().toISOString();
  const raw = Array.isArray(row.timing_events) ? row.timing_events as TimingEvent[] : [];
  const events = raw.map(event => ({ ...event, at: validTime(event.at) }))
    .filter((event): event is TimingEvent => event.at !== null && typeof event.id === "string")
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) ||
      (a.taskVersion == null || b.taskVersion == null ? 0 : Number(a.taskVersion) - Number(b.taskVersion)) ||
      (a.sequence == null && b.sequence == null ? 0 :
        a.sequence == null || b.sequence == null ? 0 : Number(a.sequence) - Number(b.sequence)) ||
      (eventOrder[a.kind] ?? 99) - (eventOrder[b.kind] ?? 99) || a.id.localeCompare(b.id));
  const seenPublication = new Set<string>();
  const uniqueEvents = events.filter(event => {
    if (event.kind !== "publication_ready" && event.kind !== "publication_published") return true;
    const key = `${event.kind}:${event.id}:${event.at}:${event.targetId ?? ""}`;
    if (seenPublication.has(key)) return false;
    seenPublication.add(key);
    return true;
  });
  const createdAt = uniqueEvents.find(event => event.kind === "task")?.at ?? validTime(row.created_at);
  const rounds: LeaderWorkTaskTiming["rounds"] = [];
  let round: LeaderWorkTaskTiming["rounds"][number] | null = null;
  let active: LeaderWorkTimingInterval | null = null;
  const getRound = () => round;
  const getActive = () => active;
  let targetId: string | null = null;
  let latestEffectiveProgress: LeaderWorkTaskTiming["latestEffectiveProgress"] = null;
  let priorObservation: string | null = null;
  let observationUsed = false;
  let activeRun: { id: string; taskRevisionId: string | null; taskVersion: number | null;
    targetId: string | null; assignmentIds: Set<string> } | null = null;
  const assignmentIds = new Set<string>();
  const supersededRuns = new Set<string>();
  let currentAssignmentId: string | null = null;
  const submittedRuns = new Set<string>();
  const belongsToActiveRun = (event: TimingEvent) => activeRun !== null &&
    event.targetId === activeRun.targetId && event.targetId !== null &&
    (event.taskVersion != null && activeRun.taskVersion != null
      ? Number(event.taskVersion) <= activeRun.taskVersion
      : event.taskRevisionId != null && event.taskRevisionId === activeRun.taskRevisionId) &&
    ["run_reserved", "running", "awaiting_submission", "awaiting_delivery", "awaiting_acceptance",
      "awaiting_publication", "rework", "unknown"].includes(active?.stage ?? "");
  const begin = (stage: LeaderWorkTimingStage, at: string | null, source: { kind: string; id: string } | null) => {
    if (!round) {
      round = { number: rounds.length + 1, startedAt: at, endedAt: null, elapsedMs: null, intervals: [] };
      rounds.push(round);
    }
    if (active?.stage === stage && active.source?.id === source?.id) return;
    if (active) active.endedAt = at && active.startedAt && Date.parse(at) >= Date.parse(active.startedAt) ? at : null;
    active = { stage, startedAt: at, endedAt: null, source,
      waitingFor: timingWaitingFor(stage, row, targetId, observationUsed) };
    round.intervals.push(active);
  };
  const progress = (event: TimingEvent) => {
    if (Date.parse(event.at) <= Date.parse(observed) &&
      (!latestEffectiveProgress || Date.parse(event.at) >= Date.parse(latestEffectiveProgress.at)))
      latestEffectiveProgress = { kind: event.kind, sourceId: event.id, at: event.at };
  };
  for (const event of uniqueEvents) {
    if (event.kind === "task") {
      if (!getRound() || getRound()?.endedAt && event.state !== "done" && event.state !== "cancelled") {
        round = null; active = null; targetId = null; activeRun = null; currentAssignmentId = null;
        begin(event.state === "todo" ? "unassigned" : "awaiting_run", event.at,
          { kind: "task_revision", id: event.id });
        progress(event);
      } else if (event.state === "cancelled") begin("cancelled", event.at, { kind: "task_revision", id: event.id });
      else if (event.state === "in_progress" && getActive()?.stage === "unassigned")
        begin("awaiting_run", event.at, { kind: "task_revision", id: event.id });
      continue;
    }
    if (!getRound()) continue;
    if (getRound()?.endedAt) {
      if (event.kind === "publication_ready" || event.kind === "publication_published") progress(event);
      continue;
    }
    if (event.kind === "assignment") {
      // The reserve transaction advances an unacknowledged assignment after inserting
      // its Run. That revision belongs to the Run; it is not a later reassignment.
      if (event.reservationRunId === activeRun?.id && activeRun &&
        event.taskRevisionId === activeRun.taskRevisionId) {
        assignmentIds.add(event.id);
        activeRun.assignmentIds.add(event.id);
        currentAssignmentId = event.id;
        continue;
      }
      if (event.state === "accepted" && belongsToActiveRun(event) && activeRun) {
        assignmentIds.add(event.id);
        activeRun.assignmentIds.add(event.id);
        currentAssignmentId = event.id;
        continue;
      }
      if (event.state !== "released" && belongsToActiveRun(event) &&
        activeRun?.assignmentIds.has(event.id)) continue;
      assignmentIds.add(event.id);
      currentAssignmentId = event.id;
      if (activeRun) supersededRuns.add(activeRun.id);
      activeRun = null;
      targetId = event.targetId ?? null;
      begin(event.state === "released" ? "unassigned" : event.state === "accepted" ? "awaiting_run" : "awaiting_ack",
        event.at, { kind: "assignment", id: event.id });
      progress(event);
    } else if (event.kind === "ack") {
      if (currentAssignmentId && event.id !== currentAssignmentId) continue;
      if (belongsToActiveRun(event) && activeRun?.assignmentIds.has(event.id)) continue;
      targetId = event.targetId ?? targetId;
      begin("awaiting_run", event.at, { kind: "assignment", id: event.id });
      progress(event);
    } else if (event.kind === "run_reserved") {
      targetId = event.targetId ?? targetId;
      activeRun = { id: event.id, taskRevisionId: event.taskRevisionId ?? null,
        taskVersion: event.taskVersion == null ? null : Number(event.taskVersion), targetId,
        assignmentIds: new Set(assignmentIds) };
      begin("run_reserved", event.at, { kind: "run", id: event.id });
      progress(event);
    } else if (event.kind === "run_bound") {
      if (supersededRuns.has(event.id)) continue;
      activeRun = { id: event.id,
        taskRevisionId: event.taskRevisionId ?? null,
        taskVersion: event.taskVersion == null ? null : Number(event.taskVersion), targetId,
        assignmentIds: new Set(assignmentIds) };
      begin("running", event.at, { kind: "run", id: event.id });
      progress(event);
    } else if (event.kind === "run_terminal") {
      if (supersededRuns.has(event.id) || activeRun && event.id !== activeRun.id) continue;
      if (event.state === "completed" && submittedRuns.has(event.id)) continue;
      begin(event.state === "completed" ? "awaiting_submission" : event.state === "unknown" ? "unknown" : "rework",
        event.at, { kind: "run", id: event.id });
      progress(event);
    } else if (event.kind === "submission") {
      if (event.runId) submittedRuns.add(event.runId);
      if (event.runId && (supersededRuns.has(event.runId) || activeRun && event.runId !== activeRun.id)) continue;
      begin("awaiting_delivery", event.at, { kind: "submission", id: event.id });
      progress(event);
    } else if (event.kind === "delivery") {
      if (event.runId && supersededRuns.has(event.runId)) continue;
      observationUsed = false;
      begin(event.state === "failed" ? "rework" : "awaiting_acceptance", event.at,
        { kind: "delivery", id: event.id });
      progress(event);
    } else if (event.kind === "observation") {
      observationUsed = event.state === "used";
      begin(event.state === "failed" || event.state === "notUsed" ? "rework" : "awaiting_acceptance",
        event.at, { kind: "observation", id: event.id });
      const key = `${event.deliveryId}:${event.state}`;
      if (key !== priorObservation) progress(event);
      priorObservation = key;
    } else if (event.kind === "publication_ready") {
      targetId = event.targetId ?? null;
      begin("awaiting_publication", event.at, { kind: "release_handoff", id: event.id });
      progress(event);
    } else if (event.kind === "publication_published") {
      begin(row.delivery_id ? "awaiting_acceptance" : "unknown", event.at,
        { kind: "publication", id: event.id });
      progress(event);
    } else if (event.kind === "closure") {
      begin("closed", event.at, { kind: "closure", id: event.id });
      const completedRound = getRound();
      if (completedRound) completedRound.endedAt = event.at;
      progress(event);
    }
  }
  if (!getRound()) begin(row.state === "todo" ? "unassigned" : "unknown", createdAt, null);
  // A current gate can supersede a past interval, but without its own time source its age is unknown.
  const phase = taskPhase(row);
  if (phase === "blocked" && getActive()?.stage !== "blocked") begin("blocked", null, null);
  if (phase === "unknown" && getActive()?.stage !== "unknown") begin("unknown", null, null);
  if (phase === "cancelled" && getActive()?.stage !== "cancelled") begin("cancelled", validTime(row.business_changed_at), null);
  if (phase === "closed" && getActive()?.stage !== "closed") begin("closed", validTime(row.completed_at), null);
  if (phase === "awaiting_delivery" && getActive()?.stage === "awaiting_acceptance") {
    const runEvent = [...uniqueEvents].reverse().find(event => event.kind === "run_terminal" && event.id === row.latest_run_id);
    const candidate = runEvent?.at ?? validTime(row.run_updated_at);
    const start = candidate && getActive()?.startedAt && Date.parse(candidate) < Date.parse(getActive()!.startedAt!)
      ? null : candidate;
    if (start === null && getActive()) getActive()!.endedAt = getActive()!.startedAt;
    begin("awaiting_submission", start,
      row.latest_run_id ? { kind: "run", id: row.latest_run_id } : null);
  }
  let current = getActive()!;
  const closedAt = getRound()?.endedAt;
  // An explicit release handoff may follow Task closure. It is a current external
  // wait, while the Task round's total still ends at the immutable closure time.
  const postClosurePublication = closedAt ? [...uniqueEvents].reverse().find(event =>
    (event.kind === "publication_ready" || event.kind === "publication_published") &&
    Date.parse(event.at) >= Date.parse(closedAt)) : null;
  if (postClosurePublication?.kind === "publication_ready") current = {
    stage: "awaiting_publication", startedAt: postClosurePublication.at, endedAt: null,
    source: { kind: "release_handoff", id: postClosurePublication.id },
    waitingFor: { kind: "publisher", id: postClosurePublication.targetId ?? null },
  };
  // Keep the historical handoff interval, but a withdrawn or superseded handoff
  // cannot remain the current publication wait or keep its attention notice alive.
  const currentHandoff = row.current_release_handoff as {
    artifactRef?: string; recipient?: string; readyForPublicationAt?: string
  } | null;
  const currentArtifactRef = currentHandoff?.artifactRef;
  if (current.stage === "awaiting_publication" &&
    row.follow_up_task_revision_id === row.current_revision_id && currentHandoff && currentArtifactRef &&
    (current.source?.id !== currentArtifactRef ||
      current.waitingFor?.id !== currentHandoff.recipient ||
      current.startedAt !== validTime(currentHandoff.readyForPublicationAt))) {
    // The revision head, rather than a backdated event's sort order, owns the
    // current publishing responsibility. Keep the superseded interval as history.
    current = { stage: "awaiting_publication",
      startedAt: validTime(row.follow_up_updated_at), endedAt: null,
      source: { kind: "release_handoff", id: currentArtifactRef },
      waitingFor: { kind: "publisher", id: currentHandoff.recipient ?? null } };
  }
  const followUpWaiting = row.follow_up_task_revision_id === row.current_revision_id
    ? row.follow_up_waiting_on as LeaderWorkWaitingFor | null : null;
  if (current.stage === "awaiting_acceptance" && followUpWaiting?.kind &&
    (typeof followUpWaiting.id === "string" || followUpWaiting.id === null))
    current.waitingFor = followUpWaiting.id === null || followUpWaiting.kind === "unknown"
      ? { kind: "unknown", id: null } : followUpWaiting;
  if (current.stage === "awaiting_publication" &&
    (row.follow_up_task_revision_id !== row.current_revision_id || !currentArtifactRef)) {
    const sameRevision = row.follow_up_task_revision_id === row.current_revision_id;
    const at = sameRevision ? validTime(row.follow_up_updated_at) : null;
    const source = sameRevision && row.follow_up_version
      ? { kind: "release_handoff_withdrawn", id: `${row.task_id}:v${row.follow_up_version}` } : null;
    if (current === getActive()) {
      begin("unknown", at, source);
      current = getActive()!;
    } else current = { stage: "unknown", startedAt: at, endedAt: null, source,
      waitingFor: { kind: "unknown", id: null } };
  }
  const published = [...uniqueEvents].reverse().find(event => event.kind === "publication_published" &&
    (!getRound()?.startedAt || Date.parse(event.at) >= Date.parse(getRound()!.startedAt!)));
  for (const item of rounds) item.elapsedMs = duration(item.startedAt, item.endedAt ?? observed);
  const native = row.native_observation as {
    observedAt?: unknown; lastEventAt?: unknown; freshness?: unknown;
    currentTurn?: { source?: { kind?: unknown; taskId?: unknown; runId?: unknown } | null } | null;
  } | undefined;
  const nativeAt = validTime(native?.lastEventAt), nativeObservedAt = validTime(native?.observedAt);
  const source = native?.currentTurn?.source;
  const executionActivity = source?.kind === "run" && source.taskId === row.task_id &&
    source.runId === row.latest_run_id && native?.currentTurn &&
    (native.currentTurn as { id?: string }).id === row.latest_run_native_turn_id && nativeAt && nativeObservedAt &&
    Date.parse(nativeAt) <= Date.parse(nativeObservedAt) && Date.parse(nativeObservedAt) <= Date.parse(observed)
    ? { runId: String(source.runId), kind: "native_turn" as const, at: nativeAt, observedAt: nativeObservedAt,
      freshness: native?.freshness === "live" ? "live" as const : native?.freshness === "stale" ? "stale" as const : "unknown" as const }
    : null;
  return {
    createdAt, publication: published ? { at: published.at, source: "explicit" } : { at: null, source: "unknown" },
    current: { ...current, elapsedMs: duration(current.startedAt, current.endedAt ?? observed) },
    rounds, latestEffectiveProgress, executionActivity, observedAt: observed,
  };
}

export function leaderWorkTaskFromRow(row: QueryResultRow, observedAt: string): LeaderWorkTask {
  const phase = taskPhase(row);
  const timing = taskTiming(row, observedAt);
  const assignment = row.assignment_state ? {
    state: row.assignment_state as "assigned" | "accepted" | "released",
    targetKind: row.assignment_target_kind as "owned" | "external",
    targetId: row.assignment_target_id as string,
    recipientActorId: row.assignment_recipient_actor_id as string | null,
    taskRevisionId: row.assignment_task_revision_id as string,
  } : null;
  return {
    kind: "task", taskId: row.task_id, version: int(row.version),
    currentRevisionId: row.current_revision_id, workChangeSequence: int(row.work_change_sequence ?? 0),
    title: row.title, taskKind: row.kind, taskState: row.state,
    phase, nextAction: conventionAction(row, phase, taskAction(phase)),
    responsible: conventionResponsible(row, phase, taskResponsibility(row, phase, timing)), assignment,
    acceptanceConvention: acceptanceConvention(row),
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
    timing,
    actionKey: `task:${row.task_id}:v${int(row.version)}:${phase}:${int(row.work_change_sequence ?? 0)}`,
  };
}

async function currentChangeSequence(db: Database, projectId: string): Promise<number> {
  const result = await db.query("SELECT COALESCE(MAX(sequence),0)::bigint AS sequence FROM leader_work_change WHERE project_id=$1", [projectId]);
  return int(result.rows[0]?.sequence ?? 0);
}

/** Fetch only the page's Task-owned source records; history stays in its original tables. */
async function readTimingEvents(db: Database, projectId: string, taskIds: string[]): Promise<Map<string, TimingEvent[]>> {
  const result = new Map<string, TimingEvent[]>();
  if (!taskIds.length) return result;
  const rows = await db.query(`
    SELECT timeline.task_id,timeline.event || jsonb_build_object('sequence',source_change.sequence,
      'taskVersion',source_revision.version,'reservationRunId',reservation.run_id) AS event FROM (
      SELECT r.task_id,jsonb_build_object('kind','task','id',r.revision_id,'at',r.created_at,
        'state',r.state,'version',r.version,'taskRevisionId',r.revision_id) AS event
        FROM task_revision r WHERE r.project_id=$1 AND r.task_id=ANY($2::uuid[])
      UNION ALL
      SELECT a.task_id,jsonb_build_object('kind','assignment','id',a.task_id::text||':v'||a.version,'at',a.updated_at,
        'state',a.state,'targetId',a.target_id,'version',a.version,'taskRevisionId',a.task_revision_id)
        FROM task_session_assignment_revision a
        WHERE a.project_id=$1 AND a.task_id=ANY($2::uuid[])
      UNION ALL
      SELECT a.task_id,jsonb_build_object('kind','ack','id',a.task_id::text||':v'||a.version,'at',a.ack_at,
        'state','accepted','targetId',a.target_id,'version',a.version,'taskRevisionId',a.task_revision_id)
        FROM task_session_assignment_revision a
        WHERE a.project_id=$1 AND a.task_id=ANY($2::uuid[]) AND a.ack_at IS NOT NULL
      UNION ALL
      SELECT r.task_id,jsonb_build_object('kind','run_reserved','id',r.run_id,'at',r.created_at,
        'targetId',r.session_id,'version',1,'taskRevisionId',r.task_revision_id) FROM runtime_run r
        WHERE r.project_id=$1 AND r.task_id=ANY($2::uuid[])
      UNION ALL
      SELECT r.task_id,jsonb_build_object('kind','run_bound','id',r.run_id,'at',e.created_at,
        'taskRevisionId',r.task_revision_id)
        FROM runtime_record_event e JOIN runtime_run r ON r.project_id=e.project_id AND r.run_id=e.run_id
        WHERE e.project_id=$1 AND r.task_id=ANY($2::uuid[]) AND e.kind='run.bound'
      UNION ALL
      SELECT r.task_id,jsonb_build_object('kind','run_terminal','id',r.run_id,'at',e.created_at,
        'state',CASE WHEN e.kind='run.unknown' THEN 'unknown'
          WHEN e.detail LIKE 'completed%' THEN 'completed'
          WHEN e.detail LIKE 'failed%' THEN 'failed' ELSE 'interrupted' END,
        'taskRevisionId',r.task_revision_id)
        FROM runtime_record_event e JOIN runtime_run r ON r.project_id=e.project_id AND r.run_id=e.run_id
        WHERE e.project_id=$1 AND r.task_id=ANY($2::uuid[]) AND
          (e.kind='run.unknown' OR e.kind='run.status' AND
            (e.detail LIKE 'completed%' OR e.detail LIKE 'failed%' OR e.detail LIKE 'interrupted%'))
      UNION ALL
      SELECT r.task_id,jsonb_build_object('kind','run_terminal','id',r.run_id,'at',r.updated_at,
        'state',r.state,'taskRevisionId',r.task_revision_id)
        FROM runtime_run r WHERE r.project_id=$1 AND r.task_id=ANY($2::uuid[])
          AND r.state IN ('completed','failed','interrupted','unknown')
          AND NOT EXISTS (SELECT 1 FROM runtime_record_event e WHERE e.project_id=r.project_id
            AND e.run_id=r.run_id AND e.kind IN ('run.status','run.unknown'))
      UNION ALL
      SELECT s.task_id,jsonb_build_object('kind','submission','id',s.submission_id,'at',s.created_at_utc,
        'state',s.state,'runId',s.run_id,'version',1,'taskRevisionId',s.task_revision_id)
        FROM ordinary_run_submission s
        WHERE s.project_id=$1 AND s.task_id=ANY($2::uuid[])
      UNION ALL
      SELECT d.task_id,jsonb_build_object('kind','delivery','id',d.delivery_id,'at',d.created_at,
        'state',d.technical_result,'runId',d.run_id,'taskRevisionId',d.task_revision_id) FROM delivery d
        WHERE d.project_id=$1 AND d.task_id=ANY($2::uuid[])
      UNION ALL
      SELECT o.task_id,jsonb_build_object('kind','observation','id',o.observation_id,'at',o.created_at,
        'state',o.result,'deliveryId',o.delivery_id,'taskRevisionId',d.task_revision_id)
        FROM consumer_observation o JOIN delivery d ON d.project_id=o.project_id AND d.delivery_id=o.delivery_id
        WHERE o.project_id=$1 AND o.task_id=ANY($2::uuid[])
      UNION ALL
      SELECT c.task_id,jsonb_build_object('kind','closure','id',c.closure_id,'at',c.created_at,
        'taskRevisionId',c.task_revision_id)
        FROM task_closure c WHERE c.project_id=$1 AND c.task_id=ANY($2::uuid[])
      UNION ALL
      SELECT f.task_id,jsonb_build_object('kind','publication_ready','id',f.release_handoff->>'artifactRef',
        'at',f.release_handoff->>'readyForPublicationAt','targetId',f.release_handoff->>'recipient',
        'taskRevisionId',f.task_revision_id)
        FROM task_attention_follow_up_revision f WHERE f.project_id=$1 AND f.task_id=ANY($2::uuid[])
          AND f.release_handoff IS NOT NULL
      UNION ALL
      SELECT f.task_id,jsonb_build_object('kind','publication_published','id',f.publication->>'publicationRef',
        'at',f.publication->>'publishedAt','taskRevisionId',f.task_revision_id)
        FROM task_attention_follow_up_revision f
        WHERE f.project_id=$1 AND f.task_id=ANY($2::uuid[]) AND f.publication IS NOT NULL
    ) timeline LEFT JOIN task_revision source_revision ON source_revision.project_id=$1
      AND source_revision.task_id=timeline.task_id
      AND source_revision.revision_id=(timeline.event->>'taskRevisionId')::uuid
    LEFT JOIN LATERAL (
      SELECT c.sequence FROM leader_work_change c WHERE c.project_id=$1 AND c.task_id=timeline.task_id
        AND c.entity_kind=CASE timeline.event->>'kind'
          WHEN 'task' THEN 'task' WHEN 'assignment' THEN 'assignment' WHEN 'ack' THEN 'assignment'
          WHEN 'run_reserved' THEN 'run' WHEN 'run_bound' THEN 'run'
          WHEN 'run_terminal' THEN 'run' WHEN 'submission' THEN 'submission'
          WHEN 'delivery' THEN 'delivery' WHEN 'observation' THEN 'observation'
          WHEN 'closure' THEN 'closure' END
        AND (CASE WHEN timeline.event->>'kind' IN ('task','assignment','ack') THEN
          c.version=(timeline.event->>'version')::integer ELSE c.entity_id::text=timeline.event->>'id' END)
      ORDER BY CASE WHEN timeline.event->>'kind'='run_terminal' THEN -c.sequence ELSE c.sequence END LIMIT 1
    ) source_change ON true
    LEFT JOIN LATERAL (
      SELECT r.run_id FROM outbox_event assignment_effect
      JOIN operation_journal operation ON operation.project_id=assignment_effect.project_id
        AND operation.operation_id=assignment_effect.operation_id
        AND operation.command_type IN ('runtime.run.reserve','queue.claim','queue.continue','queue.retryFailed')
        AND operation.result->>'status'='applied'
      JOIN outbox_event run_effect ON run_effect.project_id=assignment_effect.project_id
        AND run_effect.operation_id=assignment_effect.operation_id
        AND run_effect.kind='runtime.run.requested' AND run_effect.version=1
      JOIN runtime_run r ON r.project_id=run_effect.project_id AND r.run_id=run_effect.entity_id
        AND r.operation_id=assignment_effect.operation_id
      WHERE timeline.event->>'kind'='assignment' AND timeline.event->>'state'='assigned'
        AND assignment_effect.project_id=$1 AND assignment_effect.kind='task.assignment.set'
        AND assignment_effect.entity_id=timeline.task_id
        AND assignment_effect.version=(timeline.event->>'version')::integer
        AND r.task_id=timeline.task_id
        AND r.task_revision_id=(timeline.event->>'taskRevisionId')::uuid
        AND r.session_id=CASE WHEN timeline.event->>'kind'='assignment'
          THEN (timeline.event->>'targetId')::uuid ELSE NULL::uuid END
        AND (operation.command_type<>'runtime.run.reserve' OR
          operation.result->>'entityId'=r.run_id::text AND
          operation.result->>'revisionId'=r.task_revision_id::text)
      LIMIT 1
    ) reservation ON true
    ORDER BY timeline.task_id,(timeline.event->>'at')::timestamptz`, [projectId, taskIds]);
  for (const row of rows.rows) {
    const list = result.get(row.task_id) ?? [];
    list.push(row.event as TimingEvent);
    result.set(row.task_id, list);
  }
  return result;
}

async function withReadSnapshot<T>(db: Database, action: (snapshot: Database) => Promise<T>): Promise<T> {
  if (!(db instanceof pg.Pool)) return action(db);
  const client = await db.connect();
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

export async function readLeaderWorkTasks(db: Database, projectId: string, query: LeaderWorkQuery,
  observedAtOverride?: string): Promise<LeaderWorkPage<LeaderWorkTask>> {
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
        proposal.acceptance_target,proposal.acceptance_precondition,
        EXISTS(SELECT 1 FROM task_acceptance_precondition_mark pm WHERE pm.project_id=facts.project_id
          AND pm.delivery_id=facts.delivery_id) AS precondition_marked,
        stage.stage_id,stage.deliverable AS stage_deliverable,
        goal.goal_id,goal.outcome AS goal_outcome,
        COALESCE(dependencies.items,'[]'::jsonb) AS dependency_facts,
        CASE WHEN native_observation.session_id IS NULL THEN NULL ELSE
          native_observation.projection || jsonb_build_object('observedAt',native_observation.observed_at,
            'lastEventAt',native_observation.last_event_at,'freshness',native_observation.freshness)
        END AS native_observation,
        CASE WHEN follow_up.task_revision_id=facts.current_revision_id THEN
          follow_up.release_handoff->>'recipient' END AS publication_owner,
        follow_up.task_revision_id AS follow_up_task_revision_id,
        follow_up.waiting_on AS follow_up_waiting_on,
        follow_up.release_handoff AS current_release_handoff,
        follow_up.updated_at AS follow_up_updated_at,
        follow_up.version AS follow_up_version
      FROM facts
      LEFT JOIN LATERAL (SELECT p.consumer,p.use_required,p.stage_id,p.acceptance_target,p.acceptance_precondition FROM task_proposal p
        JOIN task_revision r ON r.project_id=p.project_id AND r.task_id=p.task_id
          AND r.revision_id=p.task_revision_id
        WHERE p.project_id=facts.project_id AND p.task_id=facts.task_id
        ORDER BY r.version DESC LIMIT 1) proposal ON true
      LEFT JOIN project_stage stage ON stage.project_id=facts.project_id AND stage.stage_id=proposal.stage_id
      LEFT JOIN project_goal goal ON goal.project_id=stage.project_id AND goal.goal_id=stage.goal_id
      LEFT JOIN session_native_observation native_observation ON
        native_observation.project_id=facts.project_id AND native_observation.session_id=facts.latest_run_session_id
      LEFT JOIN task_attention_follow_up follow_up ON follow_up.project_id=facts.project_id
        AND follow_up.task_id=facts.task_id
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
    const observedAt = observedAtOverride ?? new Date().toISOString();
    const events = await readTimingEvents(snapshot, projectId, pageResult.rows.map(row => row.task_id as string));
    const items = pageResult.rows.map(row => leaderWorkTaskFromRow({ ...row,
      timing_events: events.get(row.task_id) ?? [] }, observedAt));
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
  observedAt?: string,
): Promise<LeaderWorkTask | null> {
  const page = await readLeaderWorkTasks(db, projectId, {
    view: "tasks", limit: 1, includeClosed: true, taskId,
  }, observedAt);
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
