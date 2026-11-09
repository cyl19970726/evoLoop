import type { DiscussionEvent, DiscussionRecord } from "@evoloop/contracts";

export function discussionCopyEnvelope(origin: string, projectId: string, documentId: string, revisionId: string, body: string): string {
  const fixed = `${origin}/#/p/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}?revision=${encodeURIComponent(revisionId)}`;
  return `工作台入口：${origin}/\n固定原件入口：${fixed}\n以下正文才是被 SHA-256 核对的原件；此定位封套在复制时添加，不属于原件哈希。\n\n${body}`;
}

export interface VerifiedDocumentHead { version: number; revisionId: string; contentHash: string; author: string; body: string }

/** An explicit recovery uses the observed owner Document head; the old Discussion revision stays fixed. */
export function discussionDecisionPayload(record: DiscussionRecord, latestDecision: DiscussionEvent | undefined,
  head: VerifiedDocumentHead, values: Record<string, string>): Record<string, unknown> {
  const mismatch = head.revisionId !== record.currentDocumentRevisionId;
  if (mismatch && (values.confirmRecovery !== "confirmed" || !values.documentRecoveryReason?.trim()))
    throw new Error("请先核对两版并明确确认恢复及理由");
  return { type: "discussion.decision.record", discussionId: record.id, expectedVersion: record.version,
    documentRevisionId: mismatch ? head.revisionId : record.currentDocumentRevisionId,
    choice: values.choice, unresolved: values.unresolved, relookCondition: values.relookCondition,
    evidence: values.evidence, reason: values.reason,
    ...(latestDecision ? { supersedesDecisionEventId: latestDecision.id } : {}),
    ...(mismatch ? { documentRecovery: { expectedDocumentVersion: head.version, reason: values.documentRecoveryReason.trim() } } : {}) };
}
