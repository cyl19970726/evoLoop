import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { CommandResult, Principal } from "@evoloop/contracts";
import type {
  LeaderWorkChange, LeaderWorkChangesPage, LeaderWorkDependenciesCommand, LeaderWorkDocument, LeaderWorkPage,
  LeaderWorkPhase, LeaderWorkPlanCommand, LeaderWorkTask,
} from "@evoloop/contracts/work-index";
import { leaderWorkDependenciesCommandSchema, leaderWorkPlanCommandSchema } from "@evoloop/contracts/work-index";
import { DomainError } from "@evoloop/contracts/ports";

type Database = Pick<Pool | PoolClient, "query">;
export type LeaderWorkView = "tasks" | "documents";
export interface LeaderWorkQuery {
  view: LeaderWorkView;
  limit: number;
  cursor?: string;
  includeClosed?: boolean;
}

const maxSnapshotRows = 5000;
const phaseOrder: Record<LeaderWorkPhase, number> = {
  unknown: 0, rework: 1, blocked: 2, awaiting_acceptance: 3, awaiting_delivery: 4,
  awaiting_assignment: 5, ready: 6, running: 7, unassigned: 8, closed: 9, cancelled: 10,
};

interface SnapshotCursor {
  version: 1; view: LeaderWorkView; projectId: string; includeClosed: boolean; sequence: number; offset: number;
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

function taskPhase(row: QueryResultRow): LeaderWorkPhase {
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
    currentRevisionId: row.current_revision_id, title: row.title, taskKind: row.kind, taskState: row.state,
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
    },
    dependencies: row.dependency_facts ?? [],
    dates: {
      createdAt: iso(row.created_at), businessChangedAt: iso(row.business_changed_at),
      startedAt: optionalIso(row.started_at), completedAt: optionalIso(row.completed_at), observedAt,
    },
    actionKey: `task:${row.task_id}:v${int(row.version)}:${phase}`,
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
  includeClosed: boolean, sequence: number): void {
  if (cursor && (cursor.projectId !== projectId || cursor.view !== view || cursor.includeClosed !== includeClosed ||
    cursor.sequence !== sequence))
    throw new DomainError("WORK_INDEX_CHANGED", "待处理工作已变化；请从第一页重新核对，不能把旧页当成完整快照");
}

async function taskRows(db: Database, projectId: string, includeClosed: boolean): Promise<QueryResultRow[]> {
  const result = await db.query(`SELECT t.task_id,t.version,t.current_revision_id,t.title,t.kind,t.owner,t.state,
      tr.created_at AS business_changed_at,
      first_revision.first_at AS created_at,
      first_run.started_at,
      closure.closed_at AS completed_at,
      assignment.state AS assignment_state,assignment.target_kind AS assignment_target_kind,
      assignment.target_id AS assignment_target_id,assignment.recipient_actor_id AS assignment_recipient_actor_id,
      run.run_id AS latest_run_id,run.state AS latest_run_state,run.updated_at AS run_updated_at,
      delivery.delivery_id,delivery.task_revision_id AS delivery_task_revision_id,
      delivery.technical_result AS delivery_result,delivery.created_at AS delivery_created_at,
      observation.result AS observation_result,observation.observer AS observation_actor_id,
      observation.observer_kind AS observation_kind,observation.created_at AS observation_created_at,
      proposal.consumer,proposal.use_required,
      impact.pending_impact_count,queue_entry.hold_code AS queue_hold,
      stage.stage_id,stage.deliverable AS stage_deliverable,
      goal.goal_id,goal.outcome AS goal_outcome,
      plan.version AS plan_version,plan.planned_start_at,plan.due_at,plan.priority,
      COALESCE(dependencies.items,'[]'::jsonb) AS dependency_facts,
      closure.closure_id IS NOT NULL AS has_closure
    FROM task t
    JOIN task_revision tr ON tr.project_id=t.project_id AND tr.task_id=t.task_id AND tr.revision_id=t.current_revision_id
    LEFT JOIN LATERAL (SELECT min(r.created_at) AS first_at FROM task_revision r
      WHERE r.project_id=t.project_id AND r.task_id=t.task_id) first_revision ON true
    LEFT JOIN LATERAL (SELECT min(e.created_at) AS started_at FROM runtime_record_event e
      JOIN runtime_run r ON r.project_id=e.project_id AND r.run_id=e.run_id
      WHERE e.project_id=t.project_id AND r.task_id=t.task_id AND e.kind='run.bound') first_run ON true
    LEFT JOIN LATERAL (SELECT c.closure_id,c.created_at AS closed_at FROM task_closure c
      WHERE c.project_id=t.project_id AND c.task_id=t.task_id ORDER BY c.created_at DESC,c.closure_id DESC LIMIT 1) closure ON true
    LEFT JOIN LATERAL (SELECT a.state,a.target_kind,a.target_id,a.recipient_actor_id FROM task_session_assignment a
      WHERE a.project_id=t.project_id AND a.task_id=t.task_id ORDER BY a.version DESC LIMIT 1) assignment ON true
    LEFT JOIN LATERAL (SELECT r.run_id,r.state,r.updated_at FROM runtime_run r
      WHERE r.project_id=t.project_id AND r.task_id=t.task_id
        AND r.state IN ('requested','dispatching','running','unknown','completed','failed','interrupted')
      ORDER BY r.updated_at DESC,r.run_id DESC LIMIT 1) run ON true
    LEFT JOIN LATERAL (SELECT d.delivery_id,d.task_revision_id,d.technical_result,d.created_at FROM delivery d
      WHERE d.project_id=t.project_id AND d.task_id=t.task_id AND d.task_revision_id=t.current_revision_id
      ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT 1) delivery ON true
    LEFT JOIN LATERAL (SELECT o.result,o.observer,o.observer_kind,o.created_at FROM consumer_observation o
      WHERE o.project_id=t.project_id AND o.delivery_id=delivery.delivery_id
      ORDER BY o.sequence DESC LIMIT 1) observation ON true
    LEFT JOIN LATERAL (SELECT p.consumer,p.use_required FROM task_proposal p
      JOIN task_revision r ON r.project_id=p.project_id AND r.task_id=p.task_id AND r.revision_id=p.task_revision_id
      WHERE p.project_id=t.project_id AND p.task_id=t.task_id
      ORDER BY r.version DESC LIMIT 1) proposal ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS pending_impact_count FROM impact_review i
      WHERE i.project_id=t.project_id AND i.task_id=t.task_id AND i.state='pending') impact ON true
    LEFT JOIN LATERAL (SELECT e.hold_code FROM resident_queue_entry e
      WHERE e.project_id=t.project_id AND e.task_id=t.task_id AND e.hold_code IS NOT NULL
      ORDER BY e.position,e.entry_id LIMIT 1) queue_entry ON true
    LEFT JOIN LATERAL (SELECT p.stage_id FROM task_proposal p
      JOIN task_revision r ON r.project_id=p.project_id AND r.task_id=p.task_id AND r.revision_id=p.task_revision_id
      WHERE p.project_id=t.project_id AND p.task_id=t.task_id ORDER BY r.version DESC LIMIT 1) proposal_stage ON true
    LEFT JOIN project_stage stage ON stage.project_id=t.project_id AND stage.stage_id=proposal_stage.stage_id
    LEFT JOIN project_goal goal ON goal.project_id=stage.project_id AND goal.goal_id=stage.goal_id
    LEFT JOIN task_work_plan plan ON plan.project_id=t.project_id AND plan.task_id=t.task_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('taskId',d.depends_on_task_id,'title',dt.title,'state',dt.state,
        'currentRevisionId',dt.current_revision_id,
        'acceptanceSatisfied',EXISTS(SELECT 1 FROM task_closure c
          WHERE c.project_id=d.project_id AND c.task_id=d.depends_on_task_id
            AND c.task_revision_id=dt.current_revision_id)
          OR EXISTS(SELECT 1 FROM resident_queue_claim q
            JOIN resident_queue_attempt a ON a.project_id=q.project_id AND a.claim_id=q.claim_id
            WHERE q.project_id=d.project_id AND q.task_id=d.depends_on_task_id AND q.release_kind='accepted'
              AND a.task_revision_id=dt.current_revision_id))
        ORDER BY dt.title,d.depends_on_task_id) AS items
      FROM task_dependency d JOIN task dt ON dt.project_id=d.project_id AND dt.task_id=d.depends_on_task_id
      WHERE d.project_id=t.project_id AND d.task_id=t.task_id) dependencies ON true
    WHERE t.project_id=$1 ${includeClosed ? "" : "AND t.state NOT IN ('done','cancelled')"}
    ORDER BY t.task_id LIMIT $2`, [projectId, maxSnapshotRows + 1]);
  return result.rows;
}

export async function readLeaderWorkTasks(db: Database, projectId: string, query: LeaderWorkQuery): Promise<LeaderWorkPage<LeaderWorkTask>> {
  return withReadSnapshot(db, async snapshot => {
    const sequence = await currentChangeSequence(snapshot, projectId);
    const cursor = decodeCursor(query.cursor, "tasks") as SnapshotCursor | null;
    assertSnapshot(cursor, "tasks", projectId, query.includeClosed === true, sequence);
    const rows = await taskRows(snapshot, projectId, query.includeClosed === true);
    const observedAt = new Date().toISOString();
    const items = rows.slice(0, maxSnapshotRows).map(row => leaderWorkTaskFromRow(row, observedAt))
      .sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase] ||
        (a.plan?.dueAt ? Date.parse(a.plan.dueAt) : Number.MAX_SAFE_INTEGER) -
        (b.plan?.dueAt ? Date.parse(b.plan.dueAt) : Number.MAX_SAFE_INTEGER) ||
        (a.plan?.priority ?? 99) - (b.plan?.priority ?? 99) ||
        a.title.localeCompare(b.title, "zh-CN") || a.taskId.localeCompare(b.taskId));
    const offset = cursor?.offset ?? 0;
    if (offset > items.length) throw new DomainError("INVALID_CURSOR", "待处理工作分页位置超出当前快照");
    const page = items.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;
    const counts = Object.fromEntries(Object.keys(phaseOrder).map(phase =>
      [phase, items.filter(item => item.phase === phase).length]));
    return {
      items: page, total: items.length, counts, changeSequence: sequence, observedAt, partial: rows.length > maxSnapshotRows,
      nextCursor: nextOffset < items.length ? encodeCursor({ version: 1, view: "tasks", projectId,
        includeClosed: query.includeClosed === true, sequence, offset: nextOffset }) : null,
    };
  });
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

async function documentRows(db: Database, projectId: string, includeClosed: boolean): Promise<DocumentRow[]> {
  const result = await db.query(`SELECT d.document_id,d.version,d.title,d.kind,d.status,d.current_revision_id,d.adopted_revision_id,
      current.created_at AS current_at,first_revision.created_at,
      adopted.created_at AS adopted_at,
      changed.changed_at,
      COALESCE(refs.items,'[]'::jsonb) AS refs
    FROM process_document d
    JOIN document_revision current ON current.project_id=d.project_id AND current.document_id=d.document_id
      AND current.revision_id=d.current_revision_id
    JOIN LATERAL (SELECT min(r.created_at) AS created_at FROM document_revision r
      WHERE r.project_id=d.project_id AND r.document_id=d.document_id) first_revision ON true
    LEFT JOIN LATERAL (SELECT dd.created_at FROM document_decision dd
      WHERE dd.project_id=d.project_id AND dd.document_id=d.document_id
        AND dd.revision_id=d.adopted_revision_id ORDER BY dd.created_at DESC,dd.decision_id DESC LIMIT 1) adopted ON true
    LEFT JOIN LATERAL (SELECT max(c.changed_at) AS changed_at FROM leader_work_change c
      WHERE c.project_id=d.project_id AND c.document_id=d.document_id) changed ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('taskId',x.task_id,'title',x.title,'state',x.state,
        'relations',x.relations) ORDER BY x.title,x.task_id) AS items
      FROM (
        SELECT t.task_id,t.title,t.state,array_agg(DISTINCT relation ORDER BY relation) AS relations
        FROM (
          SELECT t.task_id,'content'::text AS relation FROM task t
            WHERE t.project_id=d.project_id AND t.content_document_id=d.document_id
          UNION ALL
          SELECT t.task_id,'link'::text AS relation FROM task_document_link l
            JOIN task t ON t.project_id=l.project_id AND t.task_id=l.task_id
            WHERE l.project_id=d.project_id AND l.document_id=d.document_id
          UNION ALL
          SELECT t.task_id,'basis'::text AS relation FROM task t
            JOIN task_revision tr ON tr.project_id=t.project_id AND tr.task_id=t.task_id AND tr.revision_id=t.current_revision_id
            JOIN basis_member bm ON bm.project_id=tr.project_id AND bm.task_id=tr.task_id
              AND bm.task_revision_id=tr.revision_id AND bm.basis_set_id=tr.basis_set_id
            WHERE t.project_id=d.project_id AND bm.document_id=d.document_id
        ) relations
        JOIN task t ON t.project_id=d.project_id AND t.task_id=relations.task_id
        GROUP BY t.task_id,t.title,t.state
      ) x
    ) refs ON true
    WHERE d.project_id=$1 ${includeClosed ? "" : "AND d.status<>'archived'"}
    ORDER BY d.document_id LIMIT $2`, [projectId, maxSnapshotRows + 1]);
  return result.rows.map(row => ({ ...row, references: row.refs })) as DocumentRow[];
}

export async function readLeaderWorkDocuments(db: Database, projectId: string, query: LeaderWorkQuery): Promise<LeaderWorkPage<LeaderWorkDocument>> {
  return withReadSnapshot(db, async snapshot => {
    const sequence = await currentChangeSequence(snapshot, projectId);
    const cursor = decodeCursor(query.cursor, "documents") as SnapshotCursor | null;
    assertSnapshot(cursor, "documents", projectId, query.includeClosed === true, sequence);
    const rows = await documentRows(snapshot, projectId, query.includeClosed === true);
    const observedAt = new Date().toISOString();
    const items = rows.slice(0, maxSnapshotRows).map(row => leaderWorkDocumentFromRow(row, observedAt))
      .sort((a, b) => a.status.localeCompare(b.status) || a.title.localeCompare(b.title, "zh-CN") ||
        a.documentId.localeCompare(b.documentId));
    const offset = cursor?.offset ?? 0;
    if (offset > items.length) throw new DomainError("INVALID_CURSOR", "文档分页位置超出当前快照");
    const page = items.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;
    const counts = Object.fromEntries(["draft", "published", "archived"].map(status =>
      [status, items.filter(item => item.status === status).length]));
    return {
      items: page, total: items.length, counts, changeSequence: sequence, observedAt, partial: rows.length > maxSnapshotRows,
      nextCursor: nextOffset < items.length ? encodeCursor({ version: 1, view: "documents", projectId,
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

  private async perform(projectId: string, principal: Principal,
    command: LeaderWorkPlanCommand | LeaderWorkDependenciesCommand, commandType: string,
    action: (client: PoolClient) => Promise<Extract<CommandResult, { status: "applied" }>>): Promise<CommandResult> {
    const client = await this.pool.connect();
    const hash = commandHash({ ...command, actorId: principal.actorId, projectId });
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`leader-work:${projectId}`]);
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
