import type { Principal } from "@evoloop/contracts";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import type { OrdinaryMessageExecutionCapability } from "@evoloop/contracts/session-work";
import type { loadIntegrations } from "../configuration.js";

export interface MessageExecutionReaderDeps {
  loadConfiguration():Promise<Pick<Awaited<ReturnType<typeof loadIntegrations>>,"runtime"|"sessionMessages">>;
  runtimeAvailable():boolean;
  isProjectWriter(projectId:string,actorId:string):Promise<boolean>;
  readSession(projectId:string,sessionId:string):Promise<RuntimeSessionRecord|null>;
  turnsUsed(projectId:string,sessionId:string,senderActorId:string):Promise<number>;
  cwdIsCurrent(cwd:string):Promise<boolean>;
  now?():string;
}

/** Snapshot projection only: neither a saved message nor a configured grant proves a native Turn can start. */
export function createMessageExecutionReader(deps:MessageExecutionReaderDeps){
  return async (principal:Principal,projectId:string,observed:ObservedSession):Promise<OrdinaryMessageExecutionCapability>=>{
    let observedAt:string;
    try{
      const value=deps.now?.()??new Date().toISOString();
      observedAt=Number.isFinite(Date.parse(value))?new Date(value).toISOString():new Date().toISOString();
    }catch{observedAt=new Date().toISOString();}
    const result=(state:OrdinaryMessageExecutionCapability["state"],reasonCode:string,reason:string):OrdinaryMessageExecutionCapability=>
      ({state,reasonCode,reason,observedAt});
    if(!principal.projectIds.includes(projectId)||!principal.actorId.trim()||!principal.permissions.includes("read"))
      return result("blocked","FORBIDDEN","当前身份不能读取此项目的会话执行状态。");
    if(!principal.permissions.includes("write"))
      return result("blocked","WRITE_REQUIRED","当前身份没有此项目的消息写入权限。");
    if(observed.target.kind==="external"||observed.kind==="external")
      return result("manual","MANUAL_HANDOFF","外部会话需要由宿主手工转交消息。");
    if(observed.kind!=="owned"||observed.target.kind!=="owned"||observed.runtimeState!=="ready"||
      !observed.capabilities.send.available||observed.capabilities.send.mode!=="owned-read-only")
      return result("blocked","SESSION_UNAVAILABLE","此会话当前不能保存并自动处理普通消息。");
    try{
      const session=await deps.readSession(projectId,observed.target.sessionId);
      if(!session||session.projectId!==projectId||session.id!==observed.target.sessionId||
        session.state!=="ready"||!session.nativeThreadId||!session.nativeSessionId)
        return result("blocked","SESSION_UNAVAILABLE","此会话尚未准备好接收普通回复。");

      const configuration=await deps.loadConfiguration();
      const messages=configuration.sessionMessages;
      if(!messages?.enabled)
        return result("disabled","SESSION_MESSAGES_DISABLED","普通自动回复未启用；保存后当前不会启动此会话。");
      if(!configuration.runtime?.enabled)
        return result("disabled","RUNTIME_DISABLED","会话运行功能未启用；保存消息不会启动原生回复。");
      if(!deps.runtimeAvailable())
        return result("blocked","RUNTIME_UNAVAILABLE","会话运行器当前不可用；保存消息不会启动原生回复。");
      if(!messages.readOnlyProtocolVerified)
        return result("unverified","READ_ONLY_PROTOCOL_UNVERIFIED","本轮原生只读协议尚未核准；保存消息不保证回复。");

      const grant=messages.grants.find(item=>item.enabled&&item.projectId===projectId&&
        item.sessionId===session.id&&item.senderActorId===principal.actorId&&
        item.receiverRoleId===session.roleId&&item.cwd===session.cwd&&
        !!item.receiverActorId.trim()&&item.receiverActorId!==principal.actorId&&
        Number.isInteger(item.maxTurns)&&item.maxTurns>=1);
      if(!grant||!await deps.isProjectWriter(projectId,principal.actorId)||
        !await deps.isProjectWriter(projectId,grant.receiverActorId))
        return result("blocked","MESSAGE_GRANT_MISSING","当前发送人与接收会话没有完整的精确授权。");
      if(!await deps.cwdIsCurrent(session.cwd))
        return result("blocked","SESSION_CWD_UNAVAILABLE","接收会话的工作目录尚未经当前路径核对。");
      const used=await deps.turnsUsed(projectId,session.id,principal.actorId);
      if(!Number.isSafeInteger(used)||used<0)
        return result("unknown","EXECUTION_STATUS_UNAVAILABLE","暂时无法核对普通回复执行状态，请稍后重试。");
      if(used>=grant.maxTurns)
        return result("blocked","MESSAGE_BUDGET_EXHAUSTED","此发送人与会话的普通回复额度已用完。");
      if(observed.busy===true)
        return result("blocked","SESSION_BUSY","会话正在处理另一项工作，普通回复需等待。");
      return result("unverified","READ_ONLY_NATIVE_UNVERIFIED",
        "配置准入已核对；执行前仍需验证原生只读权限、Task 答复顺序与持久门禁。保存消息不保证回复。");
    }catch{
      return result("unknown","EXECUTION_STATUS_UNAVAILABLE","暂时无法核对普通回复执行状态，请稍后重试。");
    }
  };
}
