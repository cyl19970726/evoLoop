/** Backend-neutral Wiki boundary. Bodies and internal relations remain in the external knowledge space. */
export type KnowledgeValidity = "valid" | "needs_review" | "withdrawn";
export type KnowledgePageType = "topic" | "concept" | "analysis" | "decision";
export type EpistemicStatus = "observation" | "inference" | "hypothesis" | "adopted" | "disputed" | "superseded";
export interface KnowledgeSourceRef {
  sourceKey: string;
  originRevision: string;
  contentHash: string;
  fragment: string | null;
  state: "reachable" | "withdrawn" | "unavailable";
}
export interface KnowledgeRelation {
  edgeId: string;
  fromKnowledgeId: string;
  fromRevision: string;
  toKnowledgeId: string;
  toRevision: string;
  type: "supports" | "contradicts" | "related" | "member_of" | "supersedes";
  sourceKeys: string[];
  state: "active" | "needs_review" | "withdrawn";
}
export interface KnowledgeRevision {
  projectId: string;
  knowledgeId: string;
  revision: string;
  previousRevision: string | null;
  title: string;
  body: string;
  contentHash: string;
  pageType: KnowledgePageType;
  epistemicStatus: EpistemicStatus;
  validity: KnowledgeValidity;
  observedValidity: KnowledgeValidity;
  sources: KnowledgeSourceRef[];
  relations: KnowledgeRelation[];
  createdAt: string;
}
export interface KnowledgeSummary { knowledgeId: string; revision: string; title: string; pageType: KnowledgePageType; validity: KnowledgeValidity }
export interface KnowledgePage<T> { items: T[]; nextCursor: string | null; watermark: number }
export interface KnowledgeCandidate {
  projectId: string; knowledgeId: string; candidateId: string; candidateRevision: string;
  expectedRevision: string | null; contentHash: string; title: string; body: string;
  pageType: KnowledgePageType; epistemicStatus: EpistemicStatus;
  sources: KnowledgeSourceRef[]; relations: KnowledgeRelation[];
  operationId: string; actorId: string;
}
export interface CandidateDecision { candidateId: string; candidateRevision: string; contentHash: string; expectedRevision: string | null; decision: "accept" | "reject"; reviewerId: string; reason: string }
export type CandidateStatus = "pending" | "accepted" | "rejected" | "published";
export interface KnowledgeCandidateSummary {
  candidateId: string; knowledgeId: string; candidateRevision: string; expectedRevision: string | null;
  title: string; contentHash: string; status: CandidateStatus; decision: CandidateDecision | null;
}
export interface KnowledgeCandidateRecord extends KnowledgeCandidate { status: CandidateStatus; decision: CandidateDecision | null }
export interface KnowledgeGraph { nodes: KnowledgeSummary[]; edges: KnowledgeRelation[]; status: "complete" | "truncated" | "partial" | "unavailable"; watermark: number }
export type PublishResult =
  | { status: "published"; operationId: string; revision: string }
  | { status: "conflict"; operationId: string; currentRevision: string | null }
  | { status: "unknown"; operationId: string; reason: string };
export interface KnowledgeCapabilities {
  backendVersion: string | null;
  backendReachable: boolean;
  fixedRevisionRead: "adapter_verified" | "unavailable";
  conditionalPublish: "single_maintainer_adapter" | "unavailable";
  boundedRelations: "adapter_verified" | "unavailable";
  migration: "unsupported";
  semanticIndex: "unverified";
}
export interface KnowledgeRepository {
  capabilities(): Promise<KnowledgeCapabilities>;
  list(projectId: string, limit: number, cursor?: string): Promise<KnowledgePage<KnowledgeSummary>>;
  get(projectId: string, knowledgeId: string, revision?: string): Promise<KnowledgeRevision | null>;
  history(projectId: string, knowledgeId: string, limit: number, cursor?: string): Promise<KnowledgePage<KnowledgeSummary>>;
  graph(projectId: string, focusKnowledgeId: string, limit: number): Promise<KnowledgeGraph>;
  sourceState(projectId: string, sourceKey: string): Promise<"reachable" | "withdrawn">;
  listCandidates(projectId: string, limit: number, cursor?: string): Promise<KnowledgePage<KnowledgeCandidateSummary>>;
  getCandidate(projectId: string, candidateId: string): Promise<KnowledgeCandidateRecord | null>;
  propose(candidate: KnowledgeCandidate): Promise<KnowledgeCandidate>;
  review(projectId: string, decision: CandidateDecision): Promise<void>;
  publish(projectId: string, candidateId: string, operationId: string, actorId: string): Promise<PublishResult>;
  reconcile(projectId: string, operationId: string, actorId: string): Promise<PublishResult | null>;
  retractSource(projectId: string, sourceKey: string, operationId: string, actorId: string): Promise<string[]>;
  /** Optional native processing capabilities. Absence must be reported, never replaced with pretend search. */
  ingestSource?(input: KnowledgeIngestRequest): Promise<KnowledgeIngestion>;
  getIngestion?(projectId: string, operationId: string): Promise<KnowledgeIngestion | null>;
  query?(projectId: string, input: KnowledgeQuery): Promise<KnowledgeQueryResult>;
}

export interface KnowledgeIngestRequest {
  projectId: string; operationId: string; actorId: string;
  source: KnowledgeSourceRef; title: string; body: string;
}
export interface KnowledgeIngestion {
  operationId: string; actorId: string; source: KnowledgeSourceRef; title: string;
  status: "unknown" | "submitted" | "completed" | "failed";
  taskId: string | null;
  /** Processing acceptance/completion is separate from measured retrieval quality. */
  indexStatus: "unverified";
}
export interface KnowledgeQuery { query: string; scope: "published" | "sources"; limit: number }
export interface KnowledgeQueryHit {
  kind: "wiki" | "document"; id: string; revision: string; contentHash: string;
  title: string; score: number;
}
export interface KnowledgeQueryResult {
  items: KnowledgeQueryHit[]; scope: KnowledgeQuery["scope"];
  coverage: "bounded"; indexStatus: "unverified"; excluded: number;
}
export interface KnowledgeLintFinding {
  code: "NO_SOURCES" | "SOURCE_UNAVAILABLE" | "DUPLICATE_SOURCE" | "RELATION_UNAVAILABLE" | "NEEDS_REVIEW" | "INCOMPLETE";
  message: string;
}
export interface KnowledgeLintReport {
  target: "published" | "candidate"; candidateId?: string;
  knowledgeId: string; revision: string; contentHash: string;
  findings: KnowledgeLintFinding[];
  structural: "passed" | "findings";
  semantic: "not_run";
}
import { z } from "zod";
export { z } from "zod";

const uuid = z.uuid();
export const knowledgeCandidateInputSchema = z.strictObject({
  operationId: uuid, knowledgeId: uuid, candidateId: uuid, candidateRevision: uuid,
  expectedRevision: uuid.nullable(), title: z.string().trim().min(1).max(240),
  body: z.string().min(1).max(1024 * 1024), pageType: z.enum(["topic", "concept", "analysis", "decision"]),
  epistemicStatus: z.enum(["observation", "inference", "hypothesis", "adopted", "disputed", "superseded"]),
  sources: z.array(z.strictObject({ documentId: uuid, revisionId: uuid, fragment: z.string().max(240).nullable().default(null) })).min(1).max(100),
  relations: z.array(z.strictObject({ toKnowledgeId: uuid, toRevision: uuid,
    type: z.enum(["supports", "contradicts", "related", "member_of", "supersedes"]),
    sourceKeys: z.array(z.string().max(400)).max(100).default([]) })).max(100).default([]),
});
export const knowledgeReviewInputSchema = z.strictObject({ candidateRevision: uuid, contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: uuid.nullable(), decision: z.enum(["accept", "reject"]), reason: z.string().trim().min(1).max(4000) });
export const knowledgeOperationInputSchema = z.strictObject({ operationId: uuid });
export const knowledgeIngestInputSchema = z.strictObject({ operationId: uuid, documentId: uuid, revisionId: uuid });
export const knowledgeQueryInputSchema = z.strictObject({ query: z.string().trim().min(1).max(2000),
  scope: z.enum(["published", "sources"]).default("published"), limit: z.number().int().min(1).max(20).default(10) });
