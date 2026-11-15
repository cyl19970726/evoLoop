// A Session that cannot start work, refused or failed the same way three times (session_attention, migration 110), is told to the Leader by the
// notice path and, here, to the requirements Session(s): one message per item per Session, never repeated. Which Sessions are requirements Sessions is
// a port (the identity file says it, a Role does not); the post goes out as the Leader-notice sender. A failure to post is kept as the delivery's reason
// and tried again next round; an item with no requirements Session to tell is recorded as such, not dropped.
import { randomUUID } from "node:crypto";

export interface AttentionItem { projectId: string; attentionId: string; sessionId: string; cause: string; taskId: string; createdAt: string }
export interface SessionAttentionStore {
  /** Items created in the last `days` days that have no delivery row for some of `recipients` yet, or whose delivery is still pending. */
  open(days: number): Promise<AttentionItem[]>;
  deliveries(projectId: string, attentionId: string): Promise<Array<{ recipientSessionId: string; state: "pending" | "posted" | "blocked"; messageId: string | null }>>;
  ensure(projectId: string, attentionId: string, recipientSessionId: string): Promise<void>;
  posted(projectId: string, attentionId: string, recipientSessionId: string, messageId: string): Promise<void>;
  blocked(projectId: string, attentionId: string, recipientSessionId: string, reason: string): Promise<void>;
}
export interface SessionAttentionDeps {
  store: SessionAttentionStore;
  canWrite(): boolean;
  /** The requirements Sessions of the project (live, owned). */
  requirementsSessions(projectId: string): Promise<string[]>;
  /** Posts one ordinary message to a Session; resolves with how it went. */
  post(projectId: string, recipientSessionId: string, content: string, messageId: string, operationId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  onError?(error: unknown): void;
}

export const attentionText = (item: AttentionItem): string =>
  `【Session 不可用】Session ${item.sessionId} 连续三次因同一原因（${item.cause}）没能开工（启动前失败或预留被拒）。它在 work board 里标为不可用，向它派活会被拒绝；补齐原因（如绑定业务身份、恢复原生线程）后恢复。最近一次涉及的任务：${item.taskId}。这是系统生成的关注项（${item.attentionId}），同一原因只发一次。`;

export class SessionAttentionPump {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  constructor(private readonly deps: SessionAttentionDeps, private readonly pollMs = 5000) {}
  start(): void { if (this.timer) return; this.timer = setInterval(() => { void this.tick(); }, this.pollMs); this.timer.unref(); void this.tick(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  tick(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.scan().catch(error => this.deps.onError?.(error)).finally(() => { this.busy = null; });
    return this.busy;
  }
  private async scan(): Promise<void> {
    if (!this.deps.canWrite()) return;
    for (const item of await this.deps.store.open(7)) {
      const recipients = await this.deps.requirementsSessions(item.projectId);
      for (const recipient of recipients) await this.deps.store.ensure(item.projectId, item.attentionId, recipient);
      for (const delivery of await this.deps.store.deliveries(item.projectId, item.attentionId)) {
        if (delivery.state === "posted") continue;
        // The same ids every time: a retry after a lost answer is the same message, not a second one.
        const messageId = delivery.messageId ?? randomUUID(), operationId = randomUUID();
        const result = await this.deps.post(item.projectId, delivery.recipientSessionId, attentionText(item), messageId, operationId).catch(error => ({ ok: false as const, reason: `POST_FAILED:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}` }));
        if (result.ok) await this.deps.store.posted(item.projectId, item.attentionId, delivery.recipientSessionId, messageId);
        else await this.deps.store.blocked(item.projectId, item.attentionId, delivery.recipientSessionId, result.reason);
      }
    }
  }
}

/** The PostgreSQL store of the pump. `blocked` keeps the reason and the next round tries again (the row is not final until posted). */
export function pgSessionAttentionStore(pool: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }): SessionAttentionStore {
  return {
    open: async days => (await pool.query(`SELECT a.project_id,a.attention_id,a.session_id,a.cause,a.task_id,a.created_at FROM session_attention a
      WHERE a.created_at > now() - ($1::int * interval '1 day') ORDER BY a.created_at`, [days])).rows.map(r => ({ projectId: String(r.project_id), attentionId: String(r.attention_id),
      sessionId: String(r.session_id), cause: String(r.cause), taskId: String(r.task_id), createdAt: new Date(String(r.created_at)).toISOString() })),
    deliveries: async (projectId, attentionId) => (await pool.query(`SELECT recipient_session_id,state,message_id FROM session_attention_delivery WHERE project_id=$1 AND attention_id=$2`, [projectId, attentionId])).rows
      .map(r => ({ recipientSessionId: String(r.recipient_session_id), state: r.state as "pending" | "posted" | "blocked", messageId: r.message_id ? String(r.message_id) : null })),
    ensure: async (projectId, attentionId, recipient) => { await pool.query(`INSERT INTO session_attention_delivery(project_id,attention_id,recipient_session_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [projectId, attentionId, recipient]); },
    posted: async (projectId, attentionId, recipient, messageId) => { await pool.query(`UPDATE session_attention_delivery SET state='posted',message_id=$4,reason=NULL,updated_at=now() WHERE project_id=$1 AND attention_id=$2 AND recipient_session_id=$3`, [projectId, attentionId, recipient, messageId]); },
    blocked: async (projectId, attentionId, recipient, reason) => { await pool.query(`UPDATE session_attention_delivery SET state='blocked',reason=$4,updated_at=now() WHERE project_id=$1 AND attention_id=$2 AND recipient_session_id=$3 AND state<>'posted'`, [projectId, attentionId, recipient, reason]); },
  };
}
