// Whether a Session can start work right now (Task 6612e287). Some failures of the preflight are not about one Task but about the Session: it has no
// business identity to sign with, or its native thread is gone. A Session in that state used to show "ready" and every Run sent to it failed before the
// model started. This reads the same facts the preflight and the Session line read (resolveLineRecipient) and says so up front, with the reason.
import { resolveLineRecipient, type LineRecipientConfig } from "../session-line/recipient.js";

export type UnusableCode = "USABILITY_UNKNOWN" | "SESSION_NOT_READY" | "NATIVE_THREAD_UNAVAILABLE" | "BUSINESS_IDENTITY_UNBOUND" | "BUSINESS_IDENTITY_NOT_WRITER";
export interface UnusableReason { code: UnusableCode; reason: string }
export interface SessionUsability { usable: boolean; reasons: UnusableReason[] }
/** What every reader is told when whether a Session can start work could not be judged: not dispatchable, never silently "ready". */
export const USABILITY_UNKNOWN: UnusableReason = { code: "USABILITY_UNKNOWN" as never, reason: "现在判断不出这个 Session 能否开工（配置或身份解析失败）；按不可用处理，先核对服务日志与私有配置" };
export interface UsabilitySession { projectId: string; id: string; roleId: string; actorId: string; state: string; nativeThreadId: string | null }

/** Pure: the reasons this Session cannot start work, from the facts given. An empty list is usable. */
export async function sessionUsability(session: UsabilitySession, config: LineRecipientConfig, liveSessionsOfRole: number,
  projectWriter: (projectId: string, actorId: string) => Promise<boolean>): Promise<SessionUsability> {
  const reasons: UnusableReason[] = [];
  if (session.state !== "ready") reasons.push({ code: "SESSION_NOT_READY", reason: `Session 状态是 ${session.state}，不是 ready` });
  else if (!session.nativeThreadId) reasons.push({ code: "NATIVE_THREAD_UNAVAILABLE", reason: "没有可用的原生线程，Run 在启动前就会失败；先让 Session 恢复或重建原生线程" });
  // Same rule as the line: the Session's own materialCli entry, else the Role's actor only when it is the Role's only live Session.
  const anyone = await resolveLineRecipient(session, config, liveSessionsOfRole, async () => true);
  if ("unresolved" in anyone) reasons.push({ code: "BUSINESS_IDENTITY_UNBOUND", reason: `没有绑定业务身份：${anyone.unresolved}` });
  else if (!await projectWriter(session.projectId, anyone.actorId))
    reasons.push({ code: "BUSINESS_IDENTITY_NOT_WRITER", reason: `绑定的业务身份 ${anyone.actorId} 不是本项目当前的写入者` });
  return { usable: reasons.length === 0, reasons };
}

/** The codes that keep a Session out of acceptance/capacity views: its unusable reasons, or USABILITY_UNKNOWN when the judgement fails or leaves it out (fail closed). */
export async function usabilityProblems(judge: (projectId: string, sessionIds: string[]) => Promise<Map<string, SessionUsability>>, projectId: string, sessionId: string): Promise<string[]> {
  const judged = (await judge(projectId, [sessionId]).catch(() => null))?.get(sessionId);
  return !judged ? ["USABILITY_UNKNOWN"] : judged.usable ? [] : judged.reasons.map(reason => reason.code);
}

export interface SessionUsabilityDeps {
  /** The rows of these Sessions (or of one Role's live Sessions count) from the project data. */
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  config(): Promise<LineRecipientConfig>;
  projectWriter(projectId: string, actorId: string): Promise<boolean>;
}
/** Reads the Sessions by ID and judges each; a Session that is not found is left out of the map. */
export function createSessionUsability(deps: SessionUsabilityDeps) {
  return async (projectId: string, sessionIds: string[]): Promise<Map<string, SessionUsability>> => {
    const out = new Map<string, SessionUsability>();
    if (!sessionIds.length) return out;
    const rows = (await deps.query(`SELECT s.session_id,s.role_id,s.actor_id,s.state,s.native_thread_id,
      (SELECT count(*)::int FROM runtime_session o WHERE o.project_id=s.project_id AND o.role_id=s.role_id AND o.state<>'closed') AS live
      FROM runtime_session s WHERE s.project_id=$1 AND s.session_id=ANY($2::uuid[])`, [projectId, sessionIds])).rows;
    const config = await deps.config();
    for (const row of rows)
      out.set(String(row.session_id), await sessionUsability({ projectId, id: String(row.session_id), roleId: String(row.role_id), actorId: String(row.actor_id),
        state: String(row.state), nativeThreadId: row.native_thread_id ? String(row.native_thread_id) : null }, config, Number(row.live), deps.projectWriter));
    return out;
  };
}
