import {createInterface} from 'node:readline';

const mode=process.argv[2]??'normal';
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const thread={id:'direct-owned',sessionId:'direct-owned',cwd:'/tmp/evoloop-fixture',model:'gpt-6-sol'};
let started=false;
let steerCount=0;
let startCount=0;
let lastSteerId=null;
let lastSteerText=null;
for await(const line of createInterface({input:process.stdin})){
  const {id,method,params}=JSON.parse(line);
  if(method==='initialized')continue;
  if(method==='initialize'){send({id,result:{userAgent:'fixture',platformFamily:'unix'}});continue;}
  if(method==='thread/start'){
    send({id,result:{thread,model:thread.model,modelProvider:'openai',cwd:thread.cwd,
      approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}});continue;
  }
  if(method==='thread/resume'){
    send({id,result:{thread:{...thread,status:{type:'idle'}},model:thread.model,modelProvider:'openai',
      cwd:thread.cwd,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}});continue;
  }
  if(method==='thread/read'){
    send({id,result:{thread:{...thread,
      ...(mode==='foreign-read'?{sessionId:'foreign-session'}:{}),
      ...(mode==='wrong-model'?{model:'foreign-model'}:{}),
      status:{type:mode==='idle'||!started&&mode.startsWith('start')?'idle':'active',activeFlags:[]}}}});continue;
  }
  if(method==='thread/turns/list'){
    const failedAfterSteer=mode==='failed-after-steer'&&steerCount>0;
    if(mode==='review-ancestor'){
      send({id,result:{data:[{id:'review-child',status:'inProgress',completedAt:null},
        {id:'review-turn',status:'completed',completedAt:1792498484}],nextCursor:null}});continue;
    }
    send({id,result:{data:started||mode!=='start'?[{id:mode==='wrong-turn'?'other-turn':'turn-1',
      status:mode==='settled'?'completed':failedAfterSteer?'failed':'inProgress',
      completedAt:mode==='settled'||failedAfterSteer?1792498484:null,
      ...(failedAfterSteer?{error:{message:'Turn failed after the steer was accepted',
        misalignment:{steer:{message:'Continue from the last known state'}}}}:{})}]:[],nextCursor:null}});continue;
  }
  if(method==='thread/items/list'){
    const items=[];
    if(mode==='before-final')items.push({turnId:'turn-1',item:{id:'final-before-steer',type:'agentMessage',
      phase:'final_answer',text:'A final answer was materializing'}});
    if(lastSteerId)items.push({turnId:'turn-1',item:{id:`item-${lastSteerId}`,type:'userMessage',clientId:lastSteerId,
      content:[{type:'text',text:lastSteerText}]}});
    send({id,result:{data:items,nextCursor:null}});continue;
  }
  if(method==='turn/start'){
    startCount++;
    if(params.threadId!==thread.id||params.clientUserMessageId!=='start-id'||
      params.input?.[0]?.text!=='new input'||params.sandboxPolicy?.type!=='dangerFullAccess'||
      params.approvalPolicy!=='never'||params.model!==thread.model){
      send({id,error:{code:-32602,message:'invalid start request'}});continue;
    }
    started=true;
    if(mode==='start-lost')continue;
    if(mode==='start-missing-result'){send({id});continue;}
    send({id,result:{turn:{id:'turn-1',status:mode==='start-bad-ack'?'completed':'inProgress'}}});
    send({method:'turn/started',params:{threadId:thread.id,turn:{id:'turn-1',status:'inProgress'}}});continue;
  }
  if(method==='turn/steer'){
    steerCount++;
    if(params.threadId!==thread.id||
      params.expectedTurnId!=='turn-1'&&!(mode==='review-ancestor'&&params.expectedTurnId==='review-turn')||
      params.clientUserMessageId!=='steer-id'||params.input?.length!==1||
      params.input[0]?.type!=='text'||params.input[0]?.text!=='follow up'||
      Object.keys(params).sort().join(',')!=='clientUserMessageId,expectedTurnId,input,threadId'){
      send({id,error:{code:-32602,message:'invalid steer request'}});continue;
    }
    if(mode==='steer-lost')continue;
    if(mode==='steer-missing-result'){send({id});continue;}
    if(mode==='steer-reject'){
      send({id,error:{code:-32602,message:'private error text'}});continue;
    }
    if(mode==='wrong-turn'||mode==='settled'){
      send({id,error:{code:-32600,message:mode==='wrong-turn'
        ?'expected active turn id turn-1 but found other-turn'
        :'expected active turn id turn-1 but found none'}});continue;
    }
    if(mode==='non-steerable'){
      send({id,error:{code:-32602,message:'cannot steer a review turn',
        data:{codexErrorInfo:{activeTurnNotSteerable:{turnKind:'review'}}}}});continue;
    }
    if(mode==='misalignment'){
      send({id,error:{code:-32602,message:'MisalignmentSteer: expected turn differs from active turn'}});continue;
    }
    if(mode==='review-ancestor'&&params.expectedTurnId==='review-turn'){
      send({id,error:{code:-32600,message:'cannot steer a review turn',
        data:{codexErrorInfo:{activeTurnNotSteerable:{turnKind:'review'}}}}});continue;
    }
    lastSteerId=params.clientUserMessageId;
    lastSteerText=params.input[0].text;
    if(mode==='slow-steer')await new Promise(resolve=>setTimeout(resolve,300));
    send({id,result:{turnId:mode==='steer-bad-ack'?'other-turn':'turn-1'}});
    send({method:'item/started',params:{threadId:thread.id,turnId:'turn-1',item:{id:'input-2',type:'userMessage'}}});
    send({method:'item/started',params:{threadId:'foreign-thread',turnId:'turn-1',item:{id:'foreign',type:'userMessage'}}});
    continue;
  }
  if(method==='fixture/status'){
    send({id,result:{startCount,steerCount}});continue;
  }
  send({id,error:{code:-32601,message:'unknown fixture method'}});
}
