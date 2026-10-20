import { commandSchema } from "@evoloop/contracts";
import type {
  AppliedResult, BasisDecision, BasisSet, Command, CommandResult, Document, DocumentDecision,
  DocumentDetail, DocumentRevision, Impact, Operation, OutboxEvent, Page, Principal, Project,
  Task, TaskDetail, TaskDocumentLink, TaskRevision,
} from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { Clock, ContentHasher, IdFactory, Reader, Transaction, UnitOfWork } from "@evoloop/contracts/ports";

export { DomainError } from "@evoloop/contracts/ports";

export interface WorkflowDependencies { uow: UnitOfWork; clock: Clock; ids: IdFactory; hasher: ContentHasher }
type Effect = { kind: string; entityId: string; version: number };
type Outcome = { result: AppliedResult; effects: Effect[] };

// The command hash is independent of object insertion order, including nested payloads.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new DomainError("INVALID_COMMAND", "Command contains an unsupported value");
  return encoded;
}

function requirePermission(principal: Principal, projectId: string, permission: "read" | "write" | "review"): void {
  if (!principal.actorId || !principal.projectIds.includes(projectId) || !principal.permissions.includes(permission)) {
    throw new DomainError("FORBIDDEN", `Permission ${permission} is required for this project`);
  }
}

function required<T>(value: T | null, kind: string): T {
  if (value === null) throw new DomainError("NOT_FOUND", `${kind} was not found`);
  return value;
}

function requireVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new DomainError("VERSION_CONFLICT", "The observed version is no longer current", actual);
}

function requireBody(body: string): void {
  if (new TextEncoder().encode(body).byteLength > 65536) {
    throw new DomainError("BODY_TOO_LARGE", "Markdown body exceeds 65536 UTF-8 bytes");
  }
}

function pageLimit(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_PAGE", "Limit must be between 1 and 100");
  return limit;
}

export class WorkflowService {
  constructor(private readonly deps: WorkflowDependencies) {}

  async execute(principal: Principal, input: Command): Promise<CommandResult> {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) throw new DomainError("INVALID_COMMAND", parsed.error.message);
    const command = parsed.data;
    const permission = this.commandPermission(command);
    requirePermission(principal, command.projectId, permission);
    const commandHash = this.deps.hasher.hash(canonicalJson({ actorId: principal.actorId, command }));
    return this.deps.uow.transaction(command.projectId, async (tx) => {
      const project = await tx.getProject();
      if (command.type !== "project.create") required(project, "Project");

      const prior = await tx.getOperation(command.operationId);
      if (prior) {
        if (prior.commandHash !== commandHash || prior.actorId !== principal.actorId) {
          throw new DomainError("OPERATION_REUSED", "Operation ID was used for a different command");
        }
        return prior.result;
      }

      const createdAt = this.deps.clock.now();
      let result: CommandResult;
      let effects: Effect[] = [];
      try {
        const outcome = await tx.savepoint(() => this.apply(tx, principal, command, createdAt));
        result = outcome.result;
        effects = outcome.effects;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        result = {
          status: "rejected", operationId: command.operationId, code: error.code,
          message: error.message, ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
        };
      }
      const operation: Operation = {
        projectId: command.projectId, id: command.operationId, actorId: principal.actorId,
        commandHash, commandType: command.type, result, createdAt,
      };
      await tx.insertOperation(operation);
      for (const effect of effects) {
        const event: OutboxEvent = {
          projectId: command.projectId, id: this.deps.ids.next(), operationId: command.operationId,
          effectKey: `${command.projectId}:${effect.kind}:${effect.entityId}`,
          kind: effect.kind, entityId: effect.entityId, version: effect.version, createdAt,
        };
        await tx.appendOutbox(event);
      }
      return result;
    });
  }

  private commandPermission(command: Command): "write" | "review" {
    return command.type === "document.adopt" || command.type === "task.accept" || command.type === "task.reviewBasis"
      ? "review" : "write";
  }

  private async apply(tx: Transaction, principal: Principal, command: Command, now: string): Promise<Outcome> {
    const base = { status: "applied" as const, operationId: command.operationId };
    const actorId = principal.actorId;
    switch (command.type) {
      case "project.create": {
        if (await tx.getProject()) throw new DomainError("ALREADY_EXISTS", "Project already exists");
        const project: Project = { id: command.projectId, title: command.title, createdAt: now };
        await tx.insertProject(project);
        return { result: { ...base, entityId: project.id, version: 1 }, effects: [{ kind: "project", entityId: project.id, version: 1 }] };
      }
      case "document.create": {
        if (await tx.getDocument(command.documentId)) throw new DomainError("ALREADY_EXISTS", "Document already exists");
        requireBody(command.body);
        const revisionId = this.deps.ids.next();
        const document: Document = {
          projectId: command.projectId, id: command.documentId, title: command.title,
          version: 1, currentRevisionId: revisionId, adoptedRevisionId: null,
        };
        const revision: DocumentRevision = {
          projectId: command.projectId, documentId: document.id, id: revisionId, body: command.body,
          format: "markdown", contentHash: this.deps.hasher.hash(command.body), author: actorId,
          createdAt: now, previousRevisionId: null, reason: "Initial draft",
        };
        await tx.insertDocument(document);
        await tx.insertDocumentRevision(revision);
        return { result: { ...base, entityId: document.id, version: 1, revisionId }, effects: [{ kind: "document", entityId: document.id, version: 1 }] };
      }
      case "document.revise": {
        const document = required(await tx.getDocument(command.documentId), "Document");
        requireVersion(document.version, command.expectedVersion);
        requireBody(command.body);
        const revisionId = this.deps.ids.next();
        const revision: DocumentRevision = {
          projectId: command.projectId, documentId: document.id, id: revisionId, body: command.body,
          format: "markdown", contentHash: this.deps.hasher.hash(command.body), author: actorId,
          createdAt: now, previousRevisionId: document.currentRevisionId, reason: command.reason,
        };
        await tx.insertDocumentRevision(revision);
        await tx.updateDocument({ ...document, version: document.version + 1, currentRevisionId: revisionId }, document.version);
        return { result: { ...base, entityId: document.id, version: document.version + 1, revisionId }, effects: [{ kind: "document", entityId: document.id, version: document.version + 1 }] };
      }
      case "document.adopt": {
        const document = required(await tx.getDocument(command.documentId), "Document");
        requireVersion(document.version, command.expectedVersion);
        if (document.currentRevisionId !== command.revisionId || document.adoptedRevisionId === command.revisionId) {
          throw new DomainError("NOT_CANDIDATE", "Only the current unadopted candidate can be adopted");
        }
        required(await tx.getDocumentRevision(document.id, command.revisionId), "Document revision");
        const decisionId = this.deps.ids.next();
        const decision: DocumentDecision = {
          projectId: command.projectId, id: decisionId, documentId: document.id,
          revisionId: command.revisionId, actorId, reason: command.reason, createdAt: now,
        };
        await tx.insertDocumentDecision(decision);
        await tx.updateDocument({ ...document, version: document.version + 1, adoptedRevisionId: command.revisionId }, document.version);
        const impactIds: string[] = [];
        const effects: Effect[] = [{ kind: "document", entityId: document.id, version: document.version + 1 }];
        for (const task of await tx.findTasksUsingDocument(document.id)) {
          if (task.state !== "ready") continue;
          const taskRevision = required(await tx.getTaskRevision(task.id, task.currentRevisionId), "Task revision");
          if (!taskRevision.basisSetId) continue;
          const basis = required(await tx.getBasisSet(task.id, taskRevision.id, taskRevision.basisSetId), "Basis set");
          const member = basis.members.find((item) => item.documentId === document.id);
          if (!member || member.revisionId === command.revisionId) continue;
          const superseded = (await tx.listImpacts(task.id)).filter((item) => item.documentId === document.id && item.state === "pending");
          await tx.supersedeImpacts(task.id, document.id);
          for (const old of superseded) effects.push({ kind: "impact.superseded", entityId: old.id, version: 2 });
          const impact: Impact = {
            projectId: command.projectId, id: this.deps.ids.next(), taskId: task.id,
            taskRevisionId: taskRevision.id, documentId: document.id,
            fromRevisionId: member.revisionId, toRevisionId: command.revisionId,
            state: "pending", decisionId: null, createdAt: now,
          };
          await tx.insertImpact(impact);
          impactIds.push(impact.id);
          effects.push({ kind: "impact", entityId: impact.id, version: 1 });
        }
        return { result: { ...base, entityId: document.id, version: document.version + 1, revisionId: command.revisionId, decisionId, impactIds }, effects };
      }
      case "task.propose": {
        if (await tx.getTask(command.taskId)) throw new DomainError("ALREADY_EXISTS", "Task already exists");
        if (new Set(command.documentIds).size !== command.documentIds.length) throw new DomainError("DUPLICATE_DOCUMENT", "Linked documents must be unique");
        for (const id of command.documentIds) required(await tx.getDocument(id), "Linked document");
        const revisionId = this.deps.ids.next();
        const task: Task = {
          projectId: command.projectId, id: command.taskId, version: 1, currentRevisionId: revisionId,
          title: command.title, goal: command.goal, acceptance: command.acceptance, owner: command.owner, state: "proposed",
        };
        const revision: TaskRevision = {
          projectId: command.projectId, taskId: task.id, id: revisionId, version: 1,
          title: task.title, goal: task.goal, acceptance: task.acceptance, owner: task.owner,
          state: "proposed", basisSetId: null, actorId, reason: "Initial proposal", createdAt: now,
        };
        await tx.insertTask(task);
        await tx.insertTaskRevision(revision);
        for (const documentId of command.documentIds) {
          const link: TaskDocumentLink = {
            projectId: command.projectId, id: this.deps.ids.next(), taskId: task.id,
            documentId, actorId, createdAt: now,
          };
          await tx.insertLink(link);
        }
        return { result: { ...base, entityId: task.id, version: 1, revisionId }, effects: [{ kind: "task", entityId: task.id, version: 1 }] };
      }
      case "task.accept": {
        const task = required(await tx.getTask(command.taskId), "Task");
        requireVersion(task.version, command.expectedVersion);
        if (task.state !== "proposed") throw new DomainError("INVALID_STATE", "Only proposed tasks can be accepted");
        const linked = new Set((await tx.listLinks(task.id)).map((link) => link.documentId));
        if (new Set(command.basis.map((item) => item.documentId)).size !== command.basis.length) {
          throw new DomainError("DUPLICATE_DOCUMENT", "Basis documents must be unique");
        }
        for (const member of command.basis) {
          if (!linked.has(member.documentId)) throw new DomainError("UNLINKED_DOCUMENT", "Basis document must be linked to the task");
          const document = required(await tx.getDocument(member.documentId), "Basis document");
          if (document.adoptedRevisionId !== member.revisionId) throw new DomainError("UNADOPTED_BASIS", "Basis must use the current adopted document revision");
          required(await tx.getDocumentRevision(document.id, member.revisionId), "Basis revision");
        }
        const revisionId = this.deps.ids.next();
        const basisId = this.deps.ids.next();
        const revision: TaskRevision = {
          projectId: command.projectId, taskId: task.id, id: revisionId, version: task.version + 1,
          title: task.title, goal: task.goal, acceptance: task.acceptance, owner: task.owner,
          state: "ready", basisSetId: basisId, actorId, reason: command.reason, createdAt: now,
        };
        const basis: BasisSet = { projectId: command.projectId, taskId: task.id, taskRevisionId: revisionId, id: basisId, members: command.basis, sealed: true };
        await tx.insertTaskRevision(revision);
        await tx.insertSealedBasisSet(basis);
        await tx.updateTask({ ...task, version: revision.version, currentRevisionId: revisionId, state: "ready" }, task.version);
        return { result: { ...base, entityId: task.id, version: revision.version, revisionId }, effects: [{ kind: "task", entityId: task.id, version: revision.version }] };
      }
      case "task.reviewBasis": {
        const task = required(await tx.getTask(command.taskId), "Task");
        requireVersion(task.version, command.expectedVersion);
        if (task.state !== "ready") throw new DomainError("INVALID_STATE", "Only ready, unstarted tasks can be reviewed");
        const impact = required(await tx.getImpact(command.impactId), "Impact");
        if (impact.taskId !== task.id || impact.state !== "pending" || impact.taskRevisionId !== task.currentRevisionId) {
          throw new DomainError("STALE_IMPACT", "Impact does not belong to the current ready task revision");
        }
        const document = required(await tx.getDocument(impact.documentId), "Impact document");
        if (document.adoptedRevisionId !== impact.toRevisionId) throw new DomainError("STALE_IMPACT", "Target document revision is no longer adopted");
        const previousRevision = required(await tx.getTaskRevision(task.id, task.currentRevisionId), "Task revision");
        const previousBasis = required(await tx.getBasisSet(task.id, previousRevision.id, required(previousRevision.basisSetId, "Basis set ID")), "Basis set");
        const member = previousBasis.members.find((item) => item.documentId === impact.documentId);
        if (!member || member.revisionId !== impact.fromRevisionId) throw new DomainError("STALE_IMPACT", "Current task basis has changed");
        const nextMembers = previousBasis.members.map((item) => item.documentId === impact.documentId && command.decision === "adopt"
          ? { documentId: item.documentId, revisionId: impact.toRevisionId } : { ...item });
        const revisionId = this.deps.ids.next();
        const basisId = this.deps.ids.next();
        const decisionId = this.deps.ids.next();
        const revision: TaskRevision = {
          ...previousRevision, id: revisionId, version: task.version + 1, basisSetId: basisId,
          acceptance: command.acceptance ?? task.acceptance, actorId, reason: command.reason, createdAt: now,
        };
        const basis: BasisSet = { projectId: command.projectId, taskId: task.id, taskRevisionId: revisionId, id: basisId, members: nextMembers, sealed: true };
        const decision: BasisDecision = {
          projectId: command.projectId, id: decisionId, impactId: impact.id, taskId: task.id,
          previousTaskRevisionId: previousRevision.id, nextTaskRevisionId: revisionId,
          decision: command.decision, reason: command.reason, actorId, createdAt: now,
        };
        const pending = (await tx.listImpacts(task.id)).filter((item) => item.state === "pending" && item.id !== impact.id);
        await tx.insertTaskRevision(revision);
        await tx.insertSealedBasisSet(basis);
        await tx.updateTask({ ...task, version: revision.version, currentRevisionId: revisionId, acceptance: revision.acceptance }, task.version);
        await tx.insertBasisDecision(decision);
        await tx.resolveImpact(impact.id, decisionId);
        const impactIds: string[] = [];
        const effects: Effect[] = [{ kind: "task", entityId: task.id, version: revision.version }, { kind: "impact", entityId: impact.id, version: 2 }];
        for (const other of pending) {
          await tx.supersedeImpacts(task.id, other.documentId);
          effects.push({ kind: "impact.superseded", entityId: other.id, version: 2 });
          const nextMember = nextMembers.find((item) => item.documentId === other.documentId);
          const currentDocument = required(await tx.getDocument(other.documentId), "Impact document");
          if (!nextMember || nextMember.revisionId === currentDocument.adoptedRevisionId || currentDocument.adoptedRevisionId !== other.toRevisionId) continue;
          const rebuilt: Impact = {
            ...other, id: this.deps.ids.next(), taskRevisionId: revisionId,
            fromRevisionId: nextMember.revisionId, state: "pending", decisionId: null, createdAt: now,
          };
          await tx.insertImpact(rebuilt);
          impactIds.push(rebuilt.id);
          effects.push({ kind: "impact", entityId: rebuilt.id, version: 1 });
        }
        return { result: { ...base, entityId: task.id, version: revision.version, revisionId, decisionId, impactIds }, effects };
      }
    }
  }

  private async read<T>(principal: Principal, projectId: string, action: (reader: Reader) => Promise<T>): Promise<T> {
    requirePermission(principal, projectId, "read");
    return this.deps.uow.read(projectId, async (reader) => {
      required(await reader.getProject(), "Project");
      return action(reader);
    });
  }

  getProject(principal: Principal, projectId: string): Promise<Project> {
    return this.read(principal, projectId, async (reader) => required(await reader.getProject(), "Project"));
  }
  getDocument(principal: Principal, projectId: string, documentId: string): Promise<DocumentDetail> {
    return this.read(principal, projectId, async (reader) => {
      const document = required(await reader.getDocument(documentId), "Document");
      const current = required(await reader.getDocumentRevision(documentId, document.currentRevisionId), "Current revision");
      const adopted = document.adoptedRevisionId
        ? required(await reader.getDocumentRevision(documentId, document.adoptedRevisionId), "Adopted revision") : null;
      return { document, current, adopted };
    });
  }
  getDocumentRevision(principal: Principal, projectId: string, documentId: string, revisionId: string): Promise<DocumentRevision> {
    return this.read(principal, projectId, async (reader) => required(await reader.getDocumentRevision(documentId, revisionId), "Document revision"));
  }
  getTask(principal: Principal, projectId: string, taskId: string): Promise<TaskDetail> {
    return this.read(principal, projectId, async (reader) => {
      const task = required(await reader.getTask(taskId), "Task");
      const revision = required(await reader.getTaskRevision(taskId, task.currentRevisionId), "Task revision");
      const basis = revision.basisSetId ? required(await reader.getBasisSet(taskId, revision.id, revision.basisSetId), "Basis set") : null;
      return { task, revision, basis, links: await reader.listLinks(taskId), impacts: await reader.listImpacts(taskId), decisions: await reader.listBasisDecisions(taskId) };
    });
  }
  getTaskRevision(principal: Principal, projectId: string, taskId: string, revisionId: string): Promise<{ revision: TaskRevision; basis: BasisSet | null }> {
    return this.read(principal, projectId, async (reader) => {
      const revision = required(await reader.getTaskRevision(taskId, revisionId), "Task revision");
      const basis = revision.basisSetId
        ? required(await reader.getBasisSet(taskId, revision.id, revision.basisSetId), "Basis set") : null;
      return { revision, basis };
    });
  }
  listTasks(principal: Principal, projectId: string, limit?: number, cursor?: string): Promise<Page<Task>> {
    return this.read(principal, projectId, (reader) => reader.listTasks(pageLimit(limit), cursor));
  }
  listDocuments(principal: Principal, projectId: string, limit?: number, cursor?: string): Promise<Page<Document>> {
    return this.read(principal, projectId, (reader) => reader.listDocuments(pageLimit(limit), cursor));
  }
  listImpacts(principal: Principal, projectId: string, taskId?: string): Promise<Impact[]> {
    return this.read(principal, projectId, (reader) => reader.listImpacts(taskId));
  }
  getOperation(principal: Principal, projectId: string, operationId: string): Promise<Operation | null> {
    return this.read(principal, projectId, async (reader) => {
      const operation = await reader.getOperation(operationId);
      if (operation && operation.actorId !== principal.actorId) throw new DomainError("FORBIDDEN", "Operation belongs to another actor");
      return operation;
    });
  }
}
