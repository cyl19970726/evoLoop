/** Neutral source and payload ports. Applications supply current authorization and registration checks. */
export interface GitSourceRef {
  projectId: string;
  repositoryId: string;
  path: string;
  commit: string;
  contentHash: string;
}

export type SourceUnavailableReason = "repository" | "commit" | "path" | "permission" | "hash_mismatch";
export type GitSourceRead =
  | { status: "available"; ref: GitSourceRef; bytes: Uint8Array; observedAt: string }
  | { status: "unavailable"; ref: GitSourceRef; reason: SourceUnavailableReason; observedAt: string };

export interface DocumentSource {
  read(ref: GitSourceRef): Promise<GitSourceRead>;
}

export interface BlobPayload {
  id: string;
  projectId: string;
  contentHash: string;
  size: number;
  mediaType: string;
}
export interface PreparedBlob { payload: BlobPayload; preparationId: string }
export interface BlobOrphanReport { unregisteredIds: string[]; temporaryIds: string[]; unreferencedHashes: string[] }
export type BlobRead =
  | { status: "available"; payload: BlobPayload; bytes: Uint8Array }
  | { status: "unavailable"; payload: BlobPayload; reason: "permission" | "unregistered" | "missing" | "hash_mismatch" | "too_large" };
export interface BlobStore {
  prepare(payload: BlobPayload, bytes: Uint8Array): Promise<PreparedBlob>;
  verify(prepared: PreparedBlob): Promise<boolean>;
  publish(prepared: PreparedBlob): Promise<BlobPayload>;
  read(payload: BlobPayload): Promise<BlobRead>;
  inspectOrphans(registeredIds: ReadonlySet<string>): Promise<BlobOrphanReport>;
}
