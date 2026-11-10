import type { RuntimeSessionRecord } from '@evoloop/contracts/runtime';
import type { VersionedConnectorRoute } from '@evoloop/contracts/message-connectors';
import type { loadIntegrations } from '../configuration.js';

type Configuration=Awaited<ReturnType<typeof loadIntegrations>>;
type GatewayBinding={conversation_id?:string;owner?:string;epoch?:number;control?:string;
  owner_session_ref?:string|null;thread_id?:string|null};

type SwitchConfiguration=Pick<Configuration,'messageConnectors'|'sessionMessages'|'runtime'>;
/** The first switch, read again on each use, that keeps every standard receiver from qualifying; null when all are on. */
export function standardReceiverSwitchOff(current:SwitchConfiguration):
  'message_connectors_disabled'|'session_messages_disabled'|'runtime_disabled'|null{
  return !current.messageConnectors?.enabled?'message_connectors_disabled':
    !current.sessionMessages?.enabled?'session_messages_disabled':!current.runtime?.enabled?'runtime_disabled':null;
}
/** Receiver grants a standard route can qualify under: enabled and `standard`. A restricted one is never activated. */
export const standardReceiverGrants=(current:SwitchConfiguration,projectId:string)=>
  (current.sessionMessages?.connectorReceivers??[]).filter(value=>value.enabled&&value.mode==='standard'&&value.projectId===projectId);

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
    session.id!==route.targetSessionId||standardReceiverSwitchOff(current))return false;
  const grant=standardReceiverGrants(current,route.projectId).find(value=>value.bindingId===route.bindingId&&
    value.sessionId===route.targetSessionId&&
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
