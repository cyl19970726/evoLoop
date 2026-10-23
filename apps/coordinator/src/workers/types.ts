import type { Principal } from "@evoloop/contracts";

export type WorkerKind = "cognition" | "business";
export interface WorkerScope {
  projectId: string; loopId: string; taskId: string; runId: string; sessionId: string;
  roleId: string; kind: WorkerKind; allowedRoleIds: string[];
}
export interface WorkerIdentity { principal: Principal; scope: WorkerScope }
export interface WorkerMetadata {
  actorId: string; scope: WorkerScope; issuedAt: string; expiresAt: string; revokedAt: string | null;
}
export interface IssuedWorker { principal: Principal; wrapperPath: string; metadataWithoutSecret: WorkerMetadata }
