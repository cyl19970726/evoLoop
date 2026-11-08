import {createInterface} from 'node:readline';

const mode=process.argv[2]??'normal';
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const thread={id:'direct-owned',sessionId:'direct-owned',cwd:'/tmp/evoloop-fixture',model:'gpt-6-sol'};
let started=false;
let steerCount=0;
let startCount=0;
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
    send({id,result:{data:started||mode!=='start'?[{id:mode==='wrong-turn'?'other-turn':'turn-1',
      status:mode==='settled'?'completed':'inProgress',completedAt:mode==='settled'?1792498484:null}]:[],nextCursor:null}});continue;
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
    if(params.threadId!==thread.id||params.expectedTurnId!=='turn-1'||
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
