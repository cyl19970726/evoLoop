import { useEffect, useState } from 'react';
import type { RuntimeSessionRecord } from '@evoloop/contracts/runtime';
import type { SessionRecoveryView } from '@evoloop/contracts/session-recovery';
import { errorText } from '../api';
import { ActionForm, type MutationContext } from '../workflow/ActionForm';
import { sessionClient } from './client';
import { recoveryActivationLabel } from './recoveryPresentation';

type Catalog={status:'available'|'empty'|'unavailable';models:string[];
  options:Array<{model:string;supportedReasoningEfforts:string[];defaultReasoningEffort:string|null}>;error:string|null};

/** One Session's configured target and native activation; actual provider use has separate evidence. */
export function SessionModelControl({context,sessionId,recovery,busy,onApplied}:{
  context:MutationContext;sessionId:string;recovery:SessionRecoveryView|null;busy:boolean;onApplied():void;
}){
  const [runtime,setRuntime]=useState<RuntimeSessionRecord|null>(null);
  const [catalog,setCatalog]=useState<Catalog|null>(null);
  const [readError,setReadError]=useState('');
  const [editing,setEditing]=useState(false);
  const [selectedModel,setSelectedModel]=useState('');
  const [reload,setReload]=useState(0);
  useEffect(()=>{
    let live=true;const controller=new AbortController();
    setRuntime(null);setCatalog(null);setReadError('');
    const client=sessionClient(context.token,context.projectId);
    void Promise.all([client.runtimeSessions(controller.signal),client.models(controller.signal)]).then(([sessions,models])=>{
      if(!live)return;
      const matches=sessions.filter(item=>item.projectId===context.projectId&&item.id===sessionId);
      if(matches.length!==1)throw new Error('受管 Session 不在当前项目的唯一列表中');
      setRuntime(matches[0]!);setCatalog(models);
      setSelectedModel(matches[0]!.executionProfile?.revision.model??'');
    }).catch(error=>{if(live)setReadError(errorText(error));});
    return()=>{live=false;controller.abort();};
  },[context.token,context.projectId,sessionId,reload]);
  const profile=runtime?.executionProfile;
  const currentRevision=profile?.revision;
  const options=catalog?.options.find(option=>option.model===selectedModel)?.supportedReasoningEfforts??[];
  const canEdit=context.principal.permissions.includes('write')&&context.principal.permissions.includes('review')&&
    !context.blocked&&runtime?.state==='ready'&&runtime.sandbox==='danger-full-access'&&
    runtime.approvalPolicy==='never'&&!!currentRevision&&catalog?.status==='available'&&
    !!catalog.options.length&&profile?.activationState!=='attempting'&&profile?.activationState!=='unknown';
  const viewMismatch=!!recovery&&!!currentRevision&&recovery.executionProfile?.revision.revisionId!==currentRevision.revisionId;
  const target=currentRevision?`${currentRevision.model??'默认模型'} / ${currentRevision.reasoningEffort??'未配置'}`:'未读到受管配置';
  const active=profile?.activeRevisionId?
    `${profile.activeModel??'未确认'} / ${profile.activeReasoningEffort??'未记录'}`:'未确认';
  return <div className="session-model-control">
    <p><strong>目标配置</strong> {target}{currentRevision&&<> · 修订 {currentRevision.version}</>}</p>
    <p><strong>最后确认</strong> {active} · <strong>应用状态</strong> {profile?recoveryActivationLabel(profile.activationState):'未读取'}</p>
    {profile?.activationState==='pending'&&busy&&<p role="status">当前 Turn 沿旧配置继续；结束后在原 Thread 应用目标，新的业务启动会等待确认。</p>}
    {profile?.activationState==='unknown'&&<p role="alert">原操作结果未知。请按修订 {currentRevision?.revisionId} 和操作 {profile.activationOperationId??currentRevision?.operationId} 对账。</p>}
    {profile?.activationState==='rejected'&&<p role="alert">原生配置请求已拒绝。最后确认配置仍见上方；请核原操作后再选择。</p>}
    <p className="session-model-evidence">最近实际使用的思考强度尚无逐 Turn 遥测；配置读回不代表提供方已执行该强度。</p>
    {readError&&<p role="alert">模型配置读取失败：{readError}</p>}
    {viewMismatch&&<p role="status">页面两次读取的修订不一致，请重新核对再编辑。</p>}
    {catalog&&catalog.status!=='available'&&<p>当前模型目录{catalog.status==='empty'?'为空':'不可读取'}，暂不能保存新目标。</p>}
    {runtime&&(runtime.sandbox!=='danger-full-access'||runtime.approvalPolicy!=='never')&&
      <p>此 Session 须先确认完整权限配置，才能调整模型与思考强度。</p>}
    <button type="button" disabled={!canEdit||viewMismatch} onClick={()=>setEditing(value=>!value)}>
      {editing?'收起调整':'调整模型与强度'}
    </button>
    {editing&&canEdit&&!viewMismatch&&<div className="session-model-editor">
      <label>模型<select value={selectedModel} onChange={event=>setSelectedModel(event.target.value)}>
        {catalog!.options.map(item=><option key={item.model} value={item.model}>{item.model}</option>)}
      </select></label>
      {options.length?<ActionForm key={`${sessionId}:${runtime!.version}:${selectedModel}`} context={{...context,
        draftScope:`session-model:${sessionId}`,draftBaseline:`${runtime!.version}:${currentRevision!.revisionId}`}}
        title="保存 Session 下一轮模型与强度" review requiredPermissions={['write','review']} embedded
        fields={[{name:'reasoningEffort',label:'思考强度',kind:'select',options:options.map(value=>({value,label:value})),
          value:options.includes(currentRevision!.reasoningEffort??'')?currentRevision!.reasoningEffort!:''},
          {name:'reason',label:'调整理由',kind:'textarea'},
          {name:'evidenceRef',label:'授权与模型能力依据'}]}
        build={values=>({type:'runtime.session.executionProfile.revise',sessionId,
          expectedVersion:runtime!.version,expectedExecutionProfileRevisionId:currentRevision!.revisionId,
          model:selectedModel,reasoningEffort:values.reasoningEffort,reason:values.reason,evidenceRef:values.evidenceRef})}
        onApplied={()=>{setEditing(false);setReload(value=>value+1);onApplied();}}/>:
        <p>该模型未提供可核对的思考强度选项，不能提交。</p>}
    </div>}
  </div>;
}
