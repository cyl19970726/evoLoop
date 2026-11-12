/** One Session of a Role, as far as the line needs to know it. */
export interface LineSession { projectId: string; id: string; roleId: string; actorId: string }
export interface LineRecipientConfig {
  /** `runtime.materialCli` entries: which CLI identity a Session signs with. Per-Session entries name `sessionId`; role entries only `roleId`. */
  materialCli: Array<{ projectId: string; sessionId?: string | undefined; roleId?: string | undefined; taskId?: string | undefined; sessionActorId: string; cliActorId: string }>;
  /** Resident-queue `roleActors`: one actor per Role. */
  roleActors: Array<{ projectId: string; roleId: string; actorId: string }>;
}
export type LineRecipient = { actorId: string } | { unresolved: string };

/**
 * The identity that signs this Session's deliveries, which is the recipient of its assignments. A Role is shared by several Sessions
 * (development, acceptance, a second acceptance …), each signing as its own identity, so a Role never identifies the Session's actor
 * by itself:
 *  1. the Session's own `materialCli` entry (named by its session ID and its native actor) is exact and always wins;
 *  2. a Role-level entry or the Role's `roleActors` entry is used only when the Role has exactly one live Session, where it cannot be
 *     another Session's identity;
 *  3. otherwise the line refuses, naming the Session and what to configure, before any assignment, confirmation or Run exists.
 * The result must also be a current project writer.
 */
export async function resolveLineRecipient(session: LineSession, config: LineRecipientConfig,
  liveSessionsOfRole: number, projectWriter: (projectId: string, actorId: string) => Promise<boolean>): Promise<LineRecipient> {
  const exact = config.materialCli.find(entry => entry.projectId === session.projectId && entry.sessionId === session.id &&
    entry.sessionActorId === session.actorId && entry.taskId === undefined);
  let actorId = exact?.cliActorId;
  let how = "its own runtime.materialCli entry";
  if (!actorId && liveSessionsOfRole === 1) {
    actorId = config.materialCli.find(entry => entry.projectId === session.projectId && entry.sessionId === undefined &&
      entry.roleId === session.roleId && entry.sessionActorId === session.actorId && entry.taskId === undefined)?.cliActorId
      ?? config.roleActors.find(entry => entry.projectId === session.projectId && entry.roleId === session.roleId)?.actorId;
    how = "the Role's configured actor (it is the Role's only live Session)";
  }
  if (!actorId) return { unresolved: liveSessionsOfRole > 1
    ? `Session ${session.id} shares its Role with ${liveSessionsOfRole - 1} other live Session(s) and has no runtime.materialCli entry of its own (sessionId ${session.id}, sessionActorId ${session.actorId}); the business identity is not guessed from the Role`
    : `Session ${session.id} has no configured business identity (no runtime.materialCli entry and no resident-queue actor for its Role)` };
  if (!await projectWriter(session.projectId, actorId))
    return { unresolved: `Session ${session.id}: ${how} names ${actorId}, which is not a current project writer` };
  return { actorId };
}
