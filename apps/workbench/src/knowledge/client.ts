import type { CandidateDecision, KnowledgeCandidateRecord, KnowledgeCandidateSummary, KnowledgeCapabilities,
  KnowledgeGraph, KnowledgePage, KnowledgeRevision, KnowledgeSummary, PublishResult } from "@evoloop/contracts/knowledge";
import { request } from "../api";

export interface SourceDocument {
  documentId: string; title: string; revisionId: string; sourceKey: string;
  contentHash?: string; state: "reachable" | "withdrawn" | "unavailable";
}
export interface SourcePage { items: SourceDocument[]; nextCursor: string | null }
const key = (value: string) => encodeURIComponent(value);
export function knowledgeClient(token: string, projectId: string) {
  const root = `/api/projects/${key(projectId)}/knowledge`;
  const get = <T>(path: string) => request<T>(token, `${root}${path}`, 30000);
  const post = <T>(path: string, body: unknown) => request<T>(token, `${root}${path}`, 120000,
    { method: "POST", body: JSON.stringify(body) });
  return {
    capabilities: () => get<KnowledgeCapabilities>("/capabilities"),
    pages: (cursor?: string) => get<KnowledgePage<KnowledgeSummary>>(`/pages?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    page: (id: string, revision?: string) => get<KnowledgeRevision>(`/pages/${key(id)}${revision ? `?revision=${key(revision)}` : ""}`),
    history: (id: string, cursor?: string) => get<KnowledgePage<KnowledgeSummary>>(`/pages/${key(id)}/history?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    graph: (id: string) => get<KnowledgeGraph>(`/pages/${key(id)}/graph?limit=40`),
    sources: (cursor?: string) => get<SourcePage>(`/sources/documents?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    candidates: (cursor?: string) => get<KnowledgePage<KnowledgeCandidateSummary>>(`/candidates?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    candidate: (id: string) => get<KnowledgeCandidateRecord>(`/candidates/${key(id)}`),
    propose: (body: unknown) => post<KnowledgeCandidateRecord>("/candidates", body),
    review: (id: string, body: Omit<CandidateDecision, "candidateId" | "reviewerId">) =>
      post<{ status: "recorded"; decision: CandidateDecision }>(`/candidates/${key(id)}/review`, body),
    publish: (id: string, operationId: string) => post<PublishResult>(`/candidates/${key(id)}/publish`, { operationId }),
    retract: (documentId: string, operationId: string) => post<{ status: "recorded"; operationId: string; affected: string[] }>(
      `/sources/${key(documentId)}/retract`, { operationId }),
    reconcile: (operationId: string) => post<{ result: PublishResult | null }>(`/operations/${key(operationId)}/reconcile`, {}),
  };
}
