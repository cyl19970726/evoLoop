import type { PoolClient } from "pg";
import type { DocumentAsset, DocumentPayloadReader, DocumentPayloadRevision, RegisteredDocumentBlob, RegisteredGitSource } from "@evoloop/contracts/process-documents";
import type { GitSourceRef } from "@evoloop/contracts/sources";
import type { Operation } from "@evoloop/contracts";

const revision = (row: any): DocumentPayloadRevision => ({
  projectId: row.project_id, documentId: row.document_id, id: row.revision_id,
  previousRevisionId: row.previous_revision_id, format: row.format, mediaType: row.media_type,
  originalName: row.original_name ?? `${row.document_id}.md`, body: row.body,
  payloadRef: row.payload_ref, contentHash: row.content_hash, entrypoint: row.entrypoint,
  assetsManifest: row.assets_manifest as DocumentAsset[], author: row.author, reason: row.reason,
  createdAt: new Date(row.created_at).toISOString(),
});

/** Compose into an existing scoped PgReader/PgTransaction; it never owns a connection. */
export class PgDocumentPayloadStore implements DocumentPayloadReader {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  async getOperation(id: string): Promise<Operation | null> {
    const result = await this.client.query("SELECT * FROM operation_journal WHERE project_id=$1 AND operation_id=$2", [this.projectId, id]);
    const row = result.rows[0];
    return row ? { projectId: row.project_id, id: row.operation_id, actorId: row.actor_id,
      commandHash: row.command_hash, commandType: row.command_type, result: row.result,
      createdAt: new Date(row.created_at).toISOString() } : null;
  }

  async getDocumentPayloadRevision(documentId: string, revisionId: string): Promise<DocumentPayloadRevision | null> {
    const result = await this.client.query("SELECT * FROM document_revision WHERE project_id=$1 AND document_id=$2 AND revision_id=$3", [this.projectId, documentId, revisionId]);
    return result.rows[0] ? revision(result.rows[0]) : null;
  }
  async listDocumentAssets(documentId: string, revisionId: string): Promise<DocumentAsset[]> {
    return (await this.getDocumentPayloadRevision(documentId, revisionId))?.assetsManifest ?? [];
  }
  async getRegisteredBlob(id: string): Promise<RegisteredDocumentBlob | null> {
    const result = await this.client.query("SELECT * FROM document_blob_ref WHERE project_id=$1 AND blob_id=$2", [this.projectId, id]);
    const row = result.rows[0];
    return row ? { id: row.blob_id, projectId: row.project_id, documentId: row.document_id,
      revisionId: row.revision_id, role: row.role, relativePath: row.relative_path,
      contentHash: row.content_hash, size: Number(row.byte_size), mediaType: row.media_type } : null;
  }
  async getGitSourceRef(id: string): Promise<RegisteredGitSource | null> {
    const result = await this.client.query("SELECT * FROM git_source_ref WHERE project_id=$1 AND git_source_ref_id=$2", [this.projectId, id]);
    const row = result.rows[0];
    return row ? { id: row.git_source_ref_id, ref: { projectId: row.project_id, repositoryId: row.repository_id,
      path: row.source_path, commit: row.commit_hash, contentHash: row.content_hash },
      state: row.state, observedAt: new Date(row.observed_at).toISOString() } : null;
  }
  async insertDocumentPayloadRevision(value: DocumentPayloadRevision): Promise<void> {
    if (value.projectId !== this.projectId) throw new Error("project scope mismatch");
    await this.client.query(`INSERT INTO document_revision
      (project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason,
       media_type,original_name,payload_ref,entrypoint,assets_manifest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
      [this.projectId,value.documentId,value.id,value.body,value.format,value.contentHash,value.author,
        value.createdAt,value.previousRevisionId,value.reason,value.mediaType,value.originalName,value.payloadRef,
        value.entrypoint,JSON.stringify(value.assetsManifest)]);
  }
  async registerDocumentBlob(value: RegisteredDocumentBlob): Promise<void> {
    if (value.projectId !== this.projectId) throw new Error("project scope mismatch");
    await this.client.query(`INSERT INTO document_blob_ref
      (project_id,blob_id,document_id,revision_id,role,relative_path,content_hash,byte_size,media_type,registered_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      [this.projectId,value.id,value.documentId,value.revisionId,value.role,value.relativePath,
        value.contentHash,value.size,value.mediaType]);
  }
  async insertGitSourceRef(id: string, ref: GitSourceRef, state: "reachable" | "unavailable" | "withdrawn", observedAt: string): Promise<void> {
    if (ref.projectId !== this.projectId) throw new Error("project scope mismatch");
    if (!ref.repositoryId || !ref.path || ref.path.startsWith("/") || ref.path.includes("\\") ||
      ref.path.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref.commit) || !/^[a-f0-9]{64}$/.test(ref.contentHash))
      throw new Error("invalid fixed Git source reference");
    await this.client.query(`INSERT INTO git_source_ref
      (project_id,git_source_ref_id,repository_id,source_path,commit_hash,content_hash,state,observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [this.projectId,id,ref.repositoryId,ref.path,ref.commit,ref.contentHash,state,observedAt]);
  }
}
