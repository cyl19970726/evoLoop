import { commandSchema } from "@evoloop/contracts";
import type {
  AppliedResult, BasisDecision, BasisSet, Command, CommandResult, Document, DocumentDecision,
  DocumentDetail, DocumentRevision, Impact, Operation, OutboxEvent, Page, Principal, Project,
  Task, TaskDetail, TaskDocumentLink, TaskRevision,
} from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { applyWorkflow } from "./workflow.js";
import { reserveRuntime } from "./runtime/reserve.js";
import { validateDispatchBasis } from "./runtime/basis.js";
import { applyRole, RoleRuleError } from "./roles/index.js";
import { applySchedule } from "./scheduling/commands.js";
import { applyDiscussion } from "./discussions.js";
import type { ScheduleCommand } from "@evoloop/contracts/scheduling";
export { RuntimeWorkflowService } from "./runtime/service.js";
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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function requireAssignableOwner(tx: Transaction, owner: string): Promise<void> {
  if (!uuid.test(owner)) return; // A temporary responsibility need not be a persistent Role.
  const role = await tx.getRole(owner);
  if (role?.state === "retired") throw new DomainError("ROLE_RETIRED", "retired role cannot receive new work");
}

function requireVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new DomainError("VERSION_CONFLICT", "The observed version is no longer current", actual);
}

function requireBody(body: string): void {
  if (new TextEncoder().encode(body).byteLength > 65536) {
    throw new DomainError("BODY_TOO_LARGE", "Markdown body exceeds 65536 UTF-8 bytes");
  }
}

async function requireNoInflightRun(tx: Transaction, taskId: string): Promise<void> {
  if ((await tx.listRuntimeRuns(taskId)).some(run => ["requested", "dispatching", "running", "unknown"].includes(run.state))) {
    throw new DomainError("TASK_BUSY", "Resolve the current or uncertain run before changing this task");
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
    return command.type === "document.adopt" || command.type === "document.publish" || command.type === "document.archive" || command.type === "document.restore" || command.type === "task.start" || command.type === "task.reviewBasis" || command.type === "task.close" || command.type === "task.cancel" || command.type === "task.reopen" || command.type === "stage.accept" || command.type === "stage.review" || command.type === "stage.review.correct" || command.type === "runtime.session.reserve" || command.type === "runtime.run.reserve" || (command.type === "runtime.run.interrupt" || command.type === "runtime.run.abandonReadOnly") || command.type.startsWith("schedule.") || command.type.startsWith("role.") && command.type !== "role.propose" || command.type === "discussion.decision.record" || command.type === "discussion.action.link"
      ? "review" : "write";
  }

  private async apply(tx: Transaction, principal: Principal, command: Command, now: string): Promise<Outcome> {
    const base = { status: "applied" as const, operationId: command.operationId };
    const actorId = principal.actorId;
    if (command.type === "task.create" || command.type === "task.update") await requireAssignableOwner(tx, command.owner);
    if (command.type === "task.start") await requireAssignableOwner(tx, required(await tx.getTask(command.taskId), "Task").owner);
    if (command.type === "runtime.session.reserve") await requireAssignableOwner(tx, command.roleId);
    if (command.type === "schedule.create" || command.type === "schedule.revise") await requireAssignableOwner(tx, command.template.owner);
    switch (command.type) {
      case "project.create": {
        if (await tx.getProject()) throw new DomainError("ALREADY_EXISTS", "Project already exists");
        const project: Project = { id: command.projectId, title: command.title, createdAt: now };
        await tx.insertProject(project);
        return { result: { ...base, entityId: project.id, version: 1 }, effects: [{ kind: "project", entityId: project.id, version: 1 }] };
      }
      case "document.create": {
        if (await tx.getDocument(command.documentId)) throw new DomainError("ALREADY_EXISTS", "Document already exists");
        if (command.kind === "task") throw new DomainError("TASK_CONTENT_OWNED", "Task documents are created through task.create");
        requireBody(command.body);
        const revisionId = this.deps.ids.next();
        const document: Document = {
          projectId: command.projectId, id: command.documentId, title: command.title,
          version: 1, currentRevisionId: revisionId, adoptedRevisionId: null,
          kind: command.kind ?? null, status: "draft",
        };
        const revision: DocumentRevision = {
          projectId: command.projectId, documentId: document.id, id: revisionId, body: command.body,
          format: "markdown", mediaType: "text/markdown", originalName: `${document.id}.md`, payloadRef: null,
          entrypoint: null, assetsManifest: [], contentHash: this.deps.hasher.hash(command.body), author: actorId,
          createdAt: now, previousRevisionId: null, reason: "Initial draft",
        };
        await tx.insertDocument(document);
        await tx.insertDocumentRevision(revision);
        return { result: { ...base, entityId: document.id, version: 1, revisionId }, effects: [{ kind: "document", entityId: document.id, version: 1 }] };
      }
      case "document.revise": {
        const document = required(await tx.getDocument(command.documentId), "Document");
        requireVersion(document.version, command.expectedVersion);
        if (document.kind === "task") throw new DomainError("TASK_CONTENT_OWNED", "Task content must be changed through task.update");
        if (document.status === "archived") throw new DomainError("DOCUMENT_ARCHIVED", "Restore the document before revision");
        const previous = required(await tx.getDocumentRevision(document.id, document.currentRevisionId), "Document revision");
        if (previous.format !== "markdown") throw new DomainError("FORMAT_CHANGE_REQUIRES_PAYLOAD", "HTML revisions require the payload workflow");
        requireBody(command.body);
        const revisionId = this.deps.ids.next();
        const revision: DocumentRevision = {
          projectId: command.projectId, documentId: document.id, id: revisionId, body: command.body,
          format: "markdown", mediaType: "text/markdown", originalName: `${document.id}.md`, payloadRef: null,
          entrypoint: null, assetsManifest: [], contentHash: this.deps.hasher.hash(command.body), author: actorId,
          createdAt: now, previousRevisionId: document.currentRevisionId, reason: command.reason,
        };
        await tx.insertDocumentRevision(revision);
        await tx.updateDocument({ ...document, version: document.version + 1, currentRevisionId: revisionId }, document.version);
        return { result: { ...base, entityId: document.id, version: document.version + 1, revisionId }, effects: [{ kind: "document", entityId: document.id, version: document.version + 1 }] };
      }
      case "document.adopt":
      case "document.publish": {
        const document = required(await tx.getDocument(command.documentId), "Document");
        requireVersion(document.version, command.expectedVersion);
        if (document.kind === "task") throw new DomainError("TASK_CONTENT_OWNED", "Task content is published through task.start");
        if (document.status === "archived") throw new DomainError("DOCUMENT_ARCHIVED", "Restore the document before publishing");
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
        await tx.updateDocument({ ...document, status: "published", version: document.version + 1, adoptedRevisionId: command.revisionId }, document.version);
        const impactIds: string[] = [];
        const effects: Effect[] = [{ kind: "document", entityId: document.id, version: document.version + 1 }];
        for (const task of await tx.findTasksUsingDocument(document.id)) {
          if (task.state !== "in_progress") continue;
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
      case "document.archive":
      case "document.restore": {
        const document = required(await tx.getDocument(command.documentId), "Document");
        requireVersion(document.version, command.expectedVersion);
        if (document.kind === "task") throw new DomainError("TASK_CONTENT_OWNED", "Task document lifecycle follows its Task");
        const next = command.type === "document.archive" ? "archived" : document.adoptedRevisionId ? "published" : "draft";
        if (document.status === next || command.type === "document.restore" && document.status !== "archived")
          throw new DomainError("INVALID_STATE", "Document is not in the required state");
        await tx.updateDocument({ ...document, status: next, version: document.version + 1 }, document.version);
        return { result: { ...base, entityId: document.id, version: document.version + 1 },
          effects: [{ kind: "document", entityId: document.id, version: document.version + 1 }] };
      }
      case "task.create": {
        if (await tx.getTask(command.taskId)) throw new DomainError("ALREADY_EXISTS", "Task already exists");
        requireBody(command.content);
        const documentIds = command.documentIds ?? [];
        if (new Set(documentIds).size !== documentIds.length) throw new DomainError("DUPLICATE_DOCUMENT", "Linked documents must be unique");
        if (command.stageId) {
          const stage = required(await tx.getStage(command.stageId), "Stage");
          if (stage.state !== "active") throw new DomainError("INVALID_STAGE", "Stage task requires an active stage");
          if (!command.consumer || !command.evidence || !command.stopCondition) throw new DomainError("INCOMPLETE_PROPOSAL", "Stage task needs consumer, evidence and stop condition");
        }
        for (const id of documentIds) required(await tx.getDocument(id), "Linked document");
        const revisionId = this.deps.ids.next();
        const documentId = this.deps.ids.next();
        const contentRevisionId = this.deps.ids.next();
        const document: Document = { projectId: command.projectId, id: documentId, title: command.title,
          kind: "task", status: "draft", version: 1, currentRevisionId: contentRevisionId, adoptedRevisionId: null };
        const contentRevision: DocumentRevision = { projectId: command.projectId, documentId, id: contentRevisionId,
          body: command.content, format: "markdown", mediaType: "text/markdown", originalName: `${documentId}.md`,
          payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: this.deps.hasher.hash(command.content),
          author: actorId, createdAt: now, previousRevisionId: null, reason: "Initial task content" };
        const task: Task = { projectId: command.projectId, id: command.taskId, version: 1,
          currentRevisionId: revisionId, title: command.title, content: command.content,
          contentDocumentId: documentId, contentRevisionId, kind: command.kind ?? null,
          acceptance: command.acceptance, owner: command.owner, state: "todo" };
        const revision: TaskRevision = { projectId: command.projectId, taskId: task.id, id: revisionId,
          version: 1, title: task.title, content: task.content, contentDocumentId: documentId,
          contentRevisionId, kind: task.kind, acceptance: task.acceptance, owner: task.owner,
          state: "todo", basisSetId: null, actorId, reason: "Initial task", createdAt: now };
        await tx.insertDocument(document);
        await tx.insertDocumentRevision(contentRevision);
        await tx.insertTask(task);
        await tx.insertTaskRevision(revision);
        if (command.stageId || command.consumer || command.evidence || command.stopCondition || command.useRequired !== undefined) {
          await tx.insertTaskProposal({ projectId: command.projectId, taskId: task.id, taskRevisionId: revisionId,
            stageId: command.stageId ?? null, consumer: command.consumer ?? "", useRequired: command.useRequired ?? false,
            evidence: command.evidence ?? "", stopCondition: command.stopCondition ?? "", createdAt: now });
        }
        for (const linkedId of documentIds) await tx.insertLink({ projectId: command.projectId, id: this.deps.ids.next(),
          taskId: task.id, documentId: linkedId, actorId, createdAt: now });
        return { result: { ...base, entityId: task.id, version: 1, revisionId }, effects: [
          { kind: "task", entityId: task.id, version: 1 }, { kind: "document", entityId: documentId, version: 1 }] };
      }
      case "task.update": {
        const task = required(await tx.getTask(command.taskId), "Task");
        requireVersion(task.version, command.expectedVersion);
        if (task.state === "done" || task.state === "cancelled") throw new DomainError("INVALID_STATE", "Reopen the Task before changing it");
        await requireNoInflightRun(tx, task.id);
        requireBody(command.content);
        const documentIds = command.documentIds ?? (await tx.listLinks(task.id)).map(link => link.documentId);
        if (new Set(documentIds).size !== documentIds.length || documentIds.includes(task.contentDocumentId))
          throw new DomainError("DUPLICATE_DOCUMENT", "Linked documents must be unique and exclude the primary document");
        const linked = (await tx.listLinks(task.id)).map(link => link.documentId);
        if (linked.some(id => !documentIds.includes(id))) throw new DomainError("LINK_REMOVAL_UNSUPPORTED", "Existing document links cannot be removed by task.update");
        for (const id of documentIds) required(await tx.getDocument(id), "Linked document");
        const prior = required(await tx.getTaskRevision(task.id, task.currentRevisionId), "Task revision");
        const priorProposal = await tx.getTaskProposal(task.id);
        const contentChanged = task.content !== command.content;
        const kind = command.kind === undefined ? task.kind : command.kind;
        if (task.state === "in_progress" && (contentChanged || task.acceptance !== command.acceptance ||
          task.owner !== command.owner || task.kind !== kind || linked.length !== documentIds.length ||
          command.consumer !== undefined && command.consumer !== priorProposal?.consumer ||
          command.useRequired !== undefined && command.useRequired !== priorProposal?.useRequired ||
          command.evidence !== undefined && command.evidence !== priorProposal?.evidence ||
          command.stopCondition !== undefined && command.stopCondition !== priorProposal?.stopCondition))
          throw new DomainError("REOPEN_REQUIRED", "Return the Task to todo before changing its execution scope");
        const revisionId = this.deps.ids.next();
        let contentRevisionId = task.contentRevisionId;
        let contentDocumentVersion: number | null = null;
        if (contentChanged) {
          const doc = required(await tx.getDocument(task.contentDocumentId), "Primary task document");
          if (doc.kind !== "task" || doc.currentRevisionId !== task.contentRevisionId)
            throw new DomainError("CONTENT_BASELINE_CHANGED", "Primary document changed outside the Task revision");
          contentRevisionId = this.deps.ids.next();
          const nextContent: DocumentRevision = { projectId: task.projectId, documentId: doc.id, id: contentRevisionId,
            body: command.content, format: "markdown", mediaType: "text/markdown", originalName: `${doc.id}.md`,
            payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: this.deps.hasher.hash(command.content),
            author: actorId, createdAt: now, previousRevisionId: doc.currentRevisionId, reason: command.reason };
          await tx.insertDocumentRevision(nextContent);
          contentDocumentVersion = doc.version + 1;
          await tx.updateDocument({ ...doc, version: contentDocumentVersion, currentRevisionId: contentRevisionId,
            status: doc.adoptedRevisionId ? "published" : "draft", title: command.title }, doc.version);
        }
        const basisSetId = prior.basisSetId ? this.deps.ids.next() : null;
        const revision: TaskRevision = { ...prior, id: revisionId, version: task.version + 1, title: command.title,
          content: command.content, contentRevisionId, kind, acceptance: command.acceptance, owner: command.owner,
          basisSetId, actorId, reason: command.reason, createdAt: now };
        await tx.insertTaskRevision(revision);
        if (basisSetId && prior.basisSetId) {
          const basis = required(await tx.getBasisSet(task.id, prior.id, prior.basisSetId), "Basis set");
          await tx.insertSealedBasisSet({ ...basis, id: basisSetId, taskRevisionId: revisionId,
            members: basis.members.map(member => member.documentId === task.contentDocumentId
              ? { documentId: member.documentId, revisionId: contentRevisionId } : { ...member }) });
        }
        await tx.updateTask({ ...task, version: revision.version, currentRevisionId: revisionId,
          title: revision.title, content: revision.content, contentRevisionId, kind, acceptance: revision.acceptance,
          owner: revision.owner }, task.version);
        if (priorProposal || command.consumer || command.evidence || command.stopCondition || command.useRequired !== undefined) {
          await tx.insertTaskProposal({ projectId: task.projectId, taskId: task.id, taskRevisionId: revisionId,
            stageId: priorProposal?.stageId ?? null, consumer: command.consumer ?? priorProposal?.consumer ?? "",
            useRequired: command.useRequired ?? priorProposal?.useRequired ?? false,
            evidence: command.evidence ?? priorProposal?.evidence ?? "",
            stopCondition: command.stopCondition ?? priorProposal?.stopCondition ?? "", createdAt: now });
        }
        for (const id of documentIds.filter(id => !linked.includes(id))) await tx.insertLink({ projectId: task.projectId,
          id: this.deps.ids.next(), taskId: task.id, documentId: id, actorId, createdAt: now });
        return { result: { ...base, entityId: task.id, version: revision.version, revisionId },
          effects: [{ kind: "task", entityId: task.id, version: revision.version },
            ...(contentDocumentVersion === null ? [] : [{ kind: "document", entityId: task.contentDocumentId, version: contentDocumentVersion }])] };
      }
      case "task.start": {
        const task = required(await tx.getTask(command.taskId), "Task");
        requireVersion(task.version, command.expectedVersion);
        if (task.state !== "todo") throw new DomainError("INVALID_STATE", "Only a todo Task may start");
        await requireNoInflightRun(tx, task.id);
        const proposal = await tx.getTaskProposal(task.id);
        if (proposal?.stageId && (await tx.getStage(proposal.stageId))?.state !== "active")
          throw new DomainError("INVALID_STAGE", "Task stage is no longer active");
        const main = required(await tx.getDocument(task.contentDocumentId), "Primary task document");
        if (main.kind !== "task" || main.currentRevisionId !== task.contentRevisionId || main.status === "archived")
          throw new DomainError("CONTENT_BASELINE_CHANGED", "Primary content does not match Task revision");
        required(await tx.getDocumentRevision(main.id, task.contentRevisionId), "Primary content revision");
        const linked = new Set((await tx.listLinks(task.id)).map(link => link.documentId));
        const prior = required(await tx.getTaskRevision(task.id, task.currentRevisionId), "Task revision");
        const inherited = prior.basisSetId ? required(await tx.getBasisSet(task.id, prior.id, prior.basisSetId), "Basis set") : null;
        const extras = command.basis ?? inherited?.members.filter(item => item.documentId !== main.id) ?? [];
        if (extras.length > 19) throw new DomainError("BASIS_LIMIT", "Select at most 19 extra sources alongside the primary content");
        if (new Set(extras.map(item => item.documentId)).size !== extras.length || extras.some(item => item.documentId === main.id))
          throw new DomainError("DUPLICATE_DOCUMENT", "Basis must use distinct linked documents; primary is automatic");
        for (const item of extras) {
          if (!linked.has(item.documentId)) throw new DomainError("UNLINKED_DOCUMENT", "Basis document must be linked to the Task");
          const doc = required(await tx.getDocument(item.documentId), "Basis document");
          if (!doc.adoptedRevisionId)
            throw new DomainError("UNPUBLISHED_BASIS", "Basis must pin a published document revision");
          required(await tx.getDocumentRevision(doc.id, item.revisionId), "Basis revision");
        }
        await validateDispatchBasis(tx, task.id, { projectId: task.projectId, taskId: task.id,
          taskRevisionId: prior.id, id: prior.basisSetId ?? main.id, members: extras, sealed: true });
        if ((await tx.listImpacts(task.id)).some(item => item.state === "pending"))
          throw new DomainError("PENDING_BASIS_REVIEW", "Resolve source changes before starting work");
        let documentVersion = main.version;
        if (main.adoptedRevisionId !== task.contentRevisionId || main.status !== "published") {
          const decisionId = this.deps.ids.next();
          await tx.insertDocumentDecision({ projectId: task.projectId, id: decisionId, documentId: main.id,
            revisionId: task.contentRevisionId, actorId, reason: command.reason, createdAt: now });
          documentVersion++;
          await tx.updateDocument({ ...main, status: "published", adoptedRevisionId: task.contentRevisionId,
            version: documentVersion }, main.version);
        }
        const revisionId = this.deps.ids.next();
        const basisSetId = this.deps.ids.next();
        const revision: TaskRevision = { ...prior, id: revisionId, version: task.version + 1, state: "in_progress",
          basisSetId, actorId, reason: command.reason, createdAt: now };
        const basis: BasisSet = { projectId: task.projectId, taskId: task.id, taskRevisionId: revisionId,
          id: basisSetId, sealed: true,
          members: [{ documentId: main.id, revisionId: task.contentRevisionId }, ...extras] };
        await tx.insertTaskRevision(revision);
        await tx.insertSealedBasisSet(basis);
        await tx.updateTask({ ...task, version: revision.version, currentRevisionId: revisionId,
          state: "in_progress" }, task.version);
        return { result: { ...base, entityId: task.id, version: revision.version, revisionId }, effects: [
          { kind: "task", entityId: task.id, version: revision.version },
          { kind: "document", entityId: main.id, version: documentVersion }] };
      }
      case "task.reviewBasis": {
        const task = required(await tx.getTask(command.taskId), "Task");
        requireVersion(task.version, command.expectedVersion);
        if (task.state !== "in_progress") throw new DomainError("INVALID_STATE", "Only in-progress tasks can review changed basis");
        await requireNoInflightRun(tx, task.id);
        const impact = required(await tx.getImpact(command.impactId), "Impact");
        if (impact.taskId !== task.id || impact.state !== "pending" || impact.taskRevisionId !== task.currentRevisionId) {
          throw new DomainError("STALE_IMPACT", "Impact does not belong to the current task revision");
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
      case "role.propose":
      case "role.decide":
      case "role.review":
      case "role.handoff":
      case "role.ackHandoff":
      case "role.bindSession":
      case "role.retire": {
          try {
            const result = await applyRole(tx, principal, command, { nowUtc: now, nextId: () => this.deps.ids.next() });
            return { result: { ...base, ...result }, effects: [{ kind: "role", entityId: result.entityId, version: result.version }] };
          } catch (error) {
            if (error instanceof RoleRuleError) throw new DomainError(error.code, error.message, error.currentVersion);
            throw error;
          }
      }
      default:
        if (command.type === "discussion.prepare" || command.type === "discussion.handoff.record" || command.type === "discussion.decision.record" || command.type === "discussion.action.link") {
          return applyDiscussion({ tx, command, principal, now, nextId: () => this.deps.ids.next(), hasher: this.deps.hasher });
        }
        if (command.type === "schedule.create" || command.type === "schedule.revise") {
          return applySchedule(tx, principal, command as ScheduleCommand, now);
        }
        if (command.type === "runtime.session.reserve" || command.type === "runtime.run.reserve" || command.type === "runtime.handoff.record" || (command.type === "runtime.run.interrupt" || command.type === "runtime.run.abandonReadOnly")) {
          return reserveRuntime({ tx, command, principal, now, nextId: () => this.deps.ids.next(), hash: value => this.deps.hasher.hash(value) });
        }
        return applyWorkflow({ tx, command, principal, now, nextId: () => this.deps.ids.next() }).then(outcome => ({ ...outcome, effects: outcome.effects.map(effect => ({ ...effect, kind: effect.kind === "workflow" ? command.type : effect.kind })) }));
    }
  }

  private async read<T>(principal: Principal, projectId: string, action: (reader: Reader) => Promise<T>): Promise<T> {
    requirePermission(principal, projectId, "read");
    return this.deps.uow.read(projectId, async (reader) => {
      required(await reader.getProject(), "Project");
      return action(reader);
    });
  }

  getDiscussion(principal: Principal, projectId: string, id: string): Promise<import("@evoloop/contracts").DiscussionRecord> {
    return this.read(principal, projectId, async reader => required(await reader.getDiscussion(id), "Discussion"));
  }
  listDiscussions(principal: Principal, projectId: string, limit = 50, cursor?: string): Promise<Page<import("@evoloop/contracts").DiscussionRecord>> {
    return this.read(principal, projectId, reader => reader.listDiscussions(pageLimit(limit), cursor));
  }
  listDiscussionEvents(principal: Principal, projectId: string, id: string): Promise<import("@evoloop/contracts").DiscussionEvent[]> {
    return this.read(principal, projectId, async reader => {
      required(await reader.getDiscussion(id), "Discussion");
      return reader.listDiscussionEvents(id);
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
      return { task, revision, basis, links: await reader.listLinks(taskId), impacts: await reader.listImpacts(taskId), decisions: await reader.listBasisDecisions(taskId), proposal: await reader.getTaskProposal(taskId), judgements: await reader.listTaskJudgements(taskId), deliveries: await reader.listDeliveries(taskId), observations: await reader.listObservations(taskId), closures: await reader.listTaskClosures(taskId) };
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
  listTaskRevisions(principal: Principal, projectId: string, taskId: string): Promise<Array<{ revision: TaskRevision; basis: BasisSet | null }>> {
    return this.read(principal, projectId, async reader => {
      required(await reader.getTask(taskId), "Task");
      const revisions = await reader.listTaskRevisions(taskId);
      return Promise.all(revisions.map(async revision => ({ revision,
        basis: revision.basisSetId
          ? required(await reader.getBasisSet(taskId, revision.id, revision.basisSetId), "Basis set") : null,
      })));
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
  getGoal(principal: Principal, projectId: string, goalId: string) { return this.read(principal, projectId, reader => Promise.resolve(reader.getGoal(goalId)).then(goal => required(goal,"Goal"))); }
  listGoals(principal: Principal, projectId: string, limit?: number, cursor?: string) { return this.read(principal, projectId, reader => reader.listGoals(pageLimit(limit), cursor)); }
  listGoalRevisions(principal: Principal, projectId: string, goalId: string) { return this.read(principal, projectId, async reader => { required(await reader.getGoal(goalId),"Goal"); return reader.listGoalRevisions(goalId); }); }
  getStage(principal: Principal, projectId: string, stageId: string) { return this.read(principal, projectId, reader => Promise.resolve(reader.getStage(stageId)).then(stage => required(stage,"Stage"))); }
  listStages(principal: Principal, projectId: string, goalId?: string) { return this.read(principal, projectId, reader => reader.listStages(goalId)); }
  listStageRevisions(principal: Principal, projectId: string, stageId: string) { return this.read(principal, projectId, async reader => { required(await reader.getStage(stageId),"Stage"); return reader.listStageRevisions(stageId); }); }
  listStageReviews(principal: Principal, projectId: string, stageId: string) { return this.read(principal, projectId, async reader => { required(await reader.getStage(stageId),"Stage"); return reader.listStageReviews(stageId); }); }
  getRuntimeSession(principal: Principal, projectId: string, sessionId: string) { return this.read(principal, projectId, async reader => required(await reader.getRuntimeSession(sessionId), "Runtime session")); }
  listRuntimeSessions(principal: Principal, projectId: string) { return this.read(principal, projectId, reader => reader.listRuntimeSessions()); }
  getRuntimeRun(principal: Principal, projectId: string, runId: string) { return this.read(principal, projectId, async reader => required(await reader.getRuntimeRun(runId), "Runtime run")); }
  listRuntimeRuns(principal: Principal, projectId: string, taskId?: string) { return this.read(principal, projectId, reader => reader.listRuntimeRuns(taskId)); }
  listRuntimeEvents(principal: Principal, projectId: string, runId: string) { return this.read(principal, projectId, async reader => { required(await reader.getRuntimeRun(runId), "Runtime run"); return reader.listRuntimeEvents(runId); }); }
  listRuntimeSessionEvents(principal: Principal, projectId: string, sessionId: string) { return this.read(principal, projectId, async reader => { required(await reader.getRuntimeSession(sessionId), "Runtime session"); return reader.listRuntimeSessionEvents(sessionId); }); }
  getRole(principal: Principal, projectId: string, roleId: string) { return this.read(principal, projectId, async reader => required(await reader.getRole(roleId), "Role")); }
  listRoles(principal: Principal, projectId: string, limit = 50, cursor?: string) { return this.read(principal, projectId, reader => reader.listRoles(pageLimit(limit), cursor)); }
  listRoleRevisions(principal: Principal, projectId: string, roleId: string) { return this.read(principal, projectId, async reader => { required(await reader.getRole(roleId), "Role"); return reader.listRevisions(roleId); }); }
  listRoleReviews(principal: Principal, projectId: string, roleId: string) { return this.read(principal, projectId, async reader => { required(await reader.getRole(roleId), "Role"); return reader.listReviews(roleId); }); }
  listRoleHandoffs(principal: Principal, projectId: string, roleId: string) { return this.read(principal, projectId, async reader => { required(await reader.getRole(roleId), "Role"); return reader.listHandoffs(roleId); }); }
  listRoleSessionBindings(principal: Principal, projectId: string, roleId: string) { return this.read(principal, projectId, async reader => { required(await reader.getRole(roleId), "Role"); return reader.listSessionBindings(roleId); }); }
  getSchedule(principal: Principal, projectId: string, scheduleId: string) { return this.read(principal, projectId, async reader => required(await reader.getSchedule(scheduleId), "Schedule")); }
  listSchedules(principal: Principal, projectId: string) { return this.read(principal, projectId, reader => reader.listSchedules()); }
  listScheduleRevisions(principal: Principal, projectId: string, scheduleId: string) { return this.read(principal, projectId, async reader => { required(await reader.getSchedule(scheduleId), "Schedule"); return reader.listScheduleRevisions(scheduleId); }); }
  listScheduleOccurrences(principal: Principal, projectId: string, scheduleId: string) { return this.read(principal, projectId, async reader => { required(await reader.getSchedule(scheduleId), "Schedule"); return reader.listOccurrences(scheduleId); }); }
  getDocumentPayloadRevision(principal: Principal, projectId: string, documentId: string, revisionId: string) { return this.read(principal, projectId, async reader => required(await reader.getDocumentPayloadRevision(documentId, revisionId), "Document payload revision")); }
  listDocumentAssets(principal: Principal, projectId: string, documentId: string, revisionId: string) { return this.read(principal, projectId, async reader => { required(await reader.getDocumentPayloadRevision(documentId, revisionId), "Document payload revision"); return reader.listDocumentAssets(documentId, revisionId); }); }
  getRegisteredBlob(principal: Principal, projectId: string, blobId: string) { return this.read(principal, projectId, async reader => required(await reader.getRegisteredBlob(blobId), "Registered blob")); }
  getGitSourceRef(principal: Principal, projectId: string, refId: string) { return this.read(principal, projectId, async reader => required(await reader.getGitSourceRef(refId), "Git source reference")); }
}
