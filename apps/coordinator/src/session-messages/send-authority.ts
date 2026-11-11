// The send-time half of the ordinary-message grant: the same grant the dispatcher needs later, checked when the
// message is posted, so a sender without one is told at once what is missing instead of leaving a message queued
// that can never be delivered. (Connector-receiver Sessions use route grants and are not checked here.)
export interface OrdinaryMessageGrant {
  enabled: boolean; projectId: string; sessionId: string; senderActorId: string; receiverActorId: string; receiverRoleId: string; cwd: string;
}
export interface SendGrantProblem { code: "MESSAGE_GRANT_MISSING"; message: string }

export function ordinaryMessageGrantProblem(input: {
  projectId: string; senderActorId: string;
  session: { id: string; roleId: string; cwd: string; authorizationScope: string };
  sessionMessages: { enabled: boolean; grants: OrdinaryMessageGrant[] } | undefined;
  isProjectWriter(actorId: string): Promise<boolean> | boolean;
}): Promise<SendGrantProblem | null> {
  return check(input);
}

async function check({ projectId, senderActorId, session, sessionMessages, isProjectWriter }: Parameters<typeof ordinaryMessageGrantProblem>[0]): Promise<SendGrantProblem | null> {
  if (session.authorizationScope.startsWith("connector-receiver:")) return null;
  const fail = (message: string): SendGrantProblem => ({ code: "MESSAGE_GRANT_MISSING", message });
  const example = `{"enabled":true,"projectId":"${projectId}","sessionId":"${session.id}","senderActorId":"${senderActorId}","receiverActorId":"<接收方 Session 的业务身份>","receiverRoleId":"${session.roleId}","cwd":"${session.cwd}"}`;
  if (!sessionMessages?.enabled)
    return fail("没有发送这条消息的授权：服务的私有配置里 sessionMessages 没有启用（sessionMessages.enabled）。消息没有保存。");
  if (!await isProjectWriter(senderActorId))
    return fail(`没有发送这条消息的授权：发送者身份 ${senderActorId} 在身份文件里对本项目没有 read 与 write。消息没有保存。`);
  const forSession = sessionMessages.grants.filter(grant => grant.enabled && grant.projectId === projectId && grant.sessionId === session.id && grant.senderActorId === senderActorId);
  const exact = forSession.find(grant => grant.receiverRoleId === session.roleId && grant.cwd === session.cwd);
  if (!exact) {
    const detail = forSession.length
      ? `已有的授权与这个 Session 当前的职责或工作目录不一致（授权的职责/工作目录须是 ${session.roleId} / ${session.cwd}）。`
      : `私有配置 sessionMessages.grants 里没有 ${senderActorId} → 这个 Session（${session.id}）的授权。`;
    return fail(`没有发送这条消息的授权：${detail}在 sessionMessages.grants 加一项 ${example}（使用时重读，不需要重启）。消息没有保存。`);
  }
  if (!await isProjectWriter(exact.receiverActorId))
    return fail(`没有发送这条消息的授权：授权里的接收方身份 ${exact.receiverActorId} 在身份文件里对本项目没有 read 与 write。消息没有保存。`);
  return null;
}
