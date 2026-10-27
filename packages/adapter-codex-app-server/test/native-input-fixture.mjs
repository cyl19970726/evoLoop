import { createInterface } from 'node:readline';

const mode=process.argv[2]??'blocking';
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
const thread={id:'thread-owned',sessionId:'thread-owned',cwd:'/tmp/evoloop-fixture',model:'gpt-6-sol',status:{type:'idle',activeFlags:[]}};
const question=(id='name')=>({id,header:'Input',question:`Choose ${id}`,isOther:false,options:null});
const request=(id=1)=>({id,method:'item/tool/requestUserInput',params:{
  threadId:thread.id,turnId:'turn-1',itemId:'item-1',isBlocking:mode!=='nonblocking',
  questions:mode==='secret'?[{...question(),question:'private PIN',isSecret:true}]:
    mode==='budget'?Array.from({length:4},(_,index)=>question(`q${index}`)):
    mode==='large-budget'?Array.from({length:3},(_,index)=>({...question(`q${index}`),
      question:'Q'.repeat(4000),options:Array.from({length:8},(_,choice)=>({
        label:`${index}-${choice}-${'L'.repeat(225)}`,description:'D'.repeat(1000)}))})):
    mode==='empty-options'?[{...question(),options:[]}]:
    mode==='duplicate-options'?[{...question(),options:[{label:'Same',description:'First'},{label:'Same',description:'Second'}]}]:
    mode==='blank-question-id'?[{...question(),id:'   '}]:
    mode==='options'?[{...question('choice'),options:[{label:'Alpha',description:'First'},{label:'Beta',description:'Second'}],isOther:true}]:
    [question()],autoResolutionMs:1,
}});
let initialized=false;
let pendingCreate=null;
let turnStarts=0;
let responses=0;
for await(const line of createInterface({input:process.stdin})){
  const message=JSON.parse(line);
  if(message.method==='initialize'){
    const expected=mode!=='no-observer'&&mode!=='legacy';
    if(!!message.params?.capabilities?.experimentalApi!==expected)process.exit(2);
    send({id:message.id,result:{userAgent:'fixture',platformFamily:'unix'}});continue;
  }
  if(message.method==='initialized'){initialized=true;continue;}
  if(!initialized)continue;
  if(message.method==='thread/start'){
    if(mode==='early'){
      pendingCreate=message.id;
      send(request(900));
    }else send({id:message.id,result:{thread,model:'gpt-6-sol',modelProvider:'openai',cwd:thread.cwd,
      approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}});
    continue;
  }
  if(message.method==='thread/read'){
    send({id:message.id,result:{thread,turnStarts,responses}});
    if(mode.startsWith('mcp'))send({id:1,method:'mcpServer/elicitation/request',params:{
      serverName:'fixture',threadId:thread.id,turnId:null,
      ...(mode==='mcp-url'?{mode:'url',message:'private URL',url:'https://private.invalid',elicitationId:'private-id'}:
        mode==='mcp-device'?{mode:'openai/userVerification',title:'Private device',description:'private prompt',challenge:'private-code'}:
          {mode:'form',message:'private form',requestedSchema:{type:'object'}})}});
    else if(mode==='numeric-string'){send(request(1));send(request('1'));}
    else if(mode==='duplicate'){send(request(1));send(request(1));}
    else if(mode==='resolved'||mode==='resolved-foreign'){
      send(request(1));send({method:'serverRequest/resolved',params:{threadId:mode==='resolved-foreign'?'foreign-thread':thread.id,requestId:1}});
    }else if(mode==='foreign-thread'){
      send({...request(1),params:{...request(1).params,threadId:'foreign-thread'}});
    }else if(mode==='unsafe-id'){
      send(request(9007199254740992));
    }else{
      send(request(1));
      if(mode==='disconnect')setTimeout(()=>process.exit(0),60);
    }
    continue;
  }
  if(message.method==='turn/start'){
    turnStarts++;
    send({id:message.id,error:{code:-32602,message:'native input fixture never starts a Turn'}});continue;
  }
  if(message.id===900&&pendingCreate!==null){
    send({method:'fixture/nativeReply',params:{threadId:thread.id,requestId:900,result:message.result??null,error:message.error??null}});
    send({id:pendingCreate,result:{thread,model:'gpt-6-sol',modelProvider:'openai',cwd:thread.cwd,
      approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}});
    pendingCreate=null;continue;
  }
  if(message.id===1||message.id==='1'){
    responses++;
    send({method:'fixture/nativeReply',params:{threadId:thread.id,requestId:message.id,
      result:message.result??null,error:message.error??null}});
    if(message.result?.answers)send({method:'serverRequest/resolved',params:{threadId:thread.id,requestId:message.id}});
    continue;
  }
  if(message.id!=null)send({id:message.id,error:{code:-32601,message:'unsupported fixture method'}});
}
