import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const thread = { id: "thread-owned", sessionId: "thread-owned", cwd: "/tmp/evoloop-fixture", source: "appServer" };
const lines = createInterface({ input: process.stdin });
let initialized = false;
let approvalId = 800;
let toolId = 801;
let pendingCreateId = null;
let turnListReads = 0;
let archived = mode === "already-archived";
let turnStarts = 0;
let observedResumes = 0;
let lastTurnModel = null;
const sequenceInputs = [];
let unloaded = mode.startsWith('full-unloaded');
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") {
    initialized = true;
    if(mode==='stdout-eof-live'){
      process.on('SIGTERM',()=>{});
      process.stdout.end();
    }
    continue;
  }
  if (message.id === approvalId && pendingCreateId !== null) {
    const expected = mode === "prebind-unsupported" ? message.error?.code === -32000 : message.result?.decision === "decline";
    if (!expected) { process.exit(2); }
    send({ id: pendingCreateId, result: { thread:{...thread,model:"gpt-6-sol"},model:"gpt-6-sol",modelProvider:"openai",cwd:thread.cwd,approvalPolicy:"never",sandbox:{type:"dangerFullAccess"} } });
    pendingCreateId = null;
    continue;
  }
  if (message.id === approvalId) { send({ method: "fixture/approvalDecision", params: { threadId: thread.id, decision: message.result?.decision ?? null } }); continue; }
  if (message.id === toolId || message.id === toolId+1 ||
    (mode === "dynamic-persisted-resume" && message.id >= toolId+2 && message.id <= toolId+5)) {
    send({method:"fixture/toolDecision",params:{threadId:thread.id,turnId:"turn-1",requestId:message.id,result:message.result}});
    if (mode==="dynamic-replay" && message.id===toolId) send({id:toolId+1,method:"item/tool/call",params:{threadId:thread.id,turnId:"turn-1",callId:"call-1",tool:"browser_snapshot",arguments:{}}});
    continue;
  }
  if (mode === "protocol-0164" && [850, 851, 852, 853].includes(message.id)) {
    send({ method: "fixture/timeDecision", params: { threadId: thread.id, requestId: message.id,
      ...(message.result ? { result: message.result } : {}), ...(message.error ? { error: message.error } : {}) } });
    continue;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    if ((mode.startsWith("dynamic") || mode==='full-dynamic') && params.capabilities?.experimentalApi !== true) process.exit(2);
    if (!mode.startsWith("dynamic") && mode!=='full-dynamic' && params.capabilities?.experimentalApi === true) process.exit(2);
    send({ id, result: { userAgent: "fixture", platformFamily: "unix" } }); continue;
  }
  if (!initialized) { send({ id, error: { code: -32000, message: "not initialized" } }); continue; }
  if (mode === "malformed" && method === "turn/start") { process.stdout.write("{broken\n"); continue; }
  if (mode === "disconnect" && method === "turn/start") { process.exit(0); }
  if (mode === "timeout" && method === "turn/start") continue;
  if (mode === "reject-start" && method === "turn/start") { send({ id, error: { code: -32602, message: "invalid params: private fixture detail" } }); continue; }
  if (method === "thread/start") {
    if (mode.startsWith("dynamic") && (!Array.isArray(params.dynamicTools) || !params.dynamicTools.some(tool=>tool.name==="browser_snapshot"))) process.exit(2);
    if (mode.startsWith("prebind-")) {
      pendingCreateId = id;
      send({ id: approvalId, method: mode === "prebind-unsupported" ? "fixture/unsupportedRequest" : "item/commandExecution/requestApproval",
        params: { threadId: thread.id, command: "echo fixture" } });
      continue;
    }
    if(params.sandbox==='danger-full-access'){
      const nativeThread={...thread,model:params.model??'gpt-6-sol'};
      send({id,result:{thread:nativeThread,model:nativeThread.model,modelProvider:'openai',cwd:thread.cwd,
        approvalPolicy:params.approvalPolicy,
        sandbox:mode==='full-start-wrong'?{type:'readOnly',networkAccess:false}:{type:'dangerFullAccess'}}});continue;
    }
    send({id,error:{code:-32602,message:"new fixture Session requires full policy"}});continue;
  }
  if (method === "thread/resume" && mode === "dynamic-persisted-resume") {
    if (params.dynamicTools !== undefined) {send({id,error:{code:-32602,message:"resume must not redeclare native tools"}});continue;}
  }
  if (method === "thread/resume" && mode === "resume-rejected") { send({ id, error: { code: -32000, message: "thread resume unavailable: private fixture detail" } }); continue; }
  if (method === "thread/resume" && mode.startsWith("profile-transition")) {
    observedResumes++;
    if(params.threadId!==thread.id||params.cwd!==thread.cwd||params.model!=="new-model"||
      params.sandbox!=="danger-full-access"||params.approvalPolicy!=="never"){
      send({id,error:{code:-32602,message:"profile transition was not exact"}});continue;
    }
    thread.model=params.model;
    if(mode==="profile-transition-lost")continue;
    send({id,result:{thread:{...thread,status:{type:"idle",activeFlags:[]}},
      model:mode==="profile-transition-wrong-model"?"old-model":params.model,
      modelProvider:"openai",cwd:thread.cwd,approvalPolicy:params.approvalPolicy,
      sandbox:{type:mode==="profile-transition-wrong-policy"?"readOnly":"dangerFullAccess"}}});continue;
  }
  if(method==='thread/resume'&&params.sandbox==='danger-full-access'){
    observedResumes++;
    if(mode.startsWith('full-unloaded')){
      if(params.threadId!==thread.id||params.cwd!==thread.cwd||
        (mode==='full-unloaded-default'?params.model!=null:params.model!=='gpt-6-sol')||
        params.approvalPolicy!=='never'||params.excludeTurns!==true){
        send({id,error:{code:-32602,message:'full recovery profile mismatch'}});continue;
      }
      unloaded=false;
      if(mode==='full-unloaded-lost-resume')continue;
    }
    const nativeModel=mode==='full-resume-wrong-model'||mode==='full-resume-thread-model-mismatch'?'other-model':params.model??'gpt-6-sol';
    const nativeThread={...thread,model:nativeModel,status:{type:'idle',activeFlags:[]},...(mode==='changed-session'?{sessionId:'different-session'}:{})};
    send({id,result:{thread:nativeThread,model:mode==='full-resume-thread-model-mismatch'?'gpt-6-sol':nativeModel,modelProvider:'openai',cwd:thread.cwd,
      approvalPolicy:params.approvalPolicy,
      sandbox:mode==='full-resume-wrong'||mode==='full-loaded-old'||mode==='full-unloaded-wrong-policy'?
        {type:'readOnly',networkAccess:false}:{type:'dangerFullAccess'}}});continue;
  }
  if (method === "thread/archive") {
    if (params.threadId !== thread.id) { send({ id, error: { code: -32602, message: "foreign thread" } }); continue; }
    archived = true;
    if (mode === "lost-archive-ack") continue;
    send({ id, result: {} }); continue;
  }
  if (method === "thread/list") {
    if (params.archived !== true || params.cwd !== thread.cwd || params.sourceKinds !== undefined ||
      params.useStateDbOnly !== true || params.limit !== 100) {
      send({ id, error: { code: -32602, message: "unsafe listing" } }); continue;
    }
    const foreign = { id: "other-thread", sessionId: "other-session", cwd: thread.cwd, source: "vscode" };
    const owned = { ...thread, source: mode === "vscode-archive" ? "vscode" : "appServer",
      ...(mode === "foreign-archive" ? { sessionId: "different-session" } : {}) };
    send({ id, result: { data: archived ? mode === "foreign-only" ? [foreign] :
      mode === "foreign-samecwd" ? [foreign, owned] : [owned] : [], nextCursor: null } }); continue;
  }
  if (method === "thread/resume" || method === "thread/read") {
    const observedEnvironment = mode === "env-observe" && method === "thread/read" ? {
      HOME: process.env.HOME ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null,
      PATH: process.env.PATH ?? null, HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? null,
      EVOLOOP_DATABASE_URL: process.env.EVOLOOP_DATABASE_URL ?? null,
      EVOLOOP_AUTH_FILE: process.env.EVOLOOP_AUTH_FILE ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
      ARBITRARY_SECRET: process.env.ARBITRARY_SECRET ?? null,
    } : null;
    const nativeThread={...thread,...(mode.startsWith('full-')||mode==='full-sequence'?{model:unloaded?null:'gpt-6-sol'}:{}),status:{type:unloaded?'notLoaded':mode==='full-active'?'active':'idle',activeFlags:[]}};
    send({ id, result: { thread: mode === "changed-session" ? { ...nativeThread, sessionId: "different-session" } : nativeThread,
      observedTurnStarts:turnStarts,observedResumes,lastTurnModel,
      ...(observedEnvironment ? { observedEnvironment } : {}) } }); continue;
  }
  if (method === "thread/turns/list") {
    turnListReads++;
    if (mode.startsWith("turn-cursor-") && mode !== "turn-cursor-legacy-missing") {
      const nextCursor = mode === "turn-cursor-missing" ? {} :
        { nextCursor: mode === "turn-cursor-empty" ? "" : mode === "turn-cursor-number" ? 7 : null };
      send({id,result:{data:[{id:"turn-1",status:"completed",completedAt:1792498484}],...nextCursor}});
      continue;
    }
    if (mode === "turn-cursor-legacy-missing") {
      send({id,result:{data:[{id:"turn-1",status:"completed",completedAt:1792498484}]}});
      continue;
    }
    if (mode === "full-sequence") {
      send({id,result:{data:sequenceInputs.map((_,index)=>({id:`turn-${index+1}`,status:"completed",completedAt:1792498484+index})).reverse(),nextCursor:null}});
      continue;
    }
    if (mode === "history-newest" || mode === "history-newest-0164") {
      if (params.sortDirection !== "desc" || params.limit !== 100 ||
          (mode === "history-newest-0164" ? params.itemsView !== "notLoaded" : "itemsView" in params)) {
        send({id,error:{code:-32602,message:"ordinary history did not request newest first"}});continue;
      }
      const data=params.cursor ? [{id:"older-100",status:"completed",completedAt:1792498484}] :
        Array.from({length:100},(_,index)=>({id:index===0?"turn-1":`older-${index}`,status:"completed",completedAt:1792498484-index}));
      send({id,result:{data,nextCursor:params.cursor?null:"older-page"}});continue;
    }
    send({ id, result: { data: [{ id: "turn-1",
      status: mode === "transient-interrupted" && turnListReads === 1 ? "interrupted" : mode === "failed-turn" ? "failed" : "completed",
      completedAt: mode === "transient-interrupted" && turnListReads === 1 ? null : mode === "invalid-completed-at" ? "not-a-timestamp" : 1792498484,
      ...(mode === "failed-turn" ? { error: { message: JSON.stringify({ status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account. Private fixture detail" } }) } } : {})
    }], nextCursor: null } }); continue;
  }
  if (method === "thread/items/list") {
    if (mode === "full-sequence") {
      const index=Number(/^turn-(\d+)$/.exec(params.turnId)?.[1])-1;
      if(!Number.isInteger(index)||index<0||index>=sequenceInputs.length){send({id,error:{code:-32602,message:"unknown fixture turn"}});continue;}
      send({id,result:{data:[{turnId:params.turnId,item:{id:`input-${index+1}`,type:"userMessage",text:sequenceInputs[index]}},
        {turnId:params.turnId,item:{id:`reply-${index+1}`,type:"agentMessage",phase:"final_answer",text:`reply-${index+1}`}}],nextCursor:null}});continue;
    }
    if (mode === "work-trace") {
      const items = params.cursor ? [
        { id: "mcp-1", type: "mcpToolCall", server: "files", tool: "read", status: "completed", result: { content: [{ type: "text", text: "read output" }] }, error: null, durationMs: 7 },
        { id: "file-1", type: "fileChange", status: "completed", changes: [{ path: "/tmp/output.txt", diff: "private diff", kind: "add" }] },
        { id: "answer-1", type: "agentMessage", phase: "final_answer", text: "finished" },
      ] : [
        { id: "reason-1", type: "reasoning", content: ["private thought"] },
        { id: "cmd-1", type: "commandExecution", command: "echo hello", cwd: "/tmp", status: "completed", exitCode: 0, aggregatedOutput: "hello", durationMs: 12 },
        { id: "unknown-1", type: "newType", text: "private future content" },
      ];
      send({ id, result: { data: items.map(item => ({ turnId: params.turnId, item })), nextCursor: params.cursor ? null : "page-2" } }); continue;
    }
    send({ id, result: { data: [{ turnId: mode === "wrong-turn-items" ? "foreign-turn" : params.turnId, item: { id: "item-1", type: "agentMessage", text: "fixture final answer" } }], nextCursor: null } }); continue;
  }
  if (method === "turn/interrupt") { send({ id, result: {} }); send({ method: "turn/completed", params: { threadId: thread.id, turn: { id: params.turnId, status: "interrupted" } } }); continue; }
  if (method === "turn/start") {
    turnStarts++;
    if(unloaded){send({id,error:{code:-32000,message:'ThreadNotLoaded'}});continue;}
    if(mode.startsWith('full-')){
      if(params.sandboxPolicy?.type!=='dangerFullAccess'||params.approvalPolicy!=='never'||
        params.cwd!==thread.cwd||
        (mode==='full-default'||mode==='full-unloaded-default'?params.model!=null&&params.model!=='gpt-6-sol':params.model!=='gpt-6-sol')){
        send({id,error:{code:-32602,message:'full Turn policy missing'}});continue;
      }
      if(mode==='full-lost')continue;
    }
    if(mode==='full-sequence'){
      if(params.sandboxPolicy?.type!=='dangerFullAccess'||params.approvalPolicy!=='never'||
        params.cwd!==thread.cwd||params.model!=='gpt-6-sol'||!Array.isArray(params.input)||
        params.input.length!==1||params.input[0]?.type!=='text'){
        send({id,error:{code:-32602,message:'full sequence Turn policy or input missing'}});continue;
      }
      sequenceInputs.push(params.input[0].text);lastTurnModel=params.model;
    }
    if(mode.startsWith("profile-transition")){
      lastTurnModel=params.model;
      if(params.model!=="new-model") {send({id,error:{code:-32602,message:"new model absent from Turn start"}});continue;}
    }
    const startedTurnId=mode==="dynamic-persisted-resume"||mode==="full-sequence"||mode==='full-unloaded'?`turn-${turnStarts}`:"turn-1";
    send({ id, result: { turn: { id: startedTurnId, status: "inProgress" } } });
    send({ method: "item/started", params: { threadId: "unowned", turnId: "x" } });
    send({ method: "turn/started", params: { threadId: thread.id, turn: { id: startedTurnId, status: "inProgress" } } });
    if(mode==='full-sequence')send({method:"turn/completed",params:{threadId:thread.id,turn:{id:startedTurnId,status:"completed",completedAt:1792498484+turnStarts-1}}});
    if (mode === "protocol-0164") {
      send({ id: 850, method: "currentTime/read", params: { threadId: thread.id } });
      send({ id: 851, method: "currentTime/read", params: { threadId: "foreign-thread" } });
      send({ id: 852, method: "currentTime/read", params: {} });
      send({ id: 853, method: "unreviewed/serverRequest", params: { threadId: thread.id } });
    }
    if (mode === "approval") send({ id: approvalId, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: "turn-1", command: "echo fixture" } });
    if(mode==='full-dynamic')send({id:toolId,method:'item/tool/call',params:{
      threadId:thread.id,turnId:startedTurnId,callId:'full-call',tool:'browser_snapshot',arguments:{}}});
    if (mode==="dynamic-persisted-resume") {
      const id=toolId+(turnStarts-1)*2;
      send({id,method:"item/tool/call",params:{threadId:thread.id,turnId:startedTurnId,
        callId:`trusted-${turnStarts}`,tool:"browser_snapshot",arguments:{}}});
      send({id:id+1,method:"item/tool/call",params:{threadId:thread.id,turnId:startedTurnId,
        callId:`stale-${turnStarts}`,tool:"legacy_write",arguments:{}}});
    } else if (mode.startsWith("dynamic")) send({id:toolId,method:"item/tool/call",params:{
      threadId:mode==="dynamic-foreign"?"other-thread":thread.id,
      turnId:mode==="dynamic-wrong-turn"?"other-turn":"turn-1",callId:"call-1",
      tool:mode==="dynamic-unknown-tool"?"shell":"browser_snapshot",arguments:mode==="dynamic-url"?{url:"https://example.com"}:{}}});
    continue;
  }
  send({ id, error: { code: -32601, message: "unknown method" } });
}
