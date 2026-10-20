import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import type {
  BasisDecision, BasisSet, Document, DocumentDecision, DocumentRevision, Impact,
  Operation, OutboxEvent, Page, Project, Task, TaskDocumentLink, TaskRevision,
} from "@evoloop/contracts";
import { DomainError, type Reader, type Transaction, type UnitOfWork } from "@evoloop/contracts/ports";

const { Pool } = pg;
const maxDetailRows = 10_000;
type Row = QueryResultRow;
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const rowProject = (r: Row): Project => ({ id: r.project_id, title: r.title, createdAt: iso(r.created_at) });
const rowDocument = (r: Row): Document => ({ projectId: r.project_id, id: r.document_id, title: r.title, version: r.version, currentRevisionId: r.current_revision_id, adoptedRevisionId: r.adopted_revision_id });
const rowDocumentRevision = (r: Row): DocumentRevision => ({ projectId: r.project_id, documentId: r.document_id, id: r.revision_id, body: r.body, format: r.format, contentHash: r.content_hash, author: r.author, createdAt: iso(r.created_at), previousRevisionId: r.previous_revision_id, reason: r.reason });
const rowTask = (r: Row): Task => ({ projectId: r.project_id, id: r.task_id, version: r.version, currentRevisionId: r.current_revision_id, title: r.title, goal: r.goal, acceptance: r.acceptance, owner: r.owner, state: r.state });
const rowTaskRevision = (r: Row): TaskRevision => ({ projectId: r.project_id, taskId: r.task_id, id: r.revision_id, version: r.version, title: r.title, goal: r.goal, acceptance: r.acceptance, owner: r.owner, state: r.state, basisSetId: r.basis_set_id, actorId: r.actor_id, reason: r.reason, createdAt: iso(r.created_at) });
const rowLink = (r: Row): TaskDocumentLink => ({ projectId: r.project_id, id: r.link_id, taskId: r.task_id, documentId: r.document_id, actorId: r.actor_id, createdAt: iso(r.created_at) });
const rowImpact = (r: Row): Impact => ({ projectId: r.project_id, id: r.impact_id, taskId: r.task_id, taskRevisionId: r.task_revision_id, documentId: r.document_id, fromRevisionId: r.from_revision_id, toRevisionId: r.to_revision_id, state: r.state, decisionId: r.decision_id, createdAt: iso(r.created_at) });
const rowBasisDecision = (r: Row): BasisDecision => ({ projectId: r.project_id, id: r.decision_id, impactId: r.impact_id, taskId: r.task_id, previousTaskRevisionId: r.previous_task_revision_id, nextTaskRevisionId: r.next_task_revision_id, decision: r.decision, reason: r.reason, actorId: r.actor_id, createdAt: iso(r.created_at) });
const rowOperation = (r: Row): Operation => ({ projectId: r.project_id, id: r.operation_id, actorId: r.actor_id, commandHash: r.command_hash, commandType: r.command_type, result: r.result, createdAt: iso(r.created_at) });
function pageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("page limit must be 1..100");
  return limit;
}
function bounded<T>(items: T[], label: string): T[] {
  if (items.length > maxDetailRows) throw new DomainError("RESULT_TOO_LARGE", `${label} exceeds ${maxDetailRows}; use a bounded query`);
  return items;
}
function page<T>(rows: Row[], limit: number, map: (row: Row) => T, id: (row: Row) => string): Page<T> {
  const hasMore = rows.length > limit;
  const chosen = rows.slice(0, limit);
  return { items: chosen.map(map), nextCursor: hasMore ? id(chosen[chosen.length - 1]!) : null };
}

class PgReader implements Reader {
  constructor(protected readonly client: PoolClient, protected readonly projectId: string) {}
  async getProject(): Promise<Project | null> {
    const r = await this.client.query("SELECT project_id, title, created_at FROM project WHERE project_id=$1", [this.projectId]);
    return r.rows[0] ? rowProject(r.rows[0]) : null;
  }
  async getDocument(id: string): Promise<Document | null> {
    const r = await this.client.query("SELECT * FROM process_document WHERE project_id=$1 AND document_id=$2", [this.projectId, id]);
    return r.rows[0] ? rowDocument(r.rows[0]) : null;
  }
  async getDocumentRevision(documentId: string, revisionId: string): Promise<DocumentRevision | null> {
    const r = await this.client.query("SELECT * FROM document_revision WHERE project_id=$1 AND document_id=$2 AND revision_id=$3", [this.projectId, documentId, revisionId]);
    return r.rows[0] ? rowDocumentRevision(r.rows[0]) : null;
  }
  async listDocuments(limit: number, cursor?: string): Promise<Page<Document>> {
    pageLimit(limit);
    const r = await this.client.query("SELECT * FROM process_document WHERE project_id=$1 AND ($2::uuid IS NULL OR document_id>$2::uuid) ORDER BY document_id LIMIT $3", [this.projectId, cursor ?? null, limit + 1]);
    return page(r.rows, limit, rowDocument, (x) => x.document_id);
  }
  async getTask(id: string): Promise<Task | null> {
    const r = await this.client.query("SELECT * FROM task WHERE project_id=$1 AND task_id=$2", [this.projectId, id]);
    return r.rows[0] ? rowTask(r.rows[0]) : null;
  }
  async getTaskRevision(taskId: string, revisionId: string): Promise<TaskRevision | null> {
    const r = await this.client.query("SELECT * FROM task_revision WHERE project_id=$1 AND task_id=$2 AND revision_id=$3", [this.projectId, taskId, revisionId]);
    return r.rows[0] ? rowTaskRevision(r.rows[0]) : null;
  }
  async getBasisSet(taskId: string, taskRevisionId: string, basisSetId: string): Promise<BasisSet | null> {
    const found = await this.client.query("SELECT * FROM basis_set WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND basis_set_id=$4 AND sealed", [this.projectId, taskId, taskRevisionId, basisSetId]);
    if (!found.rows[0]) return null;
    const members = await this.client.query("SELECT document_id, document_revision_id FROM basis_member WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND basis_set_id=$4 ORDER BY document_id", [this.projectId, taskId, taskRevisionId, basisSetId]);
    return { projectId: this.projectId, taskId, taskRevisionId, id: basisSetId, sealed: true, members: members.rows.map((m) => ({ documentId: m.document_id, revisionId: m.document_revision_id })) };
  }
  async listTasks(limit: number, cursor?: string): Promise<Page<Task>> {
    pageLimit(limit);
    const r = await this.client.query("SELECT * FROM task WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id>$2::uuid) ORDER BY task_id LIMIT $3", [this.projectId, cursor ?? null, limit + 1]);
    return page(r.rows, limit, rowTask, (x) => x.task_id);
  }
  async listLinks(taskId: string): Promise<TaskDocumentLink[]> {
    const r = await this.client.query("SELECT * FROM task_document_link WHERE project_id=$1 AND task_id=$2 ORDER BY link_id LIMIT $3", [this.projectId, taskId, maxDetailRows + 1]);
    return bounded(r.rows.map(rowLink), "task links");
  }
  async getImpact(id: string): Promise<Impact | null> {
    const r = await this.client.query("SELECT * FROM impact_review WHERE project_id=$1 AND impact_id=$2", [this.projectId, id]);
    return r.rows[0] ? rowImpact(r.rows[0]) : null;
  }
  async listImpacts(taskId?: string): Promise<Impact[]> {
    const r = await this.client.query("SELECT * FROM impact_review WHERE project_id=$1 AND ($2::uuid IS NULL OR task_id=$2::uuid) ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END, created_at, impact_id LIMIT $3", [this.projectId, taskId ?? null, maxDetailRows + 1]);
    return bounded(r.rows.map(rowImpact), "impacts");
  }
  async listBasisDecisions(taskId: string): Promise<BasisDecision[]> {
    const r = await this.client.query("SELECT * FROM basis_decision WHERE project_id=$1 AND task_id=$2 ORDER BY created_at, decision_id LIMIT $3", [this.projectId, taskId, maxDetailRows + 1]);
    return bounded(r.rows.map(rowBasisDecision), "basis decisions");
  }
  async getOperation(id: string): Promise<Operation | null> {
    const r = await this.client.query("SELECT * FROM operation_journal WHERE project_id=$1 AND operation_id=$2", [this.projectId, id]);
    return r.rows[0] ? rowOperation(r.rows[0]) : null;
  }
  async findTasksUsingDocument(documentId: string): Promise<Task[]> {
    const r = await this.client.query(`SELECT DISTINCT t.* FROM task t
      JOIN task_revision tr ON tr.project_id=t.project_id AND tr.task_id=t.task_id AND tr.revision_id=t.current_revision_id
      JOIN basis_set b ON b.project_id=t.project_id AND b.task_id=t.task_id AND b.task_revision_id=tr.revision_id AND b.basis_set_id=tr.basis_set_id AND b.sealed
      JOIN basis_member bm ON bm.project_id=b.project_id AND bm.task_id=b.task_id AND bm.task_revision_id=b.task_revision_id AND bm.basis_set_id=b.basis_set_id
      WHERE t.project_id=$1 AND bm.document_id=$2 ORDER BY t.task_id LIMIT $3`, [this.projectId, documentId, maxDetailRows + 1]);
    return bounded(r.rows.map(rowTask), "tasks using document");
  }
}

class PgTransaction extends PgReader implements Transaction {
  private savepointNumber = 0;
  private assertScope(projectId: string): void {
    if (projectId !== this.projectId) throw new DomainError("PROJECT_SCOPE", "object belongs to another project");
  }
  async savepoint<T>(action: () => Promise<T>): Promise<T> {
    const name = `effect_${++this.savepointNumber}`;
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await action();
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }
  async insertProject(p: Project): Promise<void> {
    this.assertScope(p.id);
    await this.client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)", [this.projectId, p.title, p.createdAt]);
  }
  async insertDocument(d: Document): Promise<void> {
    this.assertScope(d.projectId);
    await this.client.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id) VALUES($1,$2,$3,$4,$5,$6)", [this.projectId, d.id, d.title, d.version, d.currentRevisionId, d.adoptedRevisionId]);
  }
  async insertDocumentRevision(r: DocumentRevision): Promise<void> {
    this.assertScope(r.projectId);
    await this.client.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [this.projectId, r.documentId, r.id, r.body, r.format, r.contentHash, r.author, r.createdAt, r.previousRevisionId, r.reason]);
  }
  async insertDocumentDecision(d: DocumentDecision): Promise<void> {
    this.assertScope(d.projectId);
    await this.client.query("INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [this.projectId, d.id, d.documentId, d.revisionId, d.actorId, d.reason, d.createdAt]);
  }
  async updateDocument(d: Document, expectedVersion: number): Promise<void> {
    this.assertScope(d.projectId);
    const r = await this.client.query("UPDATE process_document SET title=$3, version=$4, current_revision_id=$5, adopted_revision_id=$6 WHERE project_id=$1 AND document_id=$2 AND version=$7 RETURNING version", [this.projectId, d.id, d.title, d.version, d.currentRevisionId, d.adoptedRevisionId, expectedVersion]);
    if (!r.rowCount) throw await this.versionConflict("process_document", "document_id", d.id);
  }
  async insertTask(t: Task): Promise<void> {
    this.assertScope(t.projectId);
    await this.client.query("INSERT INTO task(project_id,task_id,version,current_revision_id,title,goal,acceptance,owner,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [this.projectId, t.id, t.version, t.currentRevisionId, t.title, t.goal, t.acceptance, t.owner, t.state]);
  }
  async insertTaskRevision(r: TaskRevision): Promise<void> {
    this.assertScope(r.projectId);
    await this.client.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,goal,acceptance,owner,state,basis_set_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [this.projectId, r.taskId, r.id, r.version, r.title, r.goal, r.acceptance, r.owner, r.state, r.basisSetId, r.actorId, r.reason, r.createdAt]);
  }
  async insertSealedBasisSet(b: BasisSet): Promise<void> {
    this.assertScope(b.projectId);
    await this.client.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)", [this.projectId, b.taskId, b.taskRevisionId, b.id]);
    for (const member of b.members) {
      await this.client.query("INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)", [this.projectId, b.taskId, b.taskRevisionId, b.id, member.documentId, member.revisionId]);
    }
    await this.client.query("UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND basis_set_id=$4", [this.projectId, b.taskId, b.taskRevisionId, b.id]);
  }
  async updateTask(t: Task, expectedVersion: number): Promise<void> {
    this.assertScope(t.projectId);
    const r = await this.client.query("UPDATE task SET version=$3,current_revision_id=$4,title=$5,goal=$6,acceptance=$7,owner=$8,state=$9 WHERE project_id=$1 AND task_id=$2 AND version=$10 RETURNING version", [this.projectId, t.id, t.version, t.currentRevisionId, t.title, t.goal, t.acceptance, t.owner, t.state, expectedVersion]);
    if (!r.rowCount) throw await this.versionConflict("task", "task_id", t.id);
  }
  async insertLink(l: TaskDocumentLink): Promise<void> {
    this.assertScope(l.projectId);
    await this.client.query("INSERT INTO task_document_link(project_id,link_id,task_id,document_id,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6)", [this.projectId, l.id, l.taskId, l.documentId, l.actorId, l.createdAt]);
  }
  async insertImpact(i: Impact): Promise<void> {
    this.assertScope(i.projectId);
    await this.client.query("INSERT INTO impact_review(project_id,impact_id,task_id,task_revision_id,document_id,from_revision_id,to_revision_id,state,decision_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [this.projectId, i.id, i.taskId, i.taskRevisionId, i.documentId, i.fromRevisionId, i.toRevisionId, i.state, i.decisionId, i.createdAt]);
  }
  async resolveImpact(id: string, decisionId: string): Promise<void> {
    const r = await this.client.query("UPDATE impact_review SET state='resolved',decision_id=$3 WHERE project_id=$1 AND impact_id=$2 AND state='pending'", [this.projectId, id, decisionId]);
    if (!r.rowCount) throw new DomainError("IMPACT_NOT_PENDING", "impact is not pending");
  }
  async supersedeImpacts(taskId: string, documentId: string): Promise<void> {
    await this.client.query("UPDATE impact_review SET state='superseded' WHERE project_id=$1 AND task_id=$2 AND document_id=$3 AND state='pending'", [this.projectId, taskId, documentId]);
  }
  async insertBasisDecision(d: BasisDecision): Promise<void> {
    this.assertScope(d.projectId);
    await this.client.query("INSERT INTO basis_decision(project_id,decision_id,impact_id,task_id,previous_task_revision_id,next_task_revision_id,decision,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [this.projectId, d.id, d.impactId, d.taskId, d.previousTaskRevisionId, d.nextTaskRevisionId, d.decision, d.reason, d.actorId, d.createdAt]);
  }
  async insertOperation(o: Operation): Promise<void> {
    this.assertScope(o.projectId);
    await this.client.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)", [this.projectId, o.id, o.actorId, o.commandHash, o.commandType, JSON.stringify(o.result), o.createdAt]);
  }
  async appendOutbox(e: OutboxEvent): Promise<void> {
    this.assertScope(e.projectId);
    await this.client.query("INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,entity_id,version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [this.projectId, e.id, e.operationId, e.effectKey, e.kind, e.entityId, e.version, e.createdAt]);
  }
  private async versionConflict(table: "task" | "process_document", column: "task_id" | "document_id", id: string): Promise<DomainError> {
    const r = await this.client.query(`SELECT version FROM ${table} WHERE project_id=$1 AND ${column}=$2`, [this.projectId, id]);
    return new DomainError("VERSION_CONFLICT", "object version has changed", r.rows[0]?.version);
  }
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: pg.Pool) {}
  async transaction<T>(projectId: string, action: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let open = false;
    let destroy = false;
    try {
      try { await client.query("BEGIN"); } catch (error) { destroy = true; throw error; }
      open = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectId]);
      const result = await action(new PgTransaction(client, projectId));
      try {
        await client.query("COMMIT");
        open = false;
      } catch (error) {
        // A lost COMMIT response is an unknown outcome, never a domain rejection.
        destroy = true;
        throw error;
      }
      return result;
    } catch (error) {
      if (open && !destroy) {
        try { await client.query("ROLLBACK"); } catch { destroy = true; }
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
  async read<T>(projectId: string, action: (reader: Reader) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let open = false;
    let destroy = false;
    try {
      try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); } catch (error) { destroy = true; throw error; }
      open = true;
      const result = await action(new PgReader(client, projectId));
      try { await client.query("COMMIT"); } catch (error) { destroy = true; throw error; }
      open = false;
      return result;
    } catch (error) {
      if (open) {
        try { await client.query("ROLLBACK"); } catch { destroy = true; }
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}

export function createPool(connectionString: string): pg.Pool { return new Pool({ connectionString }); }
export async function migrate(connectionString: string, schema = "public"): Promise<void> {
  await runner({
    databaseUrl: connectionString,
    dir: fileURLToPath(new URL("../migrations/", import.meta.url)),
    migrationsTable: "pgmigrations",
    schema,
    createSchema: schema !== "public",
    createMigrationsSchema: schema !== "public",
    direction: "up",
    singleTransaction: true,
    log: () => {},
  });
}
