import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import type { ObservationMetadata, ObservationSource, SessionTarget } from "@evoloop/contracts/session-work";
import type { SessionProfileRecord } from "@evoloop/contracts/session-assignments";
import type { ObservedRole, ObservedSession, ObservedTask, SessionActivity, SessionActivityPage, SessionChanges,
  SessionDirectory, SessionObservationReader, SessionSnapshot, ObservedResource } from "@evoloop/contracts/session-observation";
import { PgSessionAssignments } from "./session-assignments.js";

type Row = QueryResultRow;
const iso = (v: Date | string | null | undefined): string | null => v ? new Date(v).toISOString() : null;
const clip = (v: unknown, n = 600): string => typeof v === "string" ? v.slice(0, n) : "";
const byteLimit = 256 * 1024;
const active = ["requested", "dispatching", "running", "unknown"];
const validKey = /^(owned|external):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (target: SessionTarget) => target.kind === "owned" ? target.sessionId : target.linkId;
const selectedProfile = (row: Row): SessionProfileRecord | null => {
  const p = row.profile as Row | null;
  if (!p) return null;
  return { projectId: p.project_id, target: p.target_kind === "owned" ? { kind: "owned", sessionId: p.target_id } : { kind: "external", linkId: p.target_id },
    version: p.version, displayName: p.display_name, purpose: p.purpose, membership: p.membership, tenure: p.tenure,
    actorId: p.actor_id, reason: p.reason, updatedAt: iso(p.updated_at)! };
};
interface PreparedSessions { runs: Map<string, Row>; work: Map<string, Row>; busy: Set<string> }

/** Only current project identities are combined; the CTE never reads native history. */
const catalog = `WITH hosts AS (
  SELECT h.link_id,h.role_id,h.state,v.host,v.verified_capabilities,v.observed_at_utc,v.version,
    first.created_at_utc AS registered_at,
    CASE WHEN v.host->>'kind'='external' AND v.host->>'ref' ~
      '^codex://threads/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN substring(v.host->>'ref' from 17) END AS external_ref
  FROM role_host_link h JOIN role_host_link_revision v ON v.project_id=h.project_id AND v.link_id=h.link_id AND v.version=h.version
  JOIN role_host_link_revision first ON first.project_id=h.project_id AND first.link_id=h.link_id AND first.version=1
  WHERE h.project_id=$1
), grouped_hosts AS (
  SELECT host->>'provider' AS provider,external_ref,
    (array_agg(link_id ORDER BY registered_at,link_id))[1] AS identity,
    (array_agg(link_id ORDER BY registered_at,link_id))[1:20] AS aliases,
    (array_agg(DISTINCT role_id::text))[1:10] AS role_ids,
    bool_or(state='verified') AS verified,bool_and(state='revoked') AS revoked,
    bool_or(state='verified' AND verified_capabilities ? 'open') AS can_open,
    max(observed_at_utc) AS observed_at, count(*) AS alias_count
  FROM hosts WHERE host->>'kind'='external' GROUP BY host->>'provider',external_ref
), identities AS (
  SELECT 'owned:'||s.session_id::text AS key,'owned'::text AS kind,s.session_id AS identity,
    ARRAY[s.session_id]::uuid[] AS aliases,ARRAY[s.role_id]::text[] AS role_ids,to_jsonb(s) AS runtime,
    EXISTS(SELECT 1 FROM hosts h WHERE h.host->>'kind'='owned' AND h.host->>'sessionId'=s.session_id::text AND h.state='verified') AS verified,
    EXISTS(SELECT 1 FROM hosts h WHERE h.host->>'kind'='owned' AND h.host->>'sessionId'=s.session_id::text
      AND h.state='verified' AND h.verified_capabilities ? 'open') AS can_open,
    s.state='closed' AS historical,s.updated_at AS observed_at,
    CASE WHEN s.native_thread_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN s.native_thread_id END AS external_ref,1::bigint AS alias_count
  FROM runtime_session s WHERE s.project_id=$1
  UNION ALL
  SELECT 'external:'||h.identity::text,'external',h.identity,h.aliases,h.role_ids,NULL::jsonb,h.verified,h.can_open,h.revoked,h.observed_at,
    h.external_ref,h.alias_count FROM grouped_hosts h
), described AS (
  SELECT i.*,to_jsonb(p) AS profile,
    CASE WHEN p.membership IS NOT NULL THEN p.membership WHEN i.historical THEN 'historical'
      WHEN i.verified THEN 'current' ELSE 'unclassified' END AS membership,
    COALESCE(p.display_name,CASE WHEN i.kind='owned' THEN COALESCE(r.proposal->>'title',i.runtime->>'role_id')
      ELSE COALESCE(r.proposal->>'title','外部会话')||' · 外部 '||left(i.identity::text,8) END) AS title
  FROM identities i
  LEFT JOIN LATERAL (SELECT sp.* FROM session_profile sp WHERE sp.project_id=$1 AND sp.target_kind=i.kind
    AND sp.target_id=ANY(i.aliases) ORDER BY (sp.target_id=i.identity) DESC,sp.updated_at DESC,sp.target_id LIMIT 1) p ON true
  LEFT JOIN role_definition rd ON rd.project_id=$1 AND rd.role_id::text=i.role_ids[1]
  LEFT JOIN role_revision r ON r.project_id=rd.project_id AND r.role_id=rd.role_id AND r.revision_id=rd.current_revision_id
)
`;

export class PgSessionObservation implements SessionObservationReader {
  private readonly scope: string;
  private readonly roleCache = new Map<string, ObservedRole | null>();
  constructor(private readonly client: PoolClient, private readonly projectId: string, scope: string) {
    this.scope = createHash("sha256").update(`${projectId}\0${scope}`).digest("hex");
  }
  private meta(observedAt: string | null = null, limitations: string[] = []): ObservationMetadata {
    return { generatedAt: new Date().toISOString(), sourceObservedAt: observedAt, partial: limitations.length > 0, limitations };
  }
  private href(path: string): string { return `#/p/${this.projectId}/${path}`; }
  private source(kind: ObservationSource["kind"], id: string, revision: string | null = null,
    evidence: ObservationSource["evidence"] = "project-record", taskId?: string | null): ObservationSource {
    const segment = kind === "run" ? `runtime?run=${id}` : kind === "role" ? `roles?role=${id}` :
      kind === "discussion" ? `discussions/${id}` : kind === "message" ? `session-messages/${id}` :
      kind === "task" || kind === "delivery" || kind === "consumer-observation" || kind === "task-assignment" ? `tasks/${taskId ?? id}` : "runtime";
    return { kind, id, revision, evidence, href: this.href(segment) };
  }
  private encode(kind: string, position: string, filter: string): string {
    return Buffer.from(JSON.stringify({ v: 1, scope: this.scope, kind, position, filter })).toString("base64url");
  }
  private decode(value: string, kind: string, filter: string): string {
    try {
      if (value.length > 4096) throw new Error();
      const d = JSON.parse(Buffer.from(value, "base64url").toString());
      if (d.v !== 1 || d.scope !== this.scope || d.kind !== kind || d.filter !== filter || typeof d.position !== "string") throw new Error();
      return d.position;
    } catch { throw new DomainError("INVALID_CURSOR", "读取位置与当前项目、身份或筛选不符，请重新读取快照。"); }
  }
  private async head(): Promise<string> {
    const r = await this.client.query("SELECT sequence::text FROM session_observation_head WHERE project_id=$1", [this.projectId]);
    return r.rows[0]?.sequence ?? "0";
  }
  private bound(limit: number, max: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw new DomainError("INVALID_PAGE", `Page limit must be 1..${max}`);
  }
  private async raw(key: string): Promise<Row | null> {
    if (!validKey.test(key)) throw new DomainError("INVALID_SESSION_KEY", "会话入口无效。");
    const [kind, id] = key.split(":");
    const r = await this.client.query(`${catalog} SELECT * FROM described WHERE kind=$2 AND $3::uuid=ANY(aliases)`, [this.projectId, kind, id]);
    return r.rows[0] ?? null;
  }
  private async roles(ids: string[]): Promise<ObservedRole[]> {
    const missing = ids.filter(id => !this.roleCache.has(id));
    if (!missing.length) return ids.flatMap(id => this.roleCache.get(id) ?? []).slice(0, 10);
    await this.preloadRoles(missing);
    return ids.flatMap(id => this.roleCache.get(id) ?? []).slice(0, 10);
  }
  private async preloadRoles(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const r = await this.client.query(`SELECT d.role_id,d.state,r.proposal FROM role_definition d JOIN role_revision r
      ON r.project_id=d.project_id AND r.role_id=d.role_id AND r.revision_id=d.current_revision_id
      WHERE d.project_id=$1 AND d.role_id::text=ANY($2::text[]) ORDER BY d.role_id LIMIT 500`, [this.projectId, ids]);
    for (const id of ids) this.roleCache.set(id, null);
    for (const x of r.rows) this.roleCache.set(x.role_id, { id: x.role_id, title: clip(x.proposal.title, 240), state: x.state,
      roleClass: x.proposal.roleClass ?? null, templateKey: x.proposal.templateKey ?? null,
      responsibility: clip(x.proposal.independentResponsibility) });
  }
  private task(row: Row, relation: ObservedTask["relation"]): ObservedTask {
    return { id: row.task_id, title: clip(row.title, 240), state: row.state, revisionId: row.current_revision_id,
      owner: row.owner, relation, source: this.source("task", row.task_id, row.current_revision_id) };
  }
  private async prepare(rows: Row[]): Promise<PreparedSessions> {
    const owned = rows.filter(row => row.kind === "owned").map(row => row.identity as string);
    const aliases = [...new Set(rows.flatMap(row => row.aliases as string[]))];
    const runs = await this.client.query(`SELECT DISTINCT ON(session_id) session_id,run_id,task_id,state,updated_at FROM runtime_run
        WHERE project_id=$1 AND session_id=ANY($2::uuid[]) ORDER BY session_id,created_at DESC,run_id DESC`, [this.projectId, owned]);
    const claims = await this.client.query(`SELECT DISTINCT ON(c.session_id) c.session_id,t.*,'claimed'::text AS relation FROM resident_queue_claim c
        JOIN task t ON t.project_id=c.project_id AND t.task_id=c.task_id
        WHERE c.project_id=$1 AND c.session_id=ANY($2::uuid[]) AND c.released_at IS NULL AND t.state='in_progress'
        ORDER BY c.session_id,t.task_id`, [this.projectId, owned]);
    const assignments = await this.client.query(`SELECT DISTINCT ON(a.target_kind,a.target_id) a.target_kind,a.target_id,t.*,a.state AS relation FROM task_session_assignment a
        JOIN task t ON t.project_id=a.project_id AND t.task_id=a.task_id
        WHERE a.project_id=$1 AND a.target_id=ANY($2::uuid[]) AND a.state IN ('assigned','accepted')
          AND a.task_revision_id=t.current_revision_id AND t.state='in_progress'
        ORDER BY a.target_kind,a.target_id,(a.state='accepted') DESC,t.task_id`, [this.projectId, aliases]);
    const activeRuns = await this.client.query(`SELECT DISTINCT session_id FROM runtime_run WHERE project_id=$1 AND session_id=ANY($2::uuid[])
        AND state=ANY($3::text[])`, [this.projectId, owned, active]);
    const activeMessages = await this.client.query(`SELECT DISTINCT session_id FROM session_message_processing WHERE project_id=$1 AND session_id=ANY($2::uuid[])
        AND state IN ('dispatching','running','unknown')`, [this.projectId, owned]);
    const work = new Map<string, Row>();
    for (const row of assignments.rows) work.set(`${row.target_kind}:${row.target_id}`, row);
    for (const row of claims.rows) work.set(`owned:${row.session_id}`, row);
    return { runs: new Map(runs.rows.map(row => [row.session_id, row])), work,
      busy: new Set([...activeRuns.rows, ...activeMessages.rows].map(row => row.session_id)) };
  }
  private async describe(row: Row, prepared?: PreparedSessions): Promise<ObservedSession> {
    const target: SessionTarget = row.kind === "owned" ? { kind: "owned", sessionId: row.identity } : { kind: "external", linkId: row.identity };
    const roles = await this.roles(row.role_ids);
    const profile = selectedProfile(row);
    const limitations = row.kind === "external" ? ["外部会话仅人工接入；未同步原聊天实时状态和完整历史。"] : [];
    if (Number(row.alias_count) > 20) limitations.push("重复接入别名仅返回前20项。仍按真实身份归并。");
    if (!roles.length) limitations.push("当前没有可核对的正式职责，保留原会话身份。");
    const runs = prepared ? { rows: [prepared.runs.get(row.identity)].filter(Boolean) } : row.kind === "owned" ? await this.client.query(`SELECT run_id,task_id,state,updated_at FROM runtime_run
      WHERE project_id=$1 AND session_id=$2 ORDER BY created_at DESC,run_id DESC LIMIT 1`, [this.projectId, row.identity]) : { rows: [] };
    const run = runs.rows[0];
    const work = prepared ? { rows: [((row.aliases as string[]).map(id => prepared.work.get(`${row.kind}:${id}`)).find(Boolean))].filter(Boolean) } : await this.client.query(`SELECT t.*,CASE WHEN c.claim_id IS NOT NULL THEN 'claimed' ELSE a.state END AS relation
      FROM task t LEFT JOIN resident_queue_claim c ON c.project_id=t.project_id AND c.task_id=t.task_id
        AND c.session_id=$2 AND c.released_at IS NULL
      LEFT JOIN task_session_assignment a ON a.project_id=t.project_id AND a.task_id=t.task_id AND a.target_kind=$3
        AND a.target_id=ANY($4::uuid[]) AND a.task_revision_id=t.current_revision_id AND a.state IN ('assigned','accepted')
      WHERE t.project_id=$1 AND t.state='in_progress' AND (c.claim_id IS NOT NULL OR a.task_id IS NOT NULL)
      ORDER BY (c.claim_id IS NOT NULL) DESC,(a.state='accepted') DESC,t.task_id LIMIT 2`,
      [this.projectId, row.kind === "owned" ? row.identity : null, row.kind, row.aliases]);
    if (work.rows.length > 1) limitations.push("存在多项分派/承接工作；首屏只列一项，分派与任务列表保留全部。不能推定都在执行。");
    const inFlight = prepared ? { rows: [{ busy: prepared.busy.has(row.identity) }] } : row.kind === "owned" ? await this.client.query(`SELECT EXISTS(SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2
        AND state=ANY($3::text[])) OR EXISTS(SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2
        AND state IN ('dispatching','running','unknown')) AS busy`, [this.projectId, row.identity, active]) : { rows: [] };
    const current = work.rows[0];
    const unavailable = (reason: string) => ({ available: false, reason });
    const sendEligible = row.kind === "owned" ? row.runtime?.state === "ready" : !row.historical;
    const send = sendEligible ? row.kind === "owned"
      ? { available: true, reason: "可保存排队；执行还需独立授权、剩余额度和逐轮只读核验。", mode: "owned-read-only" as const }
      : { available: true, reason: "仅可保存人工转交；不证明已经送达或被读取。", mode: "manual-handoff" as const }
      : { ...unavailable("会话已关闭或接入已撤销。"), mode: "unavailable" as const };
    const canOpen = !!row.can_open && !!row.external_ref && !row.historical;
    return { key: row.key, target, aliases: row.aliases.map((id: string) => row.kind === "owned" ? { kind: "owned", sessionId: id } : { kind: "external", linkId: id }),
      title: profile?.displayName ?? clip(row.title, 240), profile, kind: row.kind, roles,
      membership: row.membership, membershipReason: profile ? "Lead 明确维护的项目会话归类。" : row.historical ? "来源记录已结束或接入已撤销。" : row.verified ? "项目中已验证的实际接入。" : "尚无明确当前团队归类，不能用 ready 状态推断。",
      runtimeState: row.runtime?.state ?? null, busy: row.kind === "owned" ? !!inFlight.rows[0]?.busy : null,
      currentTask: current ? this.task(current, current.relation) : null,
      latestBusinessRun: run ? { id: run.run_id, taskId: run.task_id, state: run.state, updatedAt: iso(run.updated_at)!, source: this.source("run", run.run_id) } : null,
      lastProgressAt: run ? iso(run.updated_at) : null,
      capabilities: { observe: { available: true, reason: null },
        send,
        open: canOpen ? { available: true, reason: "原聊天入口不证明已打开或具备自动发送。", ref: row.external_ref } : { ...unavailable("缺少已验证的打开能力或有效聊天引用。"), ref: null },
        interrupt: unavailable("请在原业务 Run 入口核对当前执行和权限。"), close: unavailable("关闭需核对占用与当前复核权限。") },
      source: this.source(row.kind === "owned" ? "session" : "host-link", row.identity), metadata: this.meta(iso(row.observed_at), limitations) };
  }
  async directory(options: { limit: number; cursor?: string; search?: string; membership?: string }): Promise<SessionDirectory> {
    this.bound(options.limit, 50);
    const filter = JSON.stringify({ search: options.search ?? "", membership: options.membership ?? "current" });
    const currentHead = await this.head();
    let boundary = currentHead;
    let after: string | null = null;
    if (options.cursor) {
      try {
        const saved = JSON.parse(this.decode(options.cursor, "directory", filter));
        if (!validKey.test(saved.key) || !/^(0|[1-9][0-9]{0,18})$/.test(saved.boundary)) throw new Error();
        after = saved.key; boundary = saved.boundary;
      } catch { throw new DomainError("INVALID_CURSOR", "目录分页位置无效，请从第一页重读。"); }
    }
    const r = await this.client.query(`${catalog} SELECT * FROM described WHERE ($2::text IS NULL OR key>$2)
      AND ($3='all' OR membership=$3) AND ($4='' OR title ILIKE '%'||$4||'%' OR COALESCE(profile->>'purpose','') ILIKE '%'||$4||'%')
      ORDER BY key LIMIT $5`, [this.projectId, after, options.membership ?? "current", options.search ?? "", options.limit + 1]);
    const total = await this.client.query(`${catalog} SELECT membership,count(*)::int AS count FROM described GROUP BY membership`, [this.projectId]);
    const totals = { current: 0, historical: 0, unclassified: 0 };
    for (const row of total.rows) totals[row.membership as keyof typeof totals] = row.count;
    const attention = await this.client.query(`SELECT
      (SELECT count(*)::int FROM discussion_event q JOIN discussion d ON d.project_id=q.project_id AND d.discussion_id=q.discussion_id
        JOIN task t ON t.project_id=d.project_id AND t.task_id=d.task_id
        WHERE q.project_id=$1 AND t.state='in_progress' AND q.collaboration_payload->>'kind'='question' AND NOT EXISTS(SELECT 1 FROM discussion_event a
          WHERE a.project_id=q.project_id AND a.discussion_id=q.discussion_id AND a.collaboration_payload->>'kind'='answer'
            AND a.collaboration_payload->>'replyToEventId'=q.event_id::text)) AS questions,
      (SELECT count(*)::int FROM session_message WHERE project_id=$1 AND state IN ('queued','processing','unknown','manual_pending')) AS messages,
      (SELECT count(*)::int FROM task t JOIN task_proposal p ON p.project_id=t.project_id AND p.task_id=t.task_id AND p.task_revision_id=t.current_revision_id
        JOIN LATERAL(SELECT * FROM delivery d WHERE d.project_id=t.project_id AND d.task_id=t.task_id ORDER BY created_at DESC,delivery_id DESC LIMIT 1) d ON true
        WHERE t.project_id=$1 AND t.state='in_progress' AND d.technical_result='passed' AND p.use_required AND NOT EXISTS(
          SELECT 1 FROM consumer_observation o WHERE o.project_id=t.project_id AND o.delivery_id=d.delivery_id AND o.observer=p.consumer AND o.result='used')) AS acceptance`, [this.projectId]);
    const items: ObservedSession[] = [];
    await this.preloadRoles([...new Set(r.rows.slice(0, options.limit).flatMap(x => x.role_ids as string[]))]);
    const prepared = await this.prepare(r.rows.slice(0, options.limit));
    let bytes = 2000;
    for (const row of r.rows.slice(0, options.limit)) {
      const item = await this.describe(row, prepared); const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > byteLimit) break;
      items.push(item); bytes += size;
    }
    const more = r.rows.length > items.length;
    return { items, nextCursor: more && items.length ? this.encode("directory", JSON.stringify({ key: items.at(-1)!.key, boundary }), filter) : null,
      observationCursor: this.encode("changes", boundary, ""),
      metadata: this.meta(null, [...(more ? ["目录已分页，不能把当前页当成全部团队。"] : []),
        ...(boundary !== currentHead ? ["分页期间事实已变化；保留第一页观察位置，变化到达时从第一页重建已加载目录。"] : [])]), totals,
      attention: { unansweredQuestions: attention.rows[0]!.questions, pendingMessages: attention.rows[0]!.messages,
        pendingAcceptance: attention.rows[0]!.acceptance, unclassifiedSessions: totals.unclassified } };
  }
  private async taskIds(row: Row): Promise<string[]> {
    const r = await this.client.query(`SELECT task_id FROM (
      SELECT task_id FROM runtime_run WHERE project_id=$1 AND session_id=$2
      UNION SELECT task_id FROM task_session_assignment_revision WHERE project_id=$1 AND target_kind=$3 AND target_id=ANY($4::uuid[])
      UNION SELECT task_id FROM resident_queue_entry WHERE project_id=$1 AND session_id=$2
      ) related ORDER BY task_id LIMIT 201`, [this.projectId, row.kind === "owned" ? row.identity : null, row.kind, row.aliases]);
    return r.rows.map(x => x.task_id);
  }
  private async acceptedWindows(row: Row): Promise<Array<{ task_id: string; start_at: Date; end_at: Date | null }>> {
    const r = await this.client.query(`WITH revisions AS (
      SELECT task_id,target_kind,target_id,state,ack_at,updated_at,
        lead(updated_at) OVER (PARTITION BY task_id ORDER BY version) AS end_at
      FROM task_session_assignment_revision WHERE project_id=$1
    ) SELECT task_id,ack_at AS start_at,end_at FROM revisions
      WHERE target_kind=$2 AND target_id=ANY($3::uuid[]) AND state='accepted' AND ack_at IS NOT NULL
      ORDER BY task_id,ack_at LIMIT 201`, [this.projectId, row.kind, row.aliases]);
    return r.rows;
  }
  private async changeScope(row: Row, tasks: string[]): Promise<{ sql: string; params: unknown[]; limited: boolean }> {
    const allWindows = await this.acceptedWindows(row), windows = allWindows.slice(0, 200);
    return { sql: `(session_id=$2::uuid OR (target_kind=$3 AND target_id=ANY($4::uuid[]))
      OR (run_id IS NOT NULL AND EXISTS(SELECT 1 FROM runtime_run r WHERE r.project_id=session_observation_change.project_id
        AND r.run_id=session_observation_change.run_id AND r.session_id=$2::uuid))
      OR (task_id=ANY($5::uuid[]) AND occurred_at IS NOT NULL AND EXISTS(
        SELECT 1 FROM unnest($7::uuid[],$8::timestamptz[],$9::timestamptz[]) AS w(task_id,start_at,end_at)
        WHERE w.task_id=session_observation_change.task_id AND session_observation_change.occurred_at>=w.start_at
          AND (w.end_at IS NULL OR session_observation_change.occurred_at<w.end_at)))
      OR (source_table IN ('role_revision','role_host_link_revision') AND role_id=ANY($6::text[])))`,
      params: [this.projectId, row.kind === "owned" ? row.identity : null, row.kind, row.aliases, tasks.slice(0, 200), row.role_ids,
        windows.map(x => x.task_id), windows.map(x => x.start_at), windows.map(x => x.end_at)], limited: allWindows.length > 200 || tasks.length > 200 };
  }
  private eventSource(row: Row): ObservationSource {
    const table = row.source_table as string;
    if (table === "runtime_run") return this.source("run", row.run_id ?? row.entity_id, row.source_revision);
    if (table === "runtime_record_event") return row.run_id
      ? this.source("run", row.run_id, row.entity_id)
      : this.source("session", row.session_id ?? row.entity_id, row.entity_id);
    if (table === "runtime_session") return this.source("session", row.entity_id, row.source_revision);
    if (table === "role_revision") return this.source("role", row.entity_id, row.source_revision);
    if (table === "role_host_link_revision") return this.source("host-link", row.entity_id, row.source_revision);
    if (table === "discussion_event") return this.source("discussion", row.discussion_id ?? row.entity_id, row.entity_id, "session-statement");
    if (table.startsWith("session_message")) return this.source("message", row.message_id ?? row.entity_id, row.entity_id);
    if (table === "session_profile") return this.source("session-profile", row.entity_id, row.source_revision);
    if (table === "delivery") return this.source("delivery", row.entity_id, row.source_revision, "project-record", row.task_id);
    if (table === "consumer_observation") return this.source("consumer-observation", row.entity_id, row.source_revision, "independent-use", row.task_id);
    return this.source("task", row.task_id ?? row.entity_id, row.source_revision);
  }
  private activity(row: Row, key: string): SessionActivity {
    const detail = row.detail ?? {};
    const label: Record<string, string> = { runtime_session: "会话", runtime_run: "业务运行", runtime_record_event: "运行记录", role_revision: "职责修订",
      role_host_link_revision: "接入变化", task_revision: "任务修订", resident_queue_entry: "队列安排", resident_queue_claim: "任务承接",
      discussion_event: "任务沟通", delivery: "提交成果", consumer_observation: "使用观察", session_message: "会话消息", session_message_processing: "消息处理",
      session_profile: "会话名称与用途", task_session_assignment: "具体分派", session_message_read_receipt: "接收者记录已读" };
    return { id: `${this.projectId}:${row.sequence}`, sequence: String(row.sequence), sessionKey: key,
      kind: detail.kind ?? row.source_table, summary: clip([label[row.source_table] ?? row.source_table, detail.title, detail.result ?? detail.state,
        detail.summary].filter(Boolean).join(" · ")), occurredAt: iso(row.occurred_at), recordedAt: iso(row.recorded_at)!,
      actorId: row.actor_id, taskId: row.task_id, importance: "important", source: this.eventSource(row) };
  }
  private boundSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
    const omitted: string[] = [];
    const sections: Array<[string, unknown[]]> = [["职责任务", snapshot.roleTasks], ["动态", snapshot.activity],
      ["成果", snapshot.results], ["队列", snapshot.queue], ["分派", snapshot.assignments], ["问题", snapshot.questions]];
    while (Buffer.byteLength(JSON.stringify(snapshot)) > byteLimit - 1024) {
      const candidates = sections.slice(0, -1).flatMap(([label, items]) => items.map((item, index) => ({
        label, items, index, bytes: Buffer.byteLength(JSON.stringify(item)) })));
      const largest = candidates.sort((a, b) => b.bytes - a.bytes)[0];
      if (largest) { largest.items.splice(largest.index, 1); if (!omitted.includes(largest.label)) omitted.push(largest.label); }
      else if (snapshot.questions.length) { snapshot.questions.pop(); if (!omitted.includes("问题")) omitted.push("问题"); }
      else throw new DomainError("RESULT_TOO_LARGE", "Session snapshot exceeds the bounded response limit");
    }
    if (omitted.length) snapshot.metadata = this.meta(snapshot.metadata.sourceObservedAt,
      [...snapshot.metadata.limitations, `响应大小限制：已省略部分${omitted.join("、")}，可从对应任务与固定来源继续读取。`]);
    return snapshot;
  }
  async history(key: string, options: { limit: number; cursor?: string; taskId?: string; importance?: "important" | "all" }): Promise<SessionActivityPage | null> {
    this.bound(options.limit, 50); const row = await this.raw(key); if (!row) return null;
    const tasks = await this.taskIds(row); const scope = await this.changeScope(row, tasks);
    const filter = JSON.stringify({ key: row.key, taskId: options.taskId ?? null, importance: options.importance ?? "important" });
    const position = options.cursor ? this.decode(options.cursor, "history", filter) : await this.head();
    if (!/^\d+$/.test(position)) throw new DomainError("INVALID_CURSOR", "历史读取位置无效。");
    const n = scope.params.length;
    const r = await this.client.query(`SELECT * FROM session_observation_change WHERE project_id=$1 AND ${scope.sql}
      AND sequence<=$${n + 1}::bigint AND ($${n + 2}::uuid IS NULL OR task_id=$${n + 2}) ORDER BY sequence DESC LIMIT $${n + 3}`,
      [...scope.params, position, options.taskId ?? null, options.limit + 1]);
    const chosen = r.rows.slice(0, options.limit); const limits = scope.limited ? ["关联任务或接受窗口仅覆盖前200项，请从原任务读取其余来源。"] : [];
    const items = chosen.map(x => this.activity(x, row.key));
    while (items.length && Buffer.byteLength(JSON.stringify(items)) > byteLimit - 1024) items.pop();
    if (items.length < chosen.length) limits.push("历史响应按字节分页，请继续读取下一页。");
    return { items,
      nextCursor: r.rows.length > items.length && items.length ? this.encode("history", (BigInt(items.at(-1)!.sequence) - 1n).toString(), filter) : null,
      metadata: this.meta(null, ["关联任务历史按真实操作者保留，不表示该会话执行过全部步骤。", ...limits]) };
  }
  async changes(options: { cursor: string; limit: number; key?: string }): Promise<SessionChanges> {
    this.bound(options.limit, 100);
    const filter = options.key ?? "";
    const position = this.decode(options.cursor, "changes", filter);
    if (!/^\d+$/.test(position)) throw new DomainError("INVALID_CURSOR", "变化读取位置无效。");
    const head = await this.head();
    if (BigInt(position) > BigInt(head)) return { items: [], nextCursor: this.encode("changes", head, filter), hasMore: false, resetRequired: true, metadata: this.meta() };
    let scope = { sql: "true", params: [this.projectId] as unknown[], limited: false };
    if (options.key) { const row = await this.raw(options.key); if (!row) throw new DomainError("NOT_FOUND", "会话已不在此项目目录。"); scope = await this.changeScope(row, await this.taskIds(row)); }
    const n = scope.params.length;
    const r = await this.client.query(`SELECT * FROM session_observation_change WHERE project_id=$1 AND ${scope.sql}
      AND sequence>$${n + 1}::bigint AND sequence<=$${n + 2}::bigint ORDER BY sequence LIMIT $${n + 3}`,
      [...scope.params, position, head, options.limit + 1]);
    const items: SessionChanges["items"] = []; let bytes = 2000;
    for (const row of r.rows.slice(0, options.limit)) {
      const item: SessionChanges["items"][number] = { id: `${this.projectId}:${row.sequence}`, sequence: String(row.sequence), operation: "invalidate",
        sessionKeys: options.key ? [options.key] : [], source: this.eventSource(row), recordedAt: iso(row.recorded_at)! };
      const size = Buffer.byteLength(JSON.stringify(item)); if (bytes + size > byteLimit) break;
      items.push(item); bytes += size;
    }
    const hasMore = r.rows.length > items.length;
    return { items, nextCursor: this.encode("changes", hasMore ? items.at(-1)?.sequence ?? position : head, filter), hasMore,
      resetRequired: false, metadata: this.meta(null, scope.limited ? ["关联任务或接受窗口仅覆盖前200项，请从原任务读取其余来源。"] : []) };
  }
  async snapshot(key: string): Promise<SessionSnapshot | null> {
    const observationHead = await this.head();
    const row = await this.raw(key); if (!row) return null;
    const session = await this.describe(row);
    const taskIds = await this.taskIds(row);
    const windows = await this.acceptedWindows(row);
    const visibleWindows = windows.slice(0, 200);
    const windowTasks = visibleWindows.map(x => x.task_id), windowStarts = visibleWindows.map(x => x.start_at), windowEnds = visibleWindows.map(x => x.end_at);
    const owned = row.kind === "owned" ? row.identity : null;
    const assignments = await this.client.query(`SELECT a.task_id,t.title,t.state,t.owner,t.current_revision_id FROM task_session_assignment a
      JOIN task t ON t.project_id=a.project_id AND t.task_id=a.task_id WHERE a.project_id=$1 AND a.target_kind=$2
      AND a.target_id=ANY($3::uuid[]) AND a.state<>'released' ORDER BY a.updated_at DESC,a.task_id LIMIT 21`, [this.projectId, row.kind, row.aliases]);
    const store = new PgSessionAssignments(this.client, this.projectId);
    const assigned: SessionSnapshot["assignments"] = [];
    for (const item of assignments.rows.slice(0, 20)) { const assignment = await store.getTaskSessionAssignment(item.task_id); if (assignment)
      assigned.push({ assignment, task: this.task(item, assignment.state === "accepted" ? "accepted" : "assigned"), stale: assignment.taskRevisionId !== item.current_revision_id }); }
    const roleTasks = await this.client.query(`SELECT task_id,title,state,owner,current_revision_id FROM task WHERE project_id=$1
      AND owner=ANY($2::text[]) AND state IN ('todo','in_progress') ORDER BY task_id LIMIT 21`, [this.projectId, row.role_ids]);
    const queue = await this.client.query(`SELECT e.*,t.title FROM resident_queue_entry e JOIN task t ON t.project_id=e.project_id AND t.task_id=e.task_id
      WHERE e.project_id=$1 AND e.session_id=$2 AND e.state<>'released' ORDER BY e.queue_id,e.position LIMIT 21`, [this.projectId, owned]);
    const results = await this.client.query(`SELECT d.*,t.title,o.result AS use_result,o.observer,o.observer_kind,o.created_at AS use_at,o.observation_id
      FROM delivery d JOIN task t ON t.project_id=d.project_id AND t.task_id=d.task_id
      LEFT JOIN LATERAL(SELECT * FROM consumer_observation o WHERE o.project_id=d.project_id AND o.delivery_id=d.delivery_id ORDER BY sequence DESC LIMIT 1) o ON true
      WHERE d.project_id=$1 AND (
        (d.run_id IS NOT NULL AND EXISTS(SELECT 1 FROM runtime_run r WHERE r.project_id=d.project_id AND r.run_id=d.run_id AND r.session_id=$2::uuid))
        OR (d.run_id IS NULL AND EXISTS(SELECT 1 FROM unnest($3::uuid[],$4::timestamptz[],$5::timestamptz[]) AS w(task_id,start_at,end_at)
          WHERE w.task_id=d.task_id AND d.created_at>=w.start_at AND (w.end_at IS NULL OR d.created_at<w.end_at)))
      ) ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT 11`, [this.projectId, owned, windowTasks, windowStarts, windowEnds]);
    const questions = await this.client.query(`SELECT d.discussion_id,d.task_id,d.task_revision_id,q.event_id,q.collaboration_payload,
      EXISTS(SELECT 1 FROM discussion_event a WHERE a.project_id=q.project_id AND a.discussion_id=q.discussion_id
        AND a.collaboration_payload->>'replyToEventId'=q.event_id::text AND a.collaboration_payload->>'kind'='answer') AS answered
      FROM discussion d JOIN discussion_event q ON q.project_id=d.project_id AND q.discussion_id=d.discussion_id
      WHERE d.project_id=$1 AND d.kind='task_collaboration' AND (
        d.collaboration_session_id=$2::uuid OR (d.collaboration_session_id IS NULL AND EXISTS(
          SELECT 1 FROM unnest($3::uuid[],$4::timestamptz[],$5::timestamptz[]) AS w(task_id,start_at,end_at)
          WHERE w.task_id=d.task_id AND q.created_at>=w.start_at AND (w.end_at IS NULL OR q.created_at<w.end_at)))
      ) AND q.collaboration_payload->>'kind'='question' ORDER BY answered ASC,q.created_at DESC,q.event_id DESC LIMIT 21`,
      [this.projectId, owned, windowTasks, windowStarts, windowEnds]);
    const history = await this.history(key, { limit: 20 });
    const unavailable = (unit: string, reason: string): ObservedResource => ({ value: null, unit, source: null, scope: "session", observedAt: null, interval: null, unavailableReason: reason });
    const limits: string[] = [];
    for (const [label, count, max] of [["分派", assigned.length === 20 ? assignments.rows.length : 0, 20], ["职责任务", roleTasks.rows.length, 20],
      ["队列", queue.rows.length, 20], ["成果", results.rows.length, 10], ["问题", questions.rows.length, 20], ["关联历史任务", taskIds.length, 200], ["历史接受窗口", windows.length, 200]] as const)
      if (count > max) limits.push(`${label}首屏仅展示前${max}项，沿原来源读取其余记录。`);
    const snapshot: SessionSnapshot = { session, observationCursor: this.encode("changes", observationHead, row.key), currentWork: session.currentTask,
      assignments: assigned, roleTasks: roleTasks.rows.slice(0, 20).map(x => this.task(x, "role-responsibility")),
      queue: queue.rows.slice(0, 20).map(x => ({ queueId: x.queue_id, entryId: x.entry_id, taskId: x.task_id, taskTitle: clip(x.title, 240), position: x.position,
        state: x.state, holdCode: x.hold_code, holdReason: x.hold_reason, dependsOn: x.depends_on, source: this.source("queue", x.queue_id) })),
      results: results.rows.slice(0, 10).map(x => ({ deliveryId: x.delivery_id, taskId: x.task_id, taskTitle: clip(x.title, 240), technicalResult: x.technical_result,
        artifactRef: x.artifact_ref, artifactRevision: x.artifact_revision, contentHash: x.content_hash, submittedAt: iso(x.created_at)!,
        latestUse: x.use_result ? { result: x.use_result, observer: x.observer, observerKind: x.observer_kind, createdAt: iso(x.use_at)!, source: this.source("consumer-observation", x.observation_id, null, "independent-use", x.task_id) } : null,
        source: this.source("delivery", x.delivery_id, null, "project-record", x.task_id) })),
      questions: questions.rows.slice(0, 20).map(x => ({ discussionId: x.discussion_id, taskId: x.task_id, taskRevisionId: x.task_revision_id,
        questionEventId: x.event_id, recipientActorId: x.collaboration_payload.recipientActorId, answered: x.answered, source: this.source("discussion", x.discussion_id, x.event_id) })),
      activity: history?.items ?? [], resources: {
        configuredModel: { ...unavailable("model", "来源未登记配置模型。"), value: row.runtime?.model ?? null, source: row.runtime ? "runtime_session.model" : null,
          observedAt: row.runtime ? iso(row.observed_at) : null, unavailableReason: row.runtime?.model ? null : "配置模型未知，不能猜实际用模。" },
        actualModel: unavailable("model", "尚未持久采集实际执行模型。"), inputTokens: unavailable("tokens", "尚未持久采集输入 token。"),
        outputTokens: unavailable("tokens", "尚未持久采集输出 token。"), cost: unavailable("currency", "未采集宿主账单，不作估价。"),
        processMemory: { ...unavailable("bytes", "没有可靠进程映射，共享进程不均摊到会话。"), scope: "runtime-process" } },
      metadata: this.meta(session.metadata.sourceObservedAt, [...session.metadata.limitations, ...limits]) };
    return this.boundSnapshot(snapshot);
  }
}
