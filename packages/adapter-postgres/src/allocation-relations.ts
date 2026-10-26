import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { AllocationRelationQuery, AllocationRelationsReader, AllocationTrace, AllocationTracePage, AllocationTaskAcceptanceGap } from "@evoloop/contracts/allocation-relations";
import type { ObservationSource } from "@evoloop/contracts/session-work";
import { DomainError } from "@evoloop/contracts/ports";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionKey = /^(owned|external):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const bytes = 256 * 1024 - 512;
const iso = (value: Date | string): string => new Date(value).toISOString();
// Opaque cursors are valid only within this server process; restart requires a fresh first page.
const cursorKey = randomBytes(32);
const encode = (value: unknown): string => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const mac = createHmac("sha256", cursorKey).update(payload).digest("base64url");
  return `${payload}.${mac}`;
};
const decode = (value: string): unknown => {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new DomainError("INVALID_CURSOR", "Invalid relation cursor");
  const expected = createHmac("sha256", cursorKey).update(parts[0]).digest();
  let actual: Buffer;
  try { actual = Buffer.from(parts[1], "base64url"); } catch { throw new DomainError("INVALID_CURSOR", "Invalid relation cursor"); }
  if (actual.length !== expected.length || actual.toString("base64url") !== parts[1] || !timingSafeEqual(actual, expected))
    throw new DomainError("INVALID_CURSOR", "Invalid relation cursor signature");
  try { return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { throw new DomainError("INVALID_CURSOR", "Invalid relation cursor"); }
};
const href = (project: string, kind: string, id: string): string => `#/p/${project}/${kind}/${id}`;
const source = (kind: ObservationSource["kind"], id: string, revision: string | null, link: string): ObservationSource =>
  ({ kind, id, revision, evidence: "project-record", href: link });
const keyOf = (r: QueryResultRow): string => r.path_kind === "recipient"
  ? `r:${r.action_event_id}:${String(r.assignment_version).padStart(12, "0")}` : `a:${r.action_event_id}`;

type Filter = { kind: "role" | "discussion" | "session"; value: string; canonical: string | null; aliases: string[]; targetKind: string | null };

export class PgAllocationRelations implements AllocationRelationsReader {
  private readonly scoped: string;
  constructor(private readonly client: PoolClient, private readonly projectId: string, scope: string) {
    this.scoped = createHash("sha256").update(`${projectId}\0${scope}`).digest("hex");
  }
  private async filter(query: AllocationRelationQuery): Promise<Filter> {
    const present = [query.roleId, query.discussionId, query.sessionKey].filter(v => v !== undefined);
    if (present.length !== 1) throw new DomainError("INVALID_FILTER", "Exactly one relation filter is required");
    if (query.roleId !== undefined || query.discussionId !== undefined) {
      const kind = query.roleId !== undefined ? "role" : "discussion";
      const value = (query.roleId ?? query.discussionId)!;
      if (!uuid.test(value)) throw new DomainError("INVALID_FILTER", "Invalid relation identifier");
      const table = kind === "role" ? "role_definition" : "discussion";
      const col = kind === "role" ? "role_id" : "discussion_id";
      const row = await this.client.query(`SELECT 1 FROM ${table} WHERE project_id=$1 AND ${col}=$2${kind === "discussion" ? " AND kind='allocation'" : ""}`, [this.projectId, value]);
      if (!row.rowCount) throw new DomainError("NOT_FOUND", "Relation target not found");
      return { kind, value: value.toLowerCase(), canonical: null, aliases: [], targetKind: null };
    }
    const match = sessionKey.exec(query.sessionKey!);
    if (!match) throw new DomainError("INVALID_FILTER", "Invalid Session key");
    const targetKind = match[1]!.toLowerCase(), value = match[2]!.toLowerCase();
    if (targetKind === "owned") {
      const row = await this.client.query("SELECT 1 FROM runtime_session WHERE project_id=$1 AND session_id=$2", [this.projectId, value]);
      if (!row.rowCount) throw new DomainError("NOT_FOUND", "Session not found");
      return { kind: "session", value, canonical: `owned:${value}`, aliases: [value], targetKind };
    }
    // Use all current aliases, not the presentation catalog's bounded 20 aliases.
    const rows = await this.client.query(`WITH hosts AS (
      SELECT h.link_id, v.host, f.created_at_utc,
        CASE WHEN v.host->>'kind'='external' AND v.host->>'provider'='codex-desktop' THEN
          CASE WHEN v.host->>'ref' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN lower(v.host->>'ref')
          WHEN v.host->>'ref' ~ '^codex://threads/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN lower(substring(v.host->>'ref' from 17)) END END AS normalized
      FROM role_host_link h JOIN role_host_link_revision v ON v.project_id=h.project_id AND v.link_id=h.link_id AND v.version=h.version
      JOIN role_host_link_revision f ON f.project_id=h.project_id AND f.link_id=h.link_id AND f.version=1
      WHERE h.project_id=$1 AND v.host->>'kind'='external'
    ), selected AS (SELECT * FROM hosts WHERE link_id=$2)
    SELECT h.link_id FROM hosts h CROSS JOIN selected s
    WHERE h.host->>'provider'=s.host->>'provider'
      AND ((s.normalized IS NOT NULL AND h.normalized=s.normalized) OR (s.normalized IS NULL AND h.link_id=s.link_id))
    ORDER BY h.created_at_utc,h.link_id`, [this.projectId, value]);
    if (!rows.rowCount) throw new DomainError("NOT_FOUND", "Session not found");
    const aliases = rows.rows.map(r => r.link_id as string);
    return { kind: "session", value, canonical: `external:${aliases[0]}`, aliases, targetKind };
  }
  async list(query: AllocationRelationQuery): Promise<AllocationTracePage> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50) throw new DomainError("INVALID_PAGE", "Limit must be 1..50");
    if (query.cursor !== undefined && (query.cursor.length === 0 || query.cursor.length > 4096))
      throw new DomainError("INVALID_CURSOR", "Invalid relation cursor length");
    const filter = await this.filter(query);
    const identity = `${filter.kind}:${filter.canonical ?? filter.value}`;
    const head = await this.client.query("SELECT sequence FROM session_observation_head WHERE project_id=$1", [this.projectId]);
    const generation = String(head.rows[0]?.sequence ?? "0");
    let after = "";
    if (query.cursor) {
      const parsed = decode(query.cursor) as Record<string, unknown>;
      if (!parsed || parsed.v !== 1 || parsed.scope !== this.scoped || parsed.filter !== identity ||
          typeof parsed.generation !== "string" || typeof parsed.after !== "string" ||
          !/^(?:a:[0-9a-f-]{36}|r:[0-9a-f-]{36}:[0-9]{12})$/.test(parsed.after))
        throw new DomainError("INVALID_CURSOR", "Relation cursor does not match this read");
      if (parsed.generation !== generation) return this.page([], null, true, filter.canonical, false, []);
      after = parsed.after;
    }
    const rows = await this.client.query(`WITH actions AS (
      SELECT d.discussion_id,d.version AS discussion_version,d.status,d.document_id,d.current_document_revision_id,
        d.latest_decision_event_id,pd.title,e.event_id AS action_event_id,e.decision_event_id,
        e.target_kind,e.target_id,e.target_version,e.target_revision_id,e.created_at AS action_at,
        de.document_revision_id AS decision_document_revision_id,tr.owner AS fixed_owner,
        CASE WHEN e.target_kind='task' THEN CASE
          WHEN t.task_id IS NULL OR tr.revision_id IS NULL THEN 'unavailable'
          WHEN EXISTS(SELECT 1 FROM task_session_assignment_revision ar WHERE ar.project_id=e.project_id
            AND ar.task_id=e.target_id AND ar.task_revision_id=e.target_revision_id AND ar.state='accepted') THEN NULL
          WHEN EXISTS(SELECT 1 FROM task_session_assignment_revision ar WHERE ar.project_id=e.project_id
            AND ar.task_id=e.target_id AND ar.task_revision_id=e.target_revision_id) THEN 'not-accepted'
          WHEN EXISTS(SELECT 1 FROM task_session_assignment_revision ar WHERE ar.project_id=e.project_id
            AND ar.task_id=e.target_id) THEN 'different-task-revision'
          ELSE 'no-assignment' END END AS task_acceptance_gap,
        CASE e.target_kind
          WHEN 'task' THEN CASE WHEN t.task_id IS NULL OR tr.revision_id IS NULL THEN 'unavailable' WHEN t.current_revision_id=e.target_revision_id THEN 'current' ELSE 'changed' END
          WHEN 'role' THEN CASE WHEN rd.role_id IS NULL OR rr.revision_id IS NULL THEN 'unavailable' WHEN rd.current_revision_id=e.target_revision_id THEN 'current' ELSE 'changed' END
          WHEN 'document' THEN CASE WHEN td.document_id IS NULL OR dr.revision_id IS NULL THEN 'unavailable' WHEN td.current_revision_id=e.target_revision_id THEN 'current' ELSE 'changed' END
          WHEN 'stage' THEN CASE WHEN st.stage_id IS NULL OR sr.revision_id IS NULL THEN 'unavailable' WHEN st.version=e.target_version THEN 'current' ELSE 'changed' END END AS target_status
      FROM discussion d JOIN discussion_event e ON e.project_id=d.project_id AND e.discussion_id=d.discussion_id AND e.kind='action'
      JOIN discussion_event de ON de.project_id=e.project_id AND de.event_id=e.decision_event_id AND de.kind='decision'
      JOIN process_document pd ON pd.project_id=d.project_id AND pd.document_id=d.document_id
      LEFT JOIN task_revision tr ON tr.project_id=e.project_id AND e.target_kind='task' AND tr.task_id=e.target_id AND tr.revision_id=e.target_revision_id
      LEFT JOIN task t ON t.project_id=e.project_id AND e.target_kind='task' AND t.task_id=e.target_id
      LEFT JOIN role_definition rd ON rd.project_id=e.project_id AND e.target_kind='role' AND rd.role_id=e.target_id
      LEFT JOIN role_revision rr ON rr.project_id=e.project_id AND e.target_kind='role' AND rr.role_id=e.target_id AND rr.revision_id=e.target_revision_id
      LEFT JOIN process_document td ON td.project_id=e.project_id AND e.target_kind='document' AND td.document_id=e.target_id
      LEFT JOIN document_revision dr ON dr.project_id=e.project_id AND e.target_kind='document' AND dr.document_id=e.target_id AND dr.revision_id=e.target_revision_id
      LEFT JOIN project_stage st ON st.project_id=e.project_id AND e.target_kind='stage' AND st.stage_id=e.target_id
      LEFT JOIN stage_revision sr ON sr.project_id=e.project_id AND e.target_kind='stage' AND sr.stage_id=e.target_id AND sr.version=e.target_version
      WHERE d.project_id=$1 AND d.kind='allocation'
        AND ($2::text<>'discussion' OR d.discussion_id=$3::uuid)
        AND ($2::text<>'role' OR (
          EXISTS(SELECT 1 FROM discussion_event re WHERE re.project_id=d.project_id AND re.discussion_id=d.discussion_id
            AND re.kind='action' AND re.target_kind='role' AND re.target_id=$3::uuid)
          AND ((e.target_kind='role' AND e.target_id=$3::uuid) OR (e.target_kind='task' AND tr.owner=$3::text))))
        AND ($2::text<>'session' OR e.target_kind='task')
    ), paths AS (
      SELECT a.*, 'decision'::text AS path_kind,NULL::integer AS assignment_version,NULL::text AS assignment_target_kind,
        NULL::uuid AS assignment_target_id,NULL::timestamptz AS ack_at,NULL::text AS ack_method,
        NULL::text AS ack_actor_id,NULL::text AS ack_observer_actor_id,NULL::integer AS head_version,NULL::text AS head_state
      FROM actions a WHERE $2::text<>'session'
      UNION ALL
      SELECT a.*, 'recipient',ar.version,ar.target_kind,ar.target_id,ar.ack_at,ar.ack_method,
        ar.ack_actor_id,ar.ack_observer_actor_id,ah.version,ah.state
      FROM actions a JOIN task_session_assignment_revision ar ON ar.project_id=$1 AND a.target_kind='task'
        AND ar.task_id=a.target_id AND ar.task_revision_id=a.target_revision_id AND ar.state='accepted'
      LEFT JOIN task_session_assignment ah ON ah.project_id=ar.project_id AND ah.task_id=ar.task_id
      WHERE ($2::text<>'session' OR (ar.target_kind=$4::text AND ar.target_id=ANY($5::uuid[])))
    ), keyed AS (SELECT p.*, CASE WHEN path_kind='recipient' THEN 'r:'||action_event_id::text||':'||lpad(assignment_version::text,12,'0')
      ELSE 'a:'||action_event_id::text END AS path_id FROM paths p)
    SELECT * FROM keyed WHERE path_id>$6 ORDER BY path_id LIMIT $7`,
    [this.projectId, filter.kind, filter.kind === "session" ? null : filter.value,
      filter.targetKind, filter.aliases, after, query.limit + 1]);
    const all = rows.rows;
    const selected = all.slice(0, query.limit);
    const items: AllocationTrace[] = [];
    const limitations: string[] = [];
    let observedAt: string | null = null;
    let next: string | null = null;
    const cursorFor = (id: string) => encode({ v: 1, scope: this.scoped, filter: identity, generation, after: id });
    for (const row of selected) {
      const item = this.trace(row);
      if ((item.relation.kind === "decision-target" ? item.relation.targetStatus : item.relation.taskRevisionStatus) === "unavailable" && !limitations.includes("Fixed target revision unavailable"))
        limitations.push("Fixed target revision unavailable");
      if (!item.decisionDocumentRevisionId && !limitations.includes("Fixed decision document revision unavailable"))
        limitations.push("Fixed decision document revision unavailable");
      const more = all.length > items.length + 1;
      const candidate = this.page([...items, item], more ? cursorFor(item.id) : null, false, filter.canonical, limitations.length > 0, limitations);
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > bytes) {
        if (!items.length) throw new DomainError("RESULT_TOO_LARGE", "One relation exceeds response byte limit");
        limitations.push("Page truncated to response byte limit");
        next = cursorFor(items[items.length - 1]!.id);
        break;
      }
      items.push(item);
      const rowAt = iso(row.ack_at && new Date(row.ack_at).getTime() > new Date(row.action_at).getTime() ? row.ack_at : row.action_at);
      if (!observedAt || rowAt > observedAt) observedAt = rowAt;
    }
    if (next === null && all.length > query.limit && items.length) next = cursorFor(items[items.length - 1]!.id);
    return this.page(items, next, false, filter.canonical, limitations.length > 0, limitations, observedAt);
  }
  private page(items: AllocationTrace[], nextCursor: string | null, resetRequired: boolean, canonicalSessionKey: string | null,
    partial: boolean, limitations: string[], observedAt: string | null = null): AllocationTracePage {
    return { items, nextCursor, resetRequired, canonicalSessionKey,
      metadata: { generatedAt: new Date().toISOString(), sourceObservedAt: observedAt, partial, limitations } };
  }
  private trace(r: QueryResultRow): AllocationTrace {
    const target = r.target_kind === "stage" ? { kind: "stage" as const, id: r.target_id, version: r.target_version }
      : { kind: r.target_kind as "role" | "task" | "document", id: r.target_id, revisionId: r.target_revision_id };
    const action = source("discussion", r.discussion_id, r.action_event_id,
      href(this.projectId, "discussions", r.discussion_id));
    const fixed = r.target_kind === "task" ? source("task", r.target_id, r.target_revision_id,
      href(this.projectId, "tasks", r.target_id))
      : r.target_kind === "role" ? source("role", r.target_id, r.target_revision_id,
        `#/p/${this.projectId}/roles?role=${r.target_id}`)
      : r.target_kind === "document" ? source("document", r.target_id, r.target_revision_id,
        `#/p/${this.projectId}/documents/${r.target_id}?revision=${r.target_revision_id}`)
      : r.target_kind === "stage" ? source("stage", r.target_id, String(r.target_version),
        `#/p/${this.projectId}/journey`) : null;
    const assignment = r.path_kind === "recipient" ? source("task-assignment", r.target_id, String(r.assignment_version),
      href(this.projectId, "tasks", r.target_id)) : null;
    const relation = r.path_kind === "recipient" ? {
      kind: "task-recipient" as const, taskActionEventId: r.action_event_id,
      task: { id: r.target_id, revisionId: r.target_revision_id },
      assignment: { version: r.assignment_version,
        target: r.assignment_target_kind === "owned" ? { kind: "owned" as const, sessionId: r.assignment_target_id }
          : { kind: "external" as const, linkId: r.assignment_target_id },
        acceptedAt: iso(r.ack_at), method: r.ack_method, actorId: r.ack_actor_id, observerActorId: r.ack_observer_actor_id },
      taskRevisionStatus: r.target_status,
      assignmentStatus: r.head_version == null ? "unknown" as const
        : r.head_version === r.assignment_version && r.head_state === "accepted" ? "current" as const : "historical" as const,
    } : { kind: "decision-target" as const, actionEventId: r.action_event_id, target, targetStatus: r.target_status,
      ...(r.target_kind === 'task' ? { taskAcceptanceGap: r.task_acceptance_gap as AllocationTaskAcceptanceGap | null } : {}) };
    return { id: keyOf(r), discussion: { id: r.discussion_id, version: r.discussion_version, status: r.status,
      title: String(r.title).slice(0, 240), document: { id: r.document_id, revisionId: r.current_document_revision_id },
      latestDecisionEventId: r.latest_decision_event_id },
      decisionEventId: r.decision_event_id, decisionDocumentRevisionId: r.decision_document_revision_id,
      relation, decisionIsLatest: r.decision_event_id === r.latest_decision_event_id,
      sources: [action, ...(fixed ? [fixed] : []), ...(assignment ? [assignment] : [])] };
  }
}
