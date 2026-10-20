import type { BasisDecision, BasisSet, Document, DocumentDecision, DocumentRevision, Impact, Operation, OutboxEvent, Page, Project, Task, TaskDocumentLink, TaskRevision } from "./index.js";

// Persistence ports are a separate export; browser clients never import driver or transaction types.
export interface Reader {
  getProject(): Promise<Project | null>;
  getDocument(id: string): Promise<Document | null>;
  getDocumentRevision(documentId: string, revisionId: string): Promise<DocumentRevision | null>;
  listDocuments(limit: number, cursor?: string): Promise<Page<Document>>;
  getTask(id: string): Promise<Task | null>;
  getTaskRevision(taskId: string, revisionId: string): Promise<TaskRevision | null>;
  getBasisSet(taskId: string, taskRevisionId: string, basisSetId: string): Promise<BasisSet | null>;
  listTasks(limit: number, cursor?: string): Promise<Page<Task>>;
  listLinks(taskId: string): Promise<TaskDocumentLink[]>;
  getImpact(id: string): Promise<Impact | null>;
  listImpacts(taskId?: string): Promise<Impact[]>;
  listBasisDecisions(taskId: string): Promise<BasisDecision[]>;
  getOperation(id: string): Promise<Operation | null>;
  findTasksUsingDocument(documentId: string): Promise<Task[]>;
}
export interface Transaction extends Reader {
  savepoint<T>(action: () => Promise<T>): Promise<T>;
  insertProject(project: Project): Promise<void>;
  insertDocument(document: Document): Promise<void>;
  insertDocumentRevision(revision: DocumentRevision): Promise<void>;
  insertDocumentDecision(decision: DocumentDecision): Promise<void>;
  updateDocument(document: Document, expectedVersion: number): Promise<void>;
  insertTask(task: Task): Promise<void>;
  insertTaskRevision(revision: TaskRevision): Promise<void>;
  insertSealedBasisSet(basis: BasisSet): Promise<void>;
  updateTask(task: Task, expectedVersion: number): Promise<void>;
  insertLink(link: TaskDocumentLink): Promise<void>;
  insertImpact(impact: Impact): Promise<void>;
  resolveImpact(id: string, decisionId: string): Promise<void>;
  supersedeImpacts(taskId: string, documentId: string): Promise<void>;
  insertBasisDecision(decision: BasisDecision): Promise<void>;
  insertOperation(operation: Operation): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<void>;
}
export interface UnitOfWork {
  // One transaction/client, serializes commands per project; reads use a consistent snapshot.
  transaction<T>(projectId: string, action: (tx: Transaction) => Promise<T>): Promise<T>;
  read<T>(projectId: string, action: (reader: Reader) => Promise<T>): Promise<T>;
}
export interface Clock { now(): string }
export interface IdFactory { next(): string }
export interface ContentHasher { hash(value: string): string }
export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly currentVersion?: number) {
    super(message); this.name = "DomainError";
  }
}
