// 模型与思考强度 of one owned agent: the configured target, the last confirmed native configuration and whether the
// target is applied; actual provider use has separate evidence. Editing needs the agent's runtime record and the model
// catalogue read now, and both must agree with the recovery view the page shows.
import { useEffect, useRef, useState } from 'react';
import type { SessionRecoveryView } from '@evoloop/contracts/session-recovery';
import { Button, Select } from '@evoloop/ui';
import { errorText } from '../../shared/api';
import { ActionForm, type MutationContext } from '../../shared/ActionForm';
import { useProjectQuery } from '../../shared/query';
import { sessionClient } from '../../shared/sessionClient';
import { FullIdentifiers } from '../../shared/ui/FullIdentifiers';
import { FactList, Legacy, mutedText } from '../../shared/ui/PageParts';
import { recoveryActivationLabel } from './recoveryPresentation';

const note = 'text-caption text-text-secondary [overflow-wrap:anywhere]';
const alert = 'rounded-md bg-warning-soft px-3 py-2 text-caption text-foreground [overflow-wrap:anywhere]';

/** One agent's configured target and native activation; actual provider use has separate evidence. */
export function SessionModelControl({context,sessionId,recovery,busy,onApplied}:{
  context:MutationContext;sessionId:string;recovery:SessionRecoveryView|null;busy:boolean;onApplied():void;
}){
  const {projectId}=context;
  const sessions=useProjectQuery(projectId,['runtime','sessions'],async signal=>{
    const items=await sessionClient('',projectId).runtimeSessions(signal);
    if(!Array.isArray(items))throw new Error('智能体列表响应不完整');
    return items.filter(item=>item.projectId===projectId);
  });
  const catalog=useProjectQuery(projectId,['runtime','models'],signal=>sessionClient('',projectId).models(signal));
  const [editing,setEditing]=useState(false);
  const [selectedModel,setSelectedModel]=useState('');
  // A recovery read can learn a newer revision or activation outcome after CLI/native writes: read the editor's
  // runtime record and catalogue again before using them.
  const recoveryRevisionId=recovery?.executionProfile?.revision.revisionId??null;
  const recoveryActivationState=recovery?.executionProfile?.activationState??null;
  const recoveryActiveRevisionId=recovery?.executionProfile?.activeRevisionId??null;
  const recoveryKey=`${recoveryRevisionId}:${recoveryActivationState}:${recoveryActiveRevisionId}`;
  const lastRecovery=useRef(recoveryKey);
  useEffect(()=>{
    if(lastRecovery.current===recoveryKey)return;
    lastRecovery.current=recoveryKey;
    void sessions.refetch();void catalog.refetch();
  },[recoveryKey]);
  const matches=(sessions.data??[]).filter(item=>item.id===sessionId);
  const readError=sessions.error?errorText(sessions.error):catalog.error?errorText(catalog.error)
    :sessions.data&&matches.length!==1?'受管智能体不在当前项目的唯一列表中':'';
  const runtime=!sessions.isError&&matches.length===1?matches[0]!:null;
  const models=catalog.isError?null:catalog.data??null;
  const profile=runtime?.executionProfile;
  const currentRevision=profile?.revision;
  useEffect(()=>{ if(!editing)setSelectedModel(currentRevision?.model??''); },[currentRevision?.revisionId,currentRevision?.model]);
  const reading=sessions.isFetching||catalog.isFetching;
  const viewMismatch=!!recovery&&!!currentRevision&&recovery.executionProfile?.revision.revisionId!==currentRevision.revisionId;
  const observedProfile=recovery ? recovery.executionProfile : profile;
  const options=models?.options?.find(option=>option.model===selectedModel)?.supportedReasoningEfforts??[];
  const fullAccess=runtime?.sandbox==='danger-full-access'&&runtime.approvalPolicy==='never';
  const canEdit=context.principal.permissions.includes('write')&&context.principal.permissions.includes('review')&&
    !context.blocked&&!!recovery&&!viewMismatch&&!reading&&runtime?.state==='ready'&&fullAccess&&!!currentRevision&&
    models?.status==='available'&&!!models.options?.length&&observedProfile?.activationState!=='attempting'&&
    observedProfile?.activationState!=='unknown';
  const target=currentRevision?`${currentRevision.model??'默认模型'} / ${currentRevision.reasoningEffort??'未配置'}`
    :sessions.isPending?'正在读取受管配置':'未读到受管配置';
  const active=observedProfile?.activeRevisionId?
    `${observedProfile.activeModel??'未确认'} / ${observedProfile.activeReasoningEffort??'未记录'}`:'未确认';
  return <div className="session-model-control flex min-w-0 flex-col gap-2">
    <FactList rows={[
      ['目标配置',<>{target}{currentRevision&&<> · 修订 {currentRevision.version}</>}</>],
      ['最后确认',active],
      ['应用状态',observedProfile?recoveryActivationLabel(observedProfile.activationState):'未读取'],
    ]}/>
    {observedProfile?.activationState==='pending'&&busy&&<p className={note} role="status">当前这一轮沿用旧配置；这一轮结束后在原对话线程应用新目标，新的任务启动会等待确认。</p>}
    {observedProfile?.activationState==='unknown'&&<p className={alert} role="alert">原操作结果未知。请按完整标识里的配置修订与操作核对。</p>}
    {observedProfile?.activationState==='rejected'&&<p className={alert} role="alert">原生配置请求已拒绝。最后确认的配置仍见上方；请核对原操作后再选择。</p>}
    <p className={note}>最近实际使用的思考强度没有逐轮记录；配置读回不代表模型提供方已按该强度执行。</p>
    {readError&&<p className={alert} role="alert">模型配置读取失败：{readError}{sessions.data||catalog.data?'；上次读回，当前待核对，不能据此调整。':''}</p>}
    {viewMismatch&&!reading&&<p className={note} role="status">页面两次读取的修订不一致，请重新核对再编辑。</p>}
    {models&&models.status!=='available'&&<p className={note}>当前模型目录{models.status==='empty'?'为空':'不可读取'}，暂不能保存新目标。</p>}
    {runtime&&!fullAccess&&<p className={note}>这个智能体的执行配置还不是完整权限；要调整模型与思考强度，先在团队 › 分工与运行里登记为完整权限。</p>}
    <Button size="compact" className="self-start" disabled={!canEdit} aria-expanded={editing&&canEdit} onClick={()=>setEditing(value=>!value)}>
      {editing?'收起调整':'调整模型与强度'}
    </Button>
    {editing&&canEdit&&<div className="session-model-editor flex min-w-0 flex-col gap-2">
      <label className="flex flex-col gap-1.5 text-label font-semibold text-foreground">模型
        <Select value={selectedModel} onChange={event=>setSelectedModel(event.target.value)} className="w-full font-normal">
          {models!.options.map(item=><option key={item.model} value={item.model}>{item.model}</option>)}
        </Select></label>
      {options.length?<Legacy><ActionForm key={`${sessionId}:${runtime!.version}:${selectedModel}`} context={{...context,
        draftScope:`session-model:${sessionId}`,draftBaseline:`${runtime!.version}:${currentRevision!.revisionId}`}}
        title="保存下一轮的模型与强度" review requiredPermissions={['write','review']} embedded
        fields={[{name:'reasoningEffort',label:'思考强度',kind:'select',options:options.map(value=>({value,label:value})),
          value:options.includes(currentRevision!.reasoningEffort??'')?currentRevision!.reasoningEffort!:''},
          {name:'reason',label:'调整理由',kind:'textarea'},
          {name:'evidenceRef',label:'授权与模型能力依据'}]}
        build={values=>({type:'runtime.session.executionProfile.revise',sessionId,
          expectedVersion:runtime!.version,expectedExecutionProfileRevisionId:currentRevision!.revisionId,
          model:selectedModel,reasoningEffort:values.reasoningEffort,reason:values.reason,evidenceRef:values.evidenceRef})}
        onApplied={()=>{setEditing(false);void sessions.refetch();onApplied();}}/></Legacy>:
        <p className={mutedText}>该模型未提供可核对的思考强度选项，不能提交。</p>}
    </div>}
    <FullIdentifiers rows={[
      {label:'目标配置修订',value:observedProfile?.revision.revisionId},
      {label:'已激活修订',value:observedProfile?.activeRevisionId},
      {label:'激活操作',value:observedProfile?.activationOperationId??(observedProfile?.activationState==='unknown'?observedProfile.revision.operationId:null)},
    ]}/>
  </div>;
}
