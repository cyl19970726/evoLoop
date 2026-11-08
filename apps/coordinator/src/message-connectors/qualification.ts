import type { RuntimeSessionRecord } from '@evoloop/contracts/runtime';
import type { VersionedConnectorRoute } from '@evoloop/contracts/message-connectors';
import type { loadIntegrations } from '../configuration.js';

type Configuration=Awaited<ReturnType<typeof loadIntegrations>>;
type GatewayBinding={conversation_id?:string;owner?:string;epoch?:number;control?:string;
  owner_session_ref?:string|null;thread_id?:string|null};

/** Shared by the HTTP activation path and the ingress pump's current qualification. */
export async function qualifyStandardConnectorRoute(route:VersionedConnectorRoute,
  session:RuntimeSessionRecord|null,current:Configuration,deps:{
    projectWriter(projectId:string,actorId:string):Promise<boolean>;
    businessActor(session:RuntimeSessionRecord,actorId:string):Promise<boolean>;
    sessionAuthority(session:RuntimeSessionRecord):Promise<boolean>;
    cwdCurrent(cwd:string):Promise<boolean>;
    nativeReady(session:RuntimeSessionRecord):Promise<boolean>;
    gatewayBinding(conversationId:string):Promise<GatewayBinding|null>;
  }):Promise<boolean>{
  if(route.mode!=='standard'||!session||session.projectId!==route.projectId||
    session.id!==route.targetSessionId||!current.messageConnectors?.enabled||
    !current.sessionMessages?.enabled||!current.runtime?.enabled)return false;
  const grant=current.sessionMessages.connectorReceivers.find(value=>value.enabled&&
    value.projectId===route.projectId&&value.bindingId===route.bindingId&&
    value.sessionId===route.targetSessionId&&value.mode==='standard'&&
    value.senderActorId===route.senderActorId&&value.receiverActorId===route.targetActorId&&
    value.receiverRoleId===session.roleId&&value.cwd===session.cwd&&
    value.policyHash===route.policyHash);
  if(!grant||session.state!=='ready'||session.sandbox!=='danger-full-access'||
    session.approvalPolicy!=='never'||!session.nativeThreadId||!session.nativeSessionId||
    route.targetThreadId!==session.nativeThreadId||
    !session.authorizationScope||session.authorizationScope.startsWith('connector-receiver:')||
    !await deps.projectWriter(route.projectId,route.senderActorId)||
    !await deps.businessActor(session,route.targetActorId)||
    !await deps.sessionAuthority(session)||!await deps.cwdCurrent(session.cwd)||
    !await deps.nativeReady(session))return false;
  const binding=await deps.gatewayBinding(route.source.conversationId);
  return !!binding&&binding.conversation_id===route.source.conversationId&&
    binding.owner===route.owner&&binding.epoch===route.epoch&&binding.control==='active'&&
    binding.owner_session_ref===route.sessionRef&&binding.thread_id===session.nativeThreadId;
}
