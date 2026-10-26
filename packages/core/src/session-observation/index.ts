import type { Principal } from "@evoloop/contracts";
import { DomainError, type Reader, type UnitOfWork } from "@evoloop/contracts/ports";
import type { SessionActivityPage, SessionChanges, SessionDirectory, SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { SessionAssignmentPage, SessionProfileRecord, TaskSessionAssignment } from "@evoloop/contracts/session-assignments";

type DirectoryOptions = { limit: number; cursor?: string; search?: string; membership?: string };
type HistoryOptions = { limit: number; cursor?: string; taskId?: string; importance?: "important" | "all" };
type ChangesOptions = { cursor: string; limit: number; key?: string };
const requireRead = (principal: Principal, projectId: string): void => {
  if (!principal.actorId || !principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
    throw new DomainError("FORBIDDEN", "Project read access is required");
};
/** Stable principal scope for a single observation read. It never grants authority by itself. */
const scopeOf = (principal: Principal): string => JSON.stringify({ actorId: principal.actorId,
  permissions: [...new Set(principal.permissions)].sort() });

export class SessionObservationService {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  private async read<T>(principal: Principal, projectId: string, action: (reader: Reader) => Promise<T>): Promise<T> {
    requireRead(principal, projectId);
    return this.deps.uow.read(projectId, async reader => {
      if (!await reader.getProject()) throw new DomainError("NOT_FOUND", "Project was not found");
      return action(reader);
    });
  }
  private observer(reader: Reader, principal: Principal) {
    const observer = reader.sessionObservation?.(scopeOf(principal));
    if (!observer) throw new DomainError("CAPABILITY_UNAVAILABLE", "Session observation is unavailable");
    return observer;
  }
  private assignments(reader: Reader) {
    const assignments = reader.sessionAssignments;
    if (!assignments) throw new DomainError("CAPABILITY_UNAVAILABLE", "Session assignment storage is unavailable");
    return assignments;
  }
  async directory(principal: Principal, projectId: string, options: DirectoryOptions): Promise<SessionDirectory> {
    return this.read(principal, projectId, reader => this.observer(reader, principal).directory(options));
  }
  async snapshot(principal: Principal, projectId: string, key: string): Promise<SessionSnapshot> {
    return this.read(principal, projectId, async reader => {
      const snapshot = await this.observer(reader, principal).snapshot(key);
      if (!snapshot) throw new DomainError("NOT_FOUND", "Session was not found");
      return snapshot;
    });
  }
  async history(principal: Principal, projectId: string, key: string, options: HistoryOptions): Promise<SessionActivityPage> {
    return this.read(principal, projectId, async reader => {
      const page = await this.observer(reader, principal).history(key, options);
      if (!page) throw new DomainError("NOT_FOUND", "Session was not found");
      return page;
    });
  }
  async changes(principal: Principal, projectId: string, options: ChangesOptions): Promise<SessionChanges> {
    return this.read(principal, projectId, reader => this.observer(reader, principal).changes(options));
  }
  async profile(principal: Principal, projectId: string, key: string): Promise<SessionProfileRecord | null> {
    return this.read(principal, projectId, async reader => {
      const snapshot = await this.observer(reader, principal).snapshot(key);
      if (!snapshot) throw new DomainError("NOT_FOUND", "Session was not found");
      return this.assignments(reader).getSessionProfile(snapshot.session.target);
    });
  }
  async profileHistory(principal: Principal, projectId: string, key: string, limit: number,
    cursor?: string): Promise<SessionAssignmentPage<SessionProfileRecord>> {
    return this.read(principal, projectId, async reader => {
      const snapshot = await this.observer(reader, principal).snapshot(key);
      if (!snapshot) throw new DomainError("NOT_FOUND", "Session was not found");
      return this.assignments(reader).listSessionProfileHistory(snapshot.session.target, limit, cursor);
    });
  }
  async assignment(principal: Principal, projectId: string, taskId: string): Promise<TaskSessionAssignment | null> {
    return this.read(principal, projectId, async reader => {
      const task = await reader.getTask(taskId);
      if (!task || task.projectId !== projectId) throw new DomainError("NOT_FOUND", "Task was not found");
      return this.assignments(reader).getTaskSessionAssignment(taskId);
    });
  }
  async assignmentHistory(principal: Principal, projectId: string, taskId: string, limit: number,
    cursor?: string): Promise<SessionAssignmentPage<TaskSessionAssignment>> {
    return this.read(principal, projectId, async reader => {
      const task = await reader.getTask(taskId);
      if (!task || task.projectId !== projectId) throw new DomainError("NOT_FOUND", "Task was not found");
      return this.assignments(reader).listTaskSessionAssignmentHistory(taskId, limit, cursor);
    });
  }
}
