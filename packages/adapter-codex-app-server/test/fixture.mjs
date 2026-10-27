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
let transitionResumes = 0;
let ordinaryResumed = false;
let loadedBusinessResume = false;
let genericMessageBusinessResumed = false;
let turnStarts = 0;
let configReads = 0;
let requirementsReads = 0;
let threadReads = 0;
let observedResumes = 0;
let lastTurnModel = null;
let loadedBusinessInput = null;
const purposeRequests = () => [
  {id:900,method:"item/tool/call",params:{threadId:thread.id,turnId:"turn-1",callId:"call-1",tool:"browser_snapshot",arguments:{}}},
  {id:901,method:"item/tool/call",params:{threadId:thread.id,turnId:"turn-1",callId:"call-1",namespace:"business",tool:"browser_snapshot",arguments:{}}},
  {id:902,method:"item/commandExecution/requestApproval",params:{threadId:thread.id,turnId:"turn-1",command:"echo forbidden"}},
  {id:903,method:"applyPatchApproval",params:{conversationId:thread.id,callId:"patch-1"}},
  {id:904,method:"mcpServer/elicitation/request",params:{threadId:thread.id}},
  {id:905,method:"item/tool/call",params:{threadId:thread.id,turnId:"turn-1",callId:"call-1",tool:"browser_snapshot",arguments:{}}},
];
const earlyPurposeDecisions = [];
for await (const line of lines) {
  const message = JSON.parse(line);
  if (mode === "message-purpose-callbacks" && Number.isInteger(message.id) && message.id >= 900 && message.id <= 915 && !message.method) {
    if (message.id < 910) earlyPurposeDecisions.push({requestId:message.id,result:message.result??null,error:message.error??null});
    send({method:"fixture/purposeDecision",params:{threadId:thread.id,requestId:message.id,
      ...(message.result?{result:message.result}:{}),...(message.error?{error:message.error}:{})}});
    continue;
  }
  if (message.method === "initialized") { initialized = true; continue; }
  if (message.id === approvalId && pendingCreateId !== null) {
    const expected = mode === "prebind-unsupported" ? message.error?.code === -32000 : message.result?.decision === "decline";
    if (!expected) { process.exit(2); }
    send({ id: pendingCreateId, result: { thread } });
    pendingCreateId = null;
    continue;
  }
  if (message.id === approvalId) { send({ method: "fixture/approvalDecision", params: { threadId: thread.id, decision: message.result?.decision ?? null } }); continue; }
  if (message.id === toolId || message.id === toolId+1 ||
    (mode === "dynamic-cold-resume" && message.id >= toolId+2 && message.id <= toolId+5)) {
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
    if ((mode.startsWith("dynamic") || mode.startsWith("message-profile") || mode.startsWith("message-0164") || mode === "message-purpose-callbacks") && params.capabilities?.experimentalApi !== true) process.exit(2);
    if (!mode.startsWith("dynamic") && !mode.startsWith("message-profile") && !mode.startsWith("message-0164") && mode !== "message-purpose-callbacks" && params.capabilities?.experimentalApi === true) process.exit(2);
    if (mode === "message-purpose-callbacks") for (const request of purposeRequests()) send(request);
    send({ id, result: { userAgent: "fixture", platformFamily: "unix" } }); continue;
  }
  if (!initialized) { send({ id, error: { code: -32000, message: "not initialized" } }); continue; }
  if (method === "config/read") {
    const disabled = {enabled:false,destructive_enabled:false,open_world_enabled:false};
    configReads++;
    const features=Object.fromEntries(['apps','plugins','recommended_plugins','remote_plugin','plugin_sharing',
      'enable_mcp_apps','browser_use','browser_use_external','computer_use','multi_agent','multi_agent_v2',
      'tool_suggest','in_app_browser','in_app_local_automation'].map(key=>[key,false]));
    const appDefault=mode==='message-profile-apps-enabled'||(mode==='message-profile-drift'&&configReads>1)?
      {...disabled,enabled:true}:disabled;
    const appOverride=mode==='message-profile-app-override'?{'write-app':{enabled:true}}:{};
    const filesystem=mode==='message-profile-broad'?{'/tmp/evoloop-fixture':'read',':root':'read'}:{'/tmp/evoloop-fixture':'read'};
    const is0164Message=mode.startsWith('message-0164');
    if(is0164Message&&params.includeLayers!==true)process.exit(2);
    if(is0164Message&&(mode==='message-0164-apps-feature-enabled'||
      (mode==='message-0164-post-resume-drift'&&configReads>2)))features.apps=true;
    if(is0164Message&&mode==='message-0164-plugins-feature-enabled')features.plugins=true;
    const mcpServers=is0164Message?{'fixture-disabled':{command:'fixture-mcp',enabled:mode==='message-0164-mcp-enabled'}}:
      mode==='message-profile-disabled-mcp'?{'fixture-disabled':{command:'fixture-mcp',enabled:false}}:{};
    const plugins=is0164Message?{_default:{enabled:mode==='message-0164-plugin-default-enabled'},
      'fixture-plugin':{enabled:mode==='message-0164-plugin-enabled'}}:{};
    const origins={};
    if(is0164Message){
      for(const path of ['apps._default.enabled','features.apps','features.plugins','plugins._default.enabled'])
        origins[path]={name:{type:'sessionFlags'},version:'fixture-session-flags'};
      if(mode!=='message-0164-mcp-missing-origin')
        origins['mcp_servers.fixture-disabled.enabled']={name:{type:'sessionFlags'},version:'fixture-session-flags'};
      origins['plugins.fixture-plugin.enabled']={name:{type:'sessionFlags'},version:'fixture-session-flags'};
    }
    const layers=is0164Message?[
      {name:{type:'sessionFlags'},version:'fixture-session-flags',config:{
        mcp_servers:{'fixture-disabled':{enabled:false}},apps:{_default:disabled},
        features:{apps:false,plugins:false},plugins:{_default:{enabled:false},'fixture-plugin':{enabled:false}}}},
      {name:{type:'user',file:'/tmp/fixture-config.toml',profile:null},version:'fixture-user',config:{}},
      ...(mode==='message-0164-managed-layer'?[{name:{type:'enterpriseManaged',id:'fixture',name:'managed'},version:'fixture-managed',config:{}}]:[]),
    ]:undefined;
    send({id,result:{config:{apps:{_default:appDefault,...appOverride},
      features,web_search:'disabled',tools:{web_search:null},browser_use:null,computer_use:null,
      orchestrator:{mcp:{enabled:false},skills:{enabled:false}},
      mcp_servers:mcpServers,plugins,permissions:{evoloop_message_read:{filesystem,network:{enabled:false}}}},
      origins,...(layers?{layers}:{})}});continue;
  }
  if(method==='config/requirements/read'&&mode.startsWith('message-0164')){
    requirementsReads++;
    if(mode==='message-0164-requirements-read-error'){
      send({id,error:{code:-32000,message:'fixture requirements unavailable'}});continue;
    }
    if(mode==='message-0164-requirements-missing-shape'){
      send({id,result:{supportsIndependentSpeedModes:null}});continue;
    }
    let requirements=null;
    if(mode==='message-0164-requirement-apps-true')requirements={featureRequirements:{apps:true}};
    if(mode==='message-0164-requirement-plugins-true')requirements={featureRequirements:{plugins:true}};
    if(mode==='message-0164-requirement-sensitive-true')requirements={featureRequirements:{browser_use:true}};
    if(mode==='message-0164-requirement-unknown-true')requirements={featureRequirements:{future_tool_surface:true}};
    if(mode==='message-0164-requirement-bad-feature-map')requirements={featureRequirements:'not-a-map'};
    if(mode==='message-0164-requirement-false-only')requirements={featureRequirements:{apps:false,plugins:false,browser_use:false}};
    if(mode==='message-0164-requirements-post-resume-drift'&&requirementsReads>2)
      requirements={featureRequirements:{apps:false}};
    if(mode==='message-0164-requirements-post-resume-true'&&requirementsReads>2)
      requirements={featureRequirements:{future_tool_surface:true}};
    send({id,result:{requirements,supportsIndependentSpeedModes:null}});continue;
  }
  if (method === "mcpServerStatus/list") {
    if(mode.startsWith('message-0164')){
      if(params.detail!=='full'||params.limit!==100)process.exit(2);
      const status={name:'fixture-disabled',runtimeStatus:'disabled',pluginId:null,authStatus:'unsupported',
        tools:{},toolsError:null,resources:[],resourceTemplates:[]};
      if(mode==='message-0164-inventory-enabled')status.runtimeStatus='connected';
      if(mode==='message-0164-inventory-auth-unknown')status.authStatus='unknown';
      if(mode==='message-0164-inventory-tools-error')status.toolsError={message:'fixture error'};
      if(mode==='message-0164-inventory-tools')status.tools={write:{name:'write'}};
      if(mode==='message-0164-inventory-new-id')status.name='unconfigured-server';
      if(mode==='message-0164-inventory-missing'){
        send({id,result:{data:[],nextCursor:null}});continue;
      }
      if(mode==='message-0164-inventory-no-cursor'){
        send({id,result:{data:[status]}});continue;
      }
      if(mode==='message-0164-inventory-page-loop'){
        send({id,result:{data:params.cursor?[status]:[],nextCursor:'repeated'}});continue;
      }
      if(mode==='message-0164-inventory-paged'){
        if(!params.cursor){send({id,result:{data:[],nextCursor:'page-2'}});continue;}
        send({id,result:{data:[status],nextCursor:null}});continue;
      }
      send({id,result:{data:[status],nextCursor:null}});continue;
    }
    send({id,result:{data:mode==='message-profile-mcp'?[{name:'write-capable',tools:{write:{name:'write',inputSchema:{}}}}]:[],nextCursor:null}});continue;
  }
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
    send({ id, result: { thread } }); continue;
  }
  if (method === "thread/resume" && mode === "dynamic-cold-resume") {
    if (params.dynamicTools !== undefined) {send({id,error:{code:-32602,message:"resume must not redeclare native tools"}});continue;}
    observedResumes++;
  }
  if (method === "thread/resume" && mode === "resume-rejected") { send({ id, error: { code: -32000, message: "thread resume unavailable: private fixture detail" } }); continue; }
  if(method==='thread/resume'&&mode.startsWith('message-0164')){
    if(params.threadId!==thread.id||params.cwd!==thread.cwd||params.model!=='gpt-6-sol'||
      params.permissions!=='evoloop_message_read'||params.approvalPolicy!=='never'||
      params.sandbox!==undefined||params.config!==undefined||params.excludeTurns!==true){
      send({id,error:{code:-32602,message:'ordinary cold resume request was not exact'}});continue;
    }
    const ordinaryThread={...thread,model:'gpt-6-sol',status:{type:'idle',activeFlags:[]}};
    observedResumes++;
    const response={thread:ordinaryThread,model:'gpt-6-sol',modelProvider:'openai',cwd:thread.cwd,
      approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},
      activePermissionProfile:{id:'evoloop_message_read',extends:null}};
    if(mode==='message-0164-resume-wrong-thread')response.thread={...ordinaryThread,id:'other-thread'};
    if(mode==='message-0164-resume-wrong-session')response.thread={...ordinaryThread,sessionId:'other-session'};
    if(mode==='message-0164-resume-wrong-profile')response.activePermissionProfile={id:'other',extends:null};
    if(mode==='message-0164-resume-wrong-network')response.sandbox.networkAccess=true;
    if(mode==='message-0164-resume-wrong-approval')response.approvalPolicy='on-request';
    if(mode==='message-0164-resume-wrong-model')response.model='other-model';
    if(mode==='message-0164-resume-wrong-cwd')response.cwd='/tmp/other-cwd';
    send({id,result:response});continue;
  }
  if (method === "thread/resume" && mode.startsWith("profile-transition")) {
    observedResumes++;
    if(params.threadId!==thread.id||params.cwd!==thread.cwd||params.model!=="new-model"||
      params.sandbox!=="workspace-write"||params.approvalPolicy!=="on-request"||
      params.config?.["sandbox_workspace_write.network_access"]!==false){
      send({id,error:{code:-32602,message:"profile transition was not exact"}});continue;
    }
    thread.model=params.model;
    if(mode==="profile-transition-lost")continue;
    send({id,result:{thread:{...thread,status:{type:"idle",activeFlags:[]}},
      model:mode==="profile-transition-wrong-model"?"old-model":params.model,
      modelProvider:"openai",cwd:thread.cwd,approvalPolicy:params.approvalPolicy,
      sandbox:{type:"workspaceWrite",writableRoots:mode==="profile-transition-broad"?["/private"]:[],
        networkAccess:false}}});continue;
  }
  if (method === "thread/resume" && mode === "resume-profile") {
    if (params.threadId !== thread.id || params.cwd !== thread.cwd || params.model !== "gpt-6-astra" ||
      params.sandbox !== "workspace-write" || params.approvalPolicy !== "on-request" ||
      params.config?.["sandbox_workspace_write.network_access"] !== true || params.excludeTurns !== true) {
      send({ id, error: { code: -32602, message: "resume lost the authorized profile" } }); continue;
    }
  }
  if (method === "thread/resume" && mode === "resume-network-transition") {
    const expected = transitionResumes++ === 0;
    if (params.threadId !== thread.id || params.cwd !== thread.cwd || params.model !== "gpt-6-astra" ||
      params.sandbox !== "workspace-write" || params.approvalPolicy !== "on-request" ||
      params.config?.["sandbox_workspace_write.network_access"] !== expected || params.excludeTurns !== true) {
      send({id,error:{code:-32602,message:"resume did not apply current network profile"}}); continue;
    }
  }
  if (method === "thread/resume" && mode.startsWith("message-profile-loaded")) {
    observedResumes++;
    const originalSandbox=mode.includes("workspace")?"workspace-write":"read-only";
    if (params.permissions === "evoloop_message_read") {
      if (params.model !== "gpt-6-sol" || params.approvalPolicy !== "never" || params.sandbox !== undefined) {
        send({id,error:{code:-32602,message:"ordinary profile was not exact"}});continue;
      }
      ordinaryResumed=true;
    } else {
      if (!ordinaryResumed || params.model !== "gpt-6-sol" || params.sandbox !== originalSandbox ||
        params.approvalPolicy !== "on-request" || params.cwd !== thread.cwd ||
        (originalSandbox==="workspace-write" && params.config?.["sandbox_workspace_write.network_access"] !== false)) {
        send({id,error:{code:-32602,message:"business restoration request was not exact"}});continue;
      }
      loadedBusinessResume=true;
    }
    const nativeThread={...thread,status:{type:"idle",activeFlags:[]},model:"gpt-6-sol"};
    send({id,result:{thread:mode.endsWith("foreign")&&loadedBusinessResume?
      {...nativeThread,sessionId:"foreign"}:nativeThread,
      model:mode.endsWith("wrong-model")?"foreign-model":"gpt-6-sol",modelProvider:"openai",cwd:thread.cwd,
      approvalPolicy:"never",sandbox:{type:"readOnly",networkAccess:false},
      ...(mode.includes("legacy")?{}:{activePermissionProfile:{
        id:mode.endsWith("different-policy")?"foreign_policy":"evoloop_message_read",extends:null}})}});continue;
  }
  if (method === "thread/resume" && mode.startsWith("message-profile")) {
    if (params.permissions === "evoloop_message_read") {
      if (params.approvalPolicy !== "never" || params.sandbox !== undefined || params.config !== undefined) {
        send({id,error:{code:-32602,message:"ordinary resume has elevated policy"}}); continue;
      }
      ordinaryResumed = true;
    } else if (params.sandbox === "workspace-write") {
      if (!ordinaryResumed || params.approvalPolicy !== "on-request" || params.config?.["sandbox_workspace_write.network_access"] !== true) {
        send({id,error:{code:-32602,message:"business profile not restored"}}); continue;
      }
      ordinaryResumed = false;
      genericMessageBusinessResumed = true;
    } else {send({id,error:{code:-32602,message:"unexpected profile"}});continue;}
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
    if (mode === "message-purpose-callbacks" && method === "thread/read") {
      for (const request of purposeRequests()) send({...request,id:request.id+10});
    }
    if (method === "thread/read") threadReads++;
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
    const nativeThread={...thread,...(mode.startsWith('message-0164')?{model:'gpt-6-sol'}:{}),status:{type:mode==='message-profile-active'||
      (mode==='message-profile-activity-race'&&threadReads>=3)?'active':'idle',activeFlags:[]}};
    send({ id, result: { thread: mode === "changed-session" ? { ...nativeThread, sessionId: "different-session" } : nativeThread,
      ...(method === "thread/resume" && genericMessageBusinessResumed ? {
        model:"fixture-model",modelProvider:"openai",cwd:thread.cwd,approvalPolicy:"on-request",
        sandbox:{type:"workspaceWrite",writableRoots:[],networkAccess:true},activePermissionProfile:null} : {}),
      observedTurnStarts:turnStarts,observedResumes,lastTurnModel,
      ...(mode === "message-purpose-callbacks" ? {earlyPurposeDecisions} : {}),
      ...(observedEnvironment ? { observedEnvironment } : {}) } }); continue;
  }
  if (method === "thread/turns/list") {
    turnListReads++;
    if (mode.startsWith("message-profile-loaded")) {
      const businessVisible=turnStarts>=2&&(!mode.endsWith("lost")&&!mode.endsWith("reject")||turnStarts>=3);
      send({id,result:{data:[...(businessVisible?[{id:`turn-${turnStarts}`,status:"inProgress",completedAt:null}]:[]),
        ...(turnStarts>=1?[{id:"turn-1",status:"completed",completedAt:1792498484}]:[])],nextCursor:null}});continue;
    }
    if (mode === "message-profile-history") {
      if (params.sortDirection !== "desc" || params.limit !== 100) {
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
    if (mode.startsWith("message-profile-loaded")&&params.turnId===`turn-${turnStarts}`&&turnStarts>=2) {
      send({id,result:{data:loadedBusinessInput?[{turnId:params.turnId,item:{id:"business-input",type:"userMessage",text:loadedBusinessInput}}]:[],nextCursor:null}});continue;
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
    if(mode.startsWith("profile-transition")){
      lastTurnModel=params.model;
      if(params.model!=="new-model") {send({id,error:{code:-32602,message:"new model absent from Turn start"}});continue;}
    }
    if (mode.startsWith("message-profile-loaded")) {
      if (!loadedBusinessResume) {
        if (!ordinaryResumed || params.permissions!=="evoloop_message_read" ||
          params.approvalPolicy!=="never" || params.sandboxPolicy!==undefined || params.cwd!==thread.cwd) {
          send({id,error:{code:-32602,message:"ordinary Turn was not exact"}});continue;
        }
      } else {
        const expectedSandbox=mode.includes("workspace")?"workspaceWrite":"readOnly";
        if (params.model!=="gpt-6-sol" || params.permissions!==undefined ||
          params.approvalPolicy!=="on-request" || params.sandboxPolicy?.type!==expectedSandbox ||
          params.sandboxPolicy.networkAccess!==false || params.cwd!==thread.cwd ||
          (expectedSandbox==="workspaceWrite" && JSON.stringify(params.sandboxPolicy.writableRoots)!=="[]")) {
          send({id,error:{code:-32602,message:"business Turn did not use exact original overrides"}});continue;
        }
        if (mode.endsWith("reject")&&turnStarts===2) {send({id,error:{code:-32602,message:"business Turn rejected"}});continue;}
        if (mode.endsWith("lost")&&turnStarts===2) continue;
        lastTurnModel=params.model;
        loadedBusinessInput=params.input?.[0]?.text??null;
        ordinaryResumed=false;
      }
    } else if (mode.startsWith("message-profile")) {
      if (ordinaryResumed) {
        if (params.approvalPolicy !== "never" || params.permissions !== "evoloop_message_read" ||
          params.sandboxPolicy !== undefined || params.cwd !== thread.cwd) {
          send({id,error:{code:-32602,message:"ordinary turn not read-only"}});continue;
        }
        if (mode === "message-profile-reject") {send({id,error:{code:-32602,message:"fixture rejected ordinary start"}});continue;}
        if (mode === "message-profile-timeout") continue;
      } else if (params.approvalPolicy !== "on-request" || params.sandboxPolicy?.type !== "workspaceWrite" ||
        params.sandboxPolicy.networkAccess !== true || params.cwd !== thread.cwd) {
        send({id,error:{code:-32602,message:"business turn did not regain exact profile"}});continue;
      }
    }
    const startedTurnId=mode.startsWith("message-profile-loaded")||mode==="dynamic-cold-resume"?`turn-${turnStarts}`:"turn-1";
    send({ id, result: { turn: { id: startedTurnId, status: "inProgress" } } });
    send({ method: "item/started", params: { threadId: "unowned", turnId: "x" } });
    send({ method: "turn/started", params: { threadId: thread.id, turn: { id: startedTurnId, status: "inProgress" } } });
    if (mode === "protocol-0164") {
      send({ id: 850, method: "currentTime/read", params: { threadId: thread.id } });
      send({ id: 851, method: "currentTime/read", params: { threadId: "foreign-thread" } });
      send({ id: 852, method: "currentTime/read", params: {} });
      send({ id: 853, method: "unreviewed/serverRequest", params: { threadId: thread.id } });
    }
    if (mode === "approval") send({ id: approvalId, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: "turn-1", command: "echo fixture" } });
    if (mode==="dynamic-cold-resume") {
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
