import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import type { SessionMessageProcessing } from "@evoloop/contracts/session-messages";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import type { SessionMessageService } from "@evoloop/core/session-messages";
import type { SessionObservationService } from "@evoloop/core/session-observation";

export function registerSessionMessageRoutes(app: FastifyInstance, deps: {
  workflow: WorkflowService; observation: SessionObservationService; messages: SessionMessageService;
}): void {
  const identity = async (principal: Principal | null, projectId: string): Promise<Principal> => {
    if (!principal) throw new DomainError("FORBIDDEN", "Authentication required");
    await deps.workflow.getProject(principal, projectId);
    return principal;
  };
  const scopeOf = (p: Principal, projectId: string, key: string) => createHash("sha256")
    .update(JSON.stringify([projectId, p.actorId, [...p.permissions].sort(), key])).digest("hex");
  app.get("/api/projects/:projectId/session-work/:key/messages", async request => {
    const { projectId, key } = z.strictObject({ projectId: z.uuid(), key: z.string().min(1).max(128) }).parse(request.params);
    const principal = await identity(request.principal, projectId);
    const q = z.strictObject({ limit: z.coerce.number().int().min(1).max(50).default(50), cursor: z.string().min(1).max(4096).optional() }).parse(request.query);
    const snapshot = await deps.observation.snapshot(principal, projectId, key);
    const scope = scopeOf(principal, projectId, snapshot.session.key);
    let position: string | undefined;
    if (q.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(q.cursor, "base64url").toString());
        if (parsed.scope !== scope || parsed.v !== 1) throw new Error();
        position = z.uuid().parse(parsed.position);
      } catch { throw new DomainError("INVALID_CURSOR", "消息读取位置与当前身份、项目或会话不符。"); }
    }
    const page = typeof deps.messages.conversation === "function"
      ? await deps.messages.conversation(projectId, snapshot.session.target, q.limit, position)
      : await deps.messages.list(projectId, snapshot.session.target, q.limit, position);
    const items: Array<typeof page.items[number] & { contentTruncated: boolean; responseTruncated: boolean }> = [];
    let bytes = 2048;
    for (const item of page.items) {
      const processing = (item as typeof item & { processing?: SessionMessageProcessing | null }).processing ?? null;
      const response = processing?.response ?? null;
      const preview = { ...item, content: item.content.slice(0, 600), contentTruncated: item.content.length > 600,
        blockedReason: item.blockedReason?.slice(0, 600) ?? null,
        readReceipt: item.readReceipt ? { ...item.readReceipt, evidence: item.readReceipt.evidence.slice(0, 600) } : null,
        ...(processing ? { processing: { ...processing,
          response: response?.slice(0, 1200) ?? null, failure: processing.failure?.slice(0, 600) ?? null } } : {}),
        responseTruncated: !!response && response.length > 1200 };
      const size = Buffer.byteLength(JSON.stringify(preview));
      if (bytes + size > 256 * 1024) break;
      items.push(preview); bytes += size;
    }
    const more = page.nextCursor !== null || items.length < page.items.length;
    return { items, nextCursor: more && items.length ? Buffer.from(JSON.stringify({ v: 1, scope, position: items.at(-1)!.id })).toString("base64url") : null,
      metadata: { generatedAt: new Date().toISOString(), sourceObservedAt: items[0]?.updatedAt ?? null,
        partial: items.some(x => x.contentTruncated || x.responseTruncated) || more,
        limitations: ["列表正文、阻塞说明和收阅证据为最多600字预览，回复为最多1200字预览；完整记录从消息详情读取。", "重复外部接入按规范收件人读取；旧别名下消息保留原消息入口。"] } };
  });
  app.get("/api/projects/:projectId/session-messages/:id", async request => {
    const { projectId, id } = z.strictObject({ projectId: z.uuid(), id: z.uuid() }).parse(request.params);
    await identity(request.principal, projectId);
    const { message, processing } = await deps.messages.detail(projectId, id);
    return { message, processing, metadata: { generatedAt: new Date().toISOString(), sourceObservedAt: processing?.updatedAt ?? message.updatedAt,
      partial: false, limitations: message.target.kind === "external" ? ["人工转交记录不证明原聊天已收到。"] : [] } };
  });
}
