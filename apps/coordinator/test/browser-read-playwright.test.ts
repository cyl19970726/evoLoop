import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RuntimeBinding } from "@evoloop/contracts/runtime";
import { BrowserReadBridge, createPlaywrightBrowserBackend, validPngBase64, type BrowserReadScope } from "../src/runtime/browser-read.js";

const modulePath=process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
test("optional isolated Chromium enforces the browser request boundary",{skip:!modulePath},async t=>{
  const projectId="11111111-1111-4111-8111-111111111111";
  const taskId="22222222-2222-4222-8222-222222222222";
  const sessionId="33333333-3333-4333-8333-333333333333";
  const runId="44444444-4444-4444-8444-444444444444";
  const projectRoot=`/api/projects/${projectId}`;
  const foreignProjectRoot=`/api/projects/${runId}`;
  const taskPath=`/api/projects/${projectId}/tasks/${taskId}`;
  const reportHash=`#/p/${projectId}/reports`;
  const auditHash=`#/p/${projectId}/audit`;
  const taskHash=`#/p/${projectId}/tasks/${taskId}`;
  const basisHash=`${taskHash}?tab=basis`;
  const redirectPath=`/api/projects/${projectId}/redirect`;
  const downloadPath=`/api/projects/${projectId}/download`;
  const largePath=`/api/projects/${projectId}/large`;
  const slowPath=`/api/projects/${projectId}/slow`;
  const compressedPath=`/api/projects/${projectId}/compressed`;
  const observed:string[]=[];
  const foreign:string[]=[];
  const foreignServer=createServer((request,response)=>{foreign.push(request.url??"");response.end("foreign");});
  await new Promise<void>(resolve=>foreignServer.listen(0,"127.0.0.1",resolve));
  t.after(()=>foreignServer.close());
  const foreignPort=(foreignServer.address() as AddressInfo).port;
  const token="reader-token-sentinel-0123456789";
  const server=createServer((request,response)=>{
    const path=request.url??"";observed.push(`${request.method} ${path}`);
    if (path==="/") {
      response.setHeader("content-type","text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><form><input id="token" type="password"><button type="submit">Enter</button></form><main id="app"></main><span id="project-title"></span><span id="large"></span><span id="slow"></span><span id="compressed"></span>
        <a href="${reportHash}">Visible report link</a>
        <a href="${taskHash}">Return to overview</a>
        <div role="tablist"><button type="button" role="tab" id="task-tab-${projectId}-${taskId}-current-basis" aria-controls="task-panel-${projectId}-${taskId}-current-basis">Basis tab</button></div>
        <section id="task-panel-${projectId}-${taskId}-current-basis" hidden>VISIBLE BASIS PANEL</section>
        <section style="display:none"><div><span>HIDDEN OLD ROUTE</span><a href="${auditHash}">Hidden audit link</a></div></section>
        <details><summary>Evidence section</summary><p>COLLAPSED EVIDENCE BODY</p></details>
        <section>${"LONG REPORT ".repeat(2500)}END OF LONG REPORT</section>
        <script>
        document.querySelector('form').addEventListener('submit',async event=>{
          event.preventDefault();
          const token=document.querySelector('#token').value;
          const result=await fetch('/api/session',{headers:{authorization:'Bearer '+token}});
          if(!result.ok)return;
          document.querySelector('form').remove();
          fetch('${projectRoot}',{headers:{authorization:'Bearer '+token}})
            .then(response=>response.json()).then(project=>{document.querySelector('#project-title').textContent=project.title;}).catch(()=>{});
          fetch('${foreignProjectRoot}',{headers:{authorization:'Bearer '+token}}).catch(()=>{});
          fetch('${taskPath}',{method:'POST'}).catch(()=>{});
          fetch('http://127.0.0.1:${foreignPort}/foreign').catch(()=>{});
          fetch('${redirectPath}').catch(()=>{});
          fetch('${downloadPath}').catch(()=>{});
          fetch('${largePath}').then(()=>{document.querySelector('#large').textContent='LARGE LEAK';}).catch(()=>{document.querySelector('#large').textContent='large blocked';});
          fetch('${slowPath}').then(()=>{document.querySelector('#slow').textContent='SLOW LEAK';}).catch(()=>{document.querySelector('#slow').textContent='slow blocked';});
          fetch('${compressedPath}').then(()=>{document.querySelector('#compressed').textContent='COMPRESSED LEAK';}).catch(()=>{document.querySelector('#compressed').textContent='compressed blocked';});
          try{new WebSocket('ws://127.0.0.1:' + location.port + '/ws')}catch{}
          navigator.serviceWorker?.register('/sw.js').catch(()=>{});
        });
        window.addEventListener('hashchange',async()=>{
          document.querySelector('#task-panel-${projectId}-${taskId}-current-basis').hidden=location.hash!=='${basisHash}';
          if(location.hash==='${reportHash}')setTimeout(()=>{location.hash='${auditHash}';},700);
          try{const result=await fetch('${taskPath}');document.querySelector('#app').textContent='HTTP '+result.status+' Permission denied';}
          catch{document.querySelector('#app').textContent='request blocked';}
        });
        </script></body></html>`);
    } else if(path==="/api/session") {
      response.writeHead(request.headers.authorization===`Bearer ${token}`?200:403,{"content-type":"application/json"});
      response.end(JSON.stringify({principal:{actorId:"reader",projectIds:[projectId],permissions:["read"]}}));
    } else if(path===projectRoot) {
      response.writeHead(request.headers.authorization===`Bearer ${token}`?200:403,{"content-type":"application/json"});
      response.end(JSON.stringify({id:projectId,title:"Fixture Project"}));
    } else if(path===taskPath && request.method==="GET") {
      response.writeHead(403,{"content-type":"application/json"});response.end('{"error":"Permission denied"}');
    } else if(path===redirectPath) {response.writeHead(302,{location:"/redirect-target"});response.end();}
    else if(path===downloadPath) {response.writeHead(200,{"content-disposition":"attachment; filename=secret.txt"});response.end("secret");}
    else if(path===largePath) {response.writeHead(200,{"content-type":"text/plain"});for(let index=0;index<82;index++)response.write(Buffer.alloc(65536,65));response.end();}
    else if(path===slowPath) {response.writeHead(200,{"content-type":"text/plain"});response.write("partial");setTimeout(()=>response.end("late"),600);}
    else if(path===compressedPath) {response.writeHead(200,{"content-encoding":"gzip"});response.end("untrusted compressed body");}
    else {response.writeHead(200);response.end("unexpected");}
  });
  server.on("upgrade",(_request,socket)=>{observed.push("UPGRADE /ws");socket.destroy();});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>server.close());
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scope:BrowserReadScope={enabled:true,projectId,taskId,contentRevisionId:"55555555-5555-4555-8555-555555555555",
    sessionId,runId,runOperationId:"66666666-6666-4666-8666-666666666666",roleId:"temporary-experience",
    authorizationScope:"fixture",cwd:"/tmp/fixture",authorizationKind:"dynamic",sandbox:"workspace-write",readerActorId:"reader",
    origin,expiresAtUtc:new Date(Date.now()+60_000).toISOString(),entryRouteKey:"task",routes:[
      {key:"task",hash:taskHash,apiPaths:[projectRoot,taskPath,redirectPath,downloadPath,largePath,slowPath,compressedPath]},
      {key:"basis",hash:basisHash,apiPaths:[taskPath]},
      {key:"report",hash:reportHash,apiPaths:[taskPath]},
      {key:"audit",hash:auditHash,apiPaths:[taskPath]}]};
  const directory=await mkdtemp(join(tmpdir(),"evoloop-browser-real-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const scopePath=join(directory,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  const binding:RuntimeBinding={projectId,sessionId,roleId:scope.roleId,authorizationScope:scope.authorizationScope,
    cwd:scope.cwd,nativeThreadId:"owned",nativeSessionId:"owned-session",owner:"evoloop-codex-app-server"};
  const bridge=new BrowserReadBridge({scopePath,testOrigin:origin,backend:()=>createPlaywrightBrowserBackend(modulePath!,scopePath,origin,200),
    authorize:async()=>token});
  t.after(()=>bridge.close());
  const nav=await bridge.call({threadId:"owned",turnId:"turn",callId:"nav",tool:"browser_navigate",arguments:{routeKey:"task"}},binding);
  assert.equal(nav.success,true);
  let snapshot="";
  for(let attempt=0;attempt<15;attempt++){
    const read=await bridge.call({threadId:"owned",turnId:"turn",callId:`snapshot-${attempt}`,tool:"browser_snapshot",arguments:{}},binding);
    snapshot=read.contentItems[0]?.type==="inputText"?read.contentItems[0].text:"";
    if(snapshot.includes("HTTP 403") && snapshot.includes("Fixture Project"))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.match(snapshot,/HTTP 403 Permission denied/);
  assert.match(snapshot,/Fixture Project/);
  assert.equal(snapshot.includes(token),false);
  const first=JSON.parse(snapshot) as {text:string;links:{routeKey:string}[];tabs:{routeKey:string}[];partial:boolean;hasMore:boolean;collapsedDetails:number};
  assert.equal(first.text.includes("HIDDEN OLD ROUTE"),false);
  assert.equal(first.text.includes("COLLAPSED EVIDENCE BODY"),false);
  assert.equal(first.text.includes("Evidence section"),true);
  assert.equal(first.collapsedDetails,1);
  assert.equal(first.partial,true);
  assert.equal(first.hasMore,true);
  assert.equal(first.links.some(link=>link.routeKey==="audit"),false);
  assert.equal(first.links.some(link=>link.routeKey==="report"),true);
  assert.equal(first.tabs.some(tab=>tab.routeKey==="basis"),true);
  let allText=first.text;
  for(let index=0;index<10;index++){
    const next=await bridge.call({threadId:"owned",turnId:"turn",callId:`more-${index}`,tool:"browser_read_more",arguments:{}},binding);
    assert.equal(next.success,true);
    const chunk=JSON.parse(next.contentItems[0]?.type==="inputText"?next.contentItems[0].text:"{}");
    allText+=chunk.text;
    if(!chunk.hasMore)break;
  }
  assert.match(allText,/END OF LONG REPORT/);
  assert.equal(allText.includes("HIDDEN OLD ROUTE"),false);
  const expanded=await bridge.call({threadId:"owned",turnId:"turn",callId:"expand",tool:"browser_expand_details",arguments:{}},binding);
  assert.equal(expanded.success,true);
  const afterExpand=await bridge.call({threadId:"owned",turnId:"turn",callId:"after-expand",tool:"browser_snapshot",arguments:{}},binding);
  assert.equal(afterExpand.success,true);
  assert.match(afterExpand.contentItems[0]?.type==="inputText"?afterExpand.contentItems[0].text:"",/COLLAPSED EVIDENCE BODY/);
  const shot=await bridge.call({threadId:"owned",turnId:"turn",callId:"shot",tool:"browser_screenshot",arguments:{}},binding);
  assert.equal(shot.success,true);
  assert.equal(shot.contentItems[0]?.type,"inputImage");
  if(shot.contentItems[0]?.type==="inputImage") assert.equal(validPngBase64(shot.contentItems[0].imageUrl.slice("data:image/png;base64,".length)),true);
  const receiptStem=`${runId}-${createHash("sha256").update("shot").digest("hex")}`;
  const receiptDir=join(directory,"receipts"),pngPath=join(receiptDir,`${receiptStem}.png`);
  const provenancePath=join(receiptDir,`${receiptStem}.json`);
  const savedPng=await readFile(pngPath),provenance=JSON.parse(await readFile(provenancePath,"utf8"));
  assert.equal((await lstat(receiptDir)).mode&0o777,0o700);
  assert.equal((await lstat(pngPath)).mode&0o777,0o600);
  assert.equal((await lstat(provenancePath)).mode&0o777,0o600);
  assert.equal(validPngBase64(savedPng.toString("base64")),true);
  assert.equal(provenance.sha256,createHash("sha256").update(savedPng).digest("hex"));
  assert.equal(provenance.bytes,savedPng.length);
  assert.equal(provenance.pageHash,taskHash);
  assert.equal(provenance.runId,runId);
  assert.equal(provenance.nativeThreadId,"owned");
  assert.equal(provenance.turnId,"turn");
  assert.equal(provenance.callId,"shot");
  const receiptText=shot.contentItems[1]?.type==="inputText"?shot.contentItems[1].text:"";
  assert.ok(receiptText.includes(pngPath) && receiptText.includes(provenancePath) && receiptText.includes(provenance.sha256));
  assert.equal((receiptText+JSON.stringify(provenance)).includes(token),false);
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.ok(observed.includes(`GET ${taskPath}`));
  assert.ok(observed.includes(`GET ${projectRoot}`));
  assert.equal(observed.includes(`GET ${foreignProjectRoot}`),false);
  assert.ok(observed.includes(`GET ${redirectPath}`));
  assert.ok(observed.includes(`GET ${downloadPath}`));
  assert.ok(observed.includes(`GET ${largePath}`));
  assert.ok(observed.includes(`GET ${slowPath}`));
  assert.ok(observed.includes(`GET ${compressedPath}`));
  const deniedBodies=await bridge.call({threadId:"owned",turnId:"turn",callId:"bounded",tool:"browser_snapshot",arguments:{}},binding);
  assert.equal(deniedBodies.success,true);
  const deniedText=deniedBodies.contentItems[0]?.type==="inputText"?deniedBodies.contentItems[0].text:"";
  assert.match(deniedText,/large blocked/);
  assert.match(deniedText,/slow blocked/);
  assert.match(deniedText,/compressed blocked/);
  assert.equal(deniedText.includes("LEAK"),false);
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"basis-tab",tool:"browser_navigate",arguments:{routeKey:"basis"}},binding)).success,true);
  const basisPage=await bridge.call({threadId:"owned",turnId:"turn",callId:"basis-read",tool:"browser_snapshot",arguments:{}},binding);
  assert.match(basisPage.contentItems[0]?.type==="inputText"?basisPage.contentItems[0].text:"",/VISIBLE BASIS PANEL/);
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"overview-link",tool:"browser_navigate",arguments:{routeKey:"task"}},binding)).success,true);
  assert.equal(observed.some(item=>item.startsWith("POST ")),false);
  assert.equal(observed.includes("GET /redirect-target"),false);
  assert.equal(observed.includes("GET /sw.js"),false);
  assert.equal(observed.includes("UPGRADE /ws"),false);
  assert.deepEqual(foreign,[]);
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"hidden-link",tool:"browser_navigate",arguments:{routeKey:"audit"}},binding)).success,false);
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"restart",tool:"browser_navigate",arguments:{routeKey:"task"}},binding)).success,true);
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"visible-link",tool:"browser_navigate",arguments:{routeKey:"report"}},binding)).success,true);
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"route-drift",tool:"browser_snapshot",arguments:{}},binding)).success,false);
  const rejectedBridge=new BrowserReadBridge({scopePath,testOrigin:origin,
    backend:()=>createPlaywrightBrowserBackend(modulePath!,scopePath,origin,200),authorize:async()=>"wrong-reader-token-sentinel"});
  t.after(()=>rejectedBridge.close());
  const rejected=await rejectedBridge.call({threadId:"owned",turnId:"turn",callId:"reader-denied",tool:"browser_navigate",arguments:{routeKey:"task"}},binding);
  assert.deepEqual(rejected,{contentItems:[{type:"inputText",text:"Reader identity denied (HTTP 403)"}],success:false});
});

test("isolated Chromium follows complete Task pages for every status and TaskDetail GET",{skip:!modulePath},async t=>{
  const projectId="11111111-1111-4111-8111-111111111111";
  const taskId="22222222-2222-4222-8222-222222222222";
  const sessionId="33333333-3333-4333-8333-333333333333";
  const runId="44444444-4444-4444-8444-444444444444";
  const taskAt=(index:number)=>`00000000-0000-4000-8000-${index.toString(16).padStart(12,"0")}`;
  const firstIds=Array.from({length:50},(_,index)=>taskAt(index+1));
  const secondIds=Array.from({length:7},(_,index)=>taskAt(index+51));
  const base=`/api/projects/${projectId}`;
  const first=`${base}/tasks?limit=50`,second=`${first}&cursor=${encodeURIComponent("opaque/+cursor")}`;
  const status=(ids:string[])=>`${base}/orchestration/work-status?taskIds=${ids.join(",")}`;
  const workHash=`#/p/${projectId}/work`;
  const token="reader-token-sentinel-0123456789";
  const observed:string[]=[];
  const server=createServer((request,response)=>{
    const path=request.url??"";observed.push(`${request.method} ${path}`);
    if(path==="/"){
      response.setHeader("content-type","text/html");
      response.end(`<!doctype html><html><body><form><input id="token"><button type="submit">Enter</button></form><main id="result"></main><script>
      let token;
      const get=path=>fetch(path,{headers:{authorization:'Bearer '+token}}).then(async response=>{
        if(!response.ok)throw new Error('read denied');return response.json();});
      document.querySelector('form').addEventListener('submit',async event=>{
        event.preventDefault();token=document.querySelector('#token').value;
        const session=await get('/api/session');if(!session.principal)throw new Error('login');
        document.querySelector('form').remove();
      });
      window.addEventListener('hashchange',async()=>{
        try{
          const first=await get('${first}');
          const firstStatus=await get('${status(firstIds)}');
          const second=await get('${second}');
          const secondStatus=await get('${status(secondIds)}');
          const tasks=[...first.items,...second.items];
          const details=await Promise.all(tasks.map(task=>get('${base}/tasks/'+task.id)));
          document.querySelector('#result').textContent='Loaded '+tasks.length+' Tasks, '+
            (firstStatus.items.length+secondStatus.items.length)+' statuses, '+details.length+' details, '+
            firstStatus.items.filter(item=>item.cognition).length+' cognition';
        }catch(error){document.querySelector('#result').textContent='Task page denied';}
      });
      </script></body></html>`);
    } else if(path==="/api/session"){
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({principal:{actorId:"reader",projectIds:[projectId],permissions:["read"]}}));
    } else if(path===first || path===second){
      const ids=path===first?firstIds:secondIds;
      const complete=()=>{response.writeHead(200,{"content-type":"application/json"});
        response.end(JSON.stringify({items:ids.map(id=>({id,projectId,title:id,state:"todo"})),
          nextCursor:path===first?"opaque/+cursor":null}));};
      if(path===first)setTimeout(complete,550);else complete();
    } else if(path===status(firstIds) || path===status(secondIds)){
      const ids=path===status(firstIds)?firstIds:secondIds;
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({items:ids.map(taskId=>({taskId,cognition:taskId===taskAt(50)}))}));
    } else if(/^\/api\/projects\/[0-9a-f-]+\/tasks\/[0-9a-f-]+$/.test(path)){
      const id=path.slice(path.lastIndexOf("/")+1);
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({task:{id,projectId,kind:null}}));
    } else {response.writeHead(404);response.end("missing");}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>server.close());
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scope:BrowserReadScope={enabled:true,followTaskList:true,projectId,taskId,
    contentRevisionId:"55555555-5555-4555-8555-555555555555",sessionId,runId,
    runOperationId:"66666666-6666-4666-8666-666666666666",roleId:"temporary-experience",
    authorizationScope:"fixture",cwd:"/tmp/fixture",authorizationKind:"dynamic",sandbox:"workspace-write",
    readerActorId:"reader",origin,expiresAtUtc:new Date(Date.now()+60_000).toISOString(),entryRouteKey:"work",
    routes:[{key:"work",hash:workHash,apiPaths:[first]}]};
  const directory=await mkdtemp(join(tmpdir(),"evoloop-browser-listed-real-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const scopePath=join(directory,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  const binding:RuntimeBinding={projectId,sessionId,roleId:scope.roleId,authorizationScope:scope.authorizationScope,
    cwd:scope.cwd,nativeThreadId:"owned",nativeSessionId:"owned-session",owner:"evoloop-codex-app-server"};
  const bridge=new BrowserReadBridge({scopePath,testOrigin:origin,
    backend:()=>createPlaywrightBrowserBackend(modulePath!,scopePath,origin,1000),authorize:async()=>token});
  t.after(()=>bridge.close());
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"nav",tool:"browser_navigate",
    arguments:{routeKey:"work"}},binding)).success,true);
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"early-snapshot",
    tool:"browser_snapshot",arguments:{}},binding)).success,true,
    "a new tool call must not cancel the still-authorized first page response");
  let observedText="";
  for(let attempt=0;attempt<30;attempt++){
    const snap=await bridge.call({threadId:"owned",turnId:"turn",callId:`snapshot-${attempt}`,
      tool:"browser_snapshot",arguments:{}},binding);
    observedText=snap.contentItems[0]?.type==="inputText"?snap.contentItems[0].text:"";
    if(observedText.includes("57 details") || observedText.includes("Task page denied"))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.match(observedText,/57 Tasks, 57 statuses, 57 details, 1 cognition/);
  assert.ok(observed.includes(`GET ${first}`));
  assert.ok(observed.includes(`GET ${second}`));
  assert.ok(observed.includes(`GET ${status(firstIds)}`));
  assert.ok(observed.includes(`GET ${status(secondIds)}`));
  for(const id of [...firstIds,...secondIds])assert.ok(observed.includes(`GET ${base}/tasks/${id}`),id);
  assert.equal(observed.some(entry=>entry.startsWith("POST ")),false);
});

const builtWorkbench=fileURLToPath(new URL("../../workbench/dist/",import.meta.url));
test("built WorkIndex and JourneyBoard read every listed Task through the guarded context",
  {skip:!modulePath || !existsSync(join(builtWorkbench,"index.html"))},async t=>{
  const projectId="11111111-1111-4111-8111-111111111111";
  const taskId="22222222-2222-4222-8222-222222222222";
  const sessionId="33333333-3333-4333-8333-333333333333";
  const runId="44444444-4444-4444-8444-444444444444";
  const taskAt=(index:number)=>`00000000-0000-4000-8000-${index.toString(16).padStart(12,"0")}`;
  const task=(index:number)=>({projectId,id:taskAt(index),version:1,currentRevisionId:taskAt(index+1000),
    title:`Fixture Task ${index}`,content:`Body ${index}`,contentDocumentId:taskAt(index+2000),
    contentRevisionId:taskAt(index+3000),kind:null,acceptance:"Read",owner:"fixture",state:"todo"});
  const firstTasks=Array.from({length:50},(_,index)=>task(index+1));
  const secondTasks=Array.from({length:7},(_,index)=>task(index+51));
  const document=(index:number)=>({projectId,id:taskAt(index+5000),title:`Fixture Document ${index}`,version:1,
    currentRevisionId:taskAt(index+6000),adoptedRevisionId:taskAt(index+6000),kind:"report",status:"published",
    primaryTaskId:null,origin:null});
  const firstDocuments=Array.from({length:50},(_,index)=>document(index+1));
  const secondDocuments=Array.from({length:18},(_,index)=>document(index+51));
  const base=`/api/projects/${projectId}`;
  const first=`${base}/tasks?limit=50`,second=`${first}&cursor=${taskAt(50)}`;
  const firstDocumentPage=`${base}/documents?limit=50`;
  const secondDocumentPage=`${firstDocumentPage}&cursor=${taskAt(5050)}`;
  const status=(items:ReturnType<typeof task>[])=>`${base}/orchestration/work-status?taskIds=${items.map(item=>item.id).join(",")}`;
  // The task list persists its initial preview selection in the URL. Pin that
  // exact route so the read-only browser keeps its original navigation boundary.
  const workHash=`#/p/${projectId}/work?selected=${firstTasks[0].id}`,journeyHash=`#/p/${projectId}/journey`;
  const token="built-app-reader-token-sentinel-0123456789";
  const observed:string[]=[];
  const server=createServer(async(request,response)=>{
    const path=request.url??"";observed.push(`${request.method} ${path}`);
    if(path==="/" || path.startsWith("/assets/")){
      const relative=path==="/"?"index.html":path.slice(1);
      if(!/^(?:index\.html|assets\/[A-Za-z0-9._/-]+)$/.test(relative) || relative.includes("..")){
        response.writeHead(404);response.end();return;
      }
      try{
        let bytes=await readFile(join(builtWorkbench,relative));
        if(relative==="index.html"){
          // Test-only user click: the worker bridge itself still exposes no click or script tool.
          const autoMore=`<script>addEventListener('hashchange',()=>{if(location.hash!=='${workHash}')return;
            const timer=setInterval(()=>{const button=[...document.querySelectorAll('button')]
              .find(item=>item.textContent?.trim()==='加载更多');if(button){button.click();clearInterval(timer);}},50);
            setTimeout(()=>clearInterval(timer),5000);});</script>`;
          bytes=Buffer.from(bytes.toString("utf8").replace("</body>",`${autoMore}</body>`));
        }
        response.writeHead(200,{"content-type":relative.endsWith(".js")?"text/javascript":
          relative.endsWith(".css")?"text/css":"text/html; charset=utf-8"});response.end(bytes);
      }catch{response.writeHead(404);response.end();}
      return;
    }
    if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(403);response.end();return;}
    const json=(value:unknown)=>{response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify(value));};
    if(path==="/api/session")return json({principal:{actorId:"reader",projectIds:[projectId],permissions:["read"]},capabilities:{}});
    if(path===base)return json({id:projectId,title:"Built App Fixture"});
    if(path===first)return json({items:firstTasks,nextCursor:taskAt(50)});
    if(path===second)return json({items:secondTasks,nextCursor:null});
    if(path===firstDocumentPage)return json({items:firstDocuments,nextCursor:taskAt(5050)});
    if(path===secondDocumentPage)return json({items:secondDocuments,nextCursor:null});
    if(path===status(firstTasks) || path===status(secondTasks)){
      const items=path===status(firstTasks)?firstTasks:secondTasks;
      return json({items:items.map(item=>({taskId:item.id,cognition:item.id===taskAt(50),
        sourceKind:null,sourceTaskTitle:null,goalOutcome:null,stageDeliverable:null,runState:null,
        dispatchState:null,unsettledRunState:null,hasClosure:false,readyForAcceptance:false,deliveryId:null}))});
    }
    if(path===`${base}/goals?limit=50`)return json({items:[],nextCursor:null});
    if(path===`${base}/impacts` || path===`${base}/stages`)return json([]);
    const detail=/^\/api\/projects\/([0-9a-f-]{36})\/tasks\/([0-9a-f-]{36})$/.exec(path);
    if(detail?.[1]===projectId){
      const found=[...firstTasks,...secondTasks].find(item=>item.id===detail[2]);
      if(found)return json({task:found,revision:{id:found.currentRevisionId},basis:null,links:[],impacts:[],decisions:[],proposal:null,deliveries:[]});
    }
    response.writeHead(404);response.end("missing");
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scope:BrowserReadScope={enabled:true,followTaskList:true,followDocumentList:true,projectId,taskId,
    contentRevisionId:"55555555-5555-4555-8555-555555555555",sessionId,runId,
    runOperationId:"66666666-6666-4666-8666-666666666666",roleId:"temporary-experience",
    authorizationScope:"fixture",cwd:"/tmp/fixture",authorizationKind:"dynamic",sandbox:"workspace-write",
    readerActorId:"reader",origin,expiresAtUtc:new Date(Date.now()+60_000).toISOString(),entryRouteKey:"work",
    routes:[{key:"work",hash:workHash,apiPaths:[base,first,firstDocumentPage,`${base}/impacts`]},
      {key:"journey",hash:journeyHash,apiPaths:[first,`${base}/goals?limit=50`,`${base}/stages`,firstDocumentPage]}]};
  const directory=await mkdtemp(join(tmpdir(),"evoloop-browser-built-app-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const scopePath=join(directory,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  const binding:RuntimeBinding={projectId,sessionId,roleId:scope.roleId,authorizationScope:scope.authorizationScope,
    cwd:scope.cwd,nativeThreadId:"owned",nativeSessionId:"owned-session",owner:"evoloop-codex-app-server"};
  const bridge=new BrowserReadBridge({scopePath,testOrigin:origin,
    backend:()=>createPlaywrightBrowserBackend(modulePath!,scopePath,origin,1000),authorize:async()=>token});
  t.after(()=>bridge.close());
  const call=(tool:string,callId:string,args:Record<string,unknown>={})=>bridge.call({threadId:"owned",turnId:"turn",
    callId,tool,arguments:args},binding);
  assert.equal((await call("browser_navigate","work-nav",{routeKey:"work"})).success,true);
  let workText="";
  for(let attempt=0;attempt<35;attempt++){
    const result=await call("browser_snapshot",`work-snapshot-${attempt}`);
    workText=result.contentItems[0]?.type==="inputText"?JSON.parse(result.contentItems[0].text).text:"";
    if(/已载入\s*57\s*项/.test(workText) && observed.includes(`GET ${status(secondTasks)}`))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.match(workText,/已载入\s*57\s*项/);
  assert.equal(workText.includes("工作状态暂不可读"),false);
  assert.ok(observed.includes(`GET ${status(firstTasks)}`));
  assert.ok(observed.includes(`GET ${status(secondTasks)}`));
  assert.equal((await call("browser_navigate","journey-nav",{routeKey:"journey"})).success,true);
  let journeyText="";
  for(let attempt=0;attempt<50;attempt++){
    const result=await call("browser_snapshot",`journey-snapshot-${attempt}`);
    journeyText=result.contentItems[0]?.type==="inputText"?JSON.parse(result.contentItems[0].text).text:"";
    if(/另有\s*57\s*项任务/.test(journeyText) && /文档\s*68\s*项已完整读取/.test(journeyText))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.match(journeyText,/另有\s*57\s*项任务/);
  assert.match(journeyText,/文档\s*68\s*项已完整读取/);
  assert.equal(journeyText.includes("任务关联未完整读取"),false);
  assert.ok(observed.includes(`GET ${second}`));
  assert.ok(observed.includes(`GET ${secondDocumentPage}`));
  for(const item of [...firstTasks,...secondTasks])assert.ok(observed.includes(`GET ${base}/tasks/${item.id}`),item.id);
  assert.equal(observed.some(item=>item.startsWith(`GET ${base}/documents/`)),false);
  assert.equal(observed.some(item=>item.startsWith("POST ")),false);
});

test("a list response finishing after its tool call is cancelled grants no TaskDetail path",
  {skip:!modulePath},async t=>{
  const projectId="11111111-1111-4111-8111-111111111111";
  const taskId="22222222-2222-4222-8222-222222222222";
  const sessionId="33333333-3333-4333-8333-333333333333";
  const runId="44444444-4444-4444-8444-444444444444";
  const listedTask="00000000-0000-4000-8000-000000000001";
  const first=`/api/projects/${projectId}/tasks?limit=50`;
  const detail=`/api/projects/${projectId}/tasks/${listedTask}`;
  const workHash=`#/p/${projectId}/work`;
  const token="cancelled-reader-token-sentinel-0123456789";
  const observed:string[]=[];
  const server=createServer((request,response)=>{
    const path=request.url??"";observed.push(`${request.method} ${path}`);
    if(path==="/"){
      response.writeHead(200,{"content-type":"text/html"});
      response.end(`<!doctype html><html><body><form><input id="token"><button type="submit">Enter</button></form><main id="result"></main><script>
        let token;document.querySelector('form').addEventListener('submit',async event=>{
          event.preventDefault();token=document.querySelector('#token').value;
          await fetch('/api/session',{headers:{authorization:'Bearer '+token}});document.querySelector('form').remove();});
        addEventListener('hashchange',()=>{
          fetch('${first}',{headers:{authorization:'Bearer '+token}}).catch(()=>{});
          setTimeout(()=>fetch('${detail}',{headers:{authorization:'Bearer '+token}})
            .then(()=>document.querySelector('#result').textContent='detail reached')
            .catch(()=>document.querySelector('#result').textContent='detail blocked'),1500);
        });</script></body></html>`);
    }else if(path==="/api/session"){
      response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({principal:{actorId:"reader",projectIds:[projectId],permissions:["read"]}}));
    }else if(path===first){
      setTimeout(()=>{response.writeHead(200,{"content-type":"application/json"});
        response.end(JSON.stringify({items:[{id:listedTask,projectId}],nextCursor:null}));},650);
    }else if(path===detail){response.writeHead(200,{"content-type":"application/json"});response.end("{}");}
    else{response.writeHead(404);response.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scope:BrowserReadScope={enabled:true,followTaskList:true,projectId,taskId,
    contentRevisionId:"55555555-5555-4555-8555-555555555555",sessionId,runId,
    runOperationId:"66666666-6666-4666-8666-666666666666",roleId:"temporary-experience",
    authorizationScope:"fixture",cwd:"/tmp/fixture",authorizationKind:"dynamic",sandbox:"workspace-write",
    readerActorId:"reader",origin,expiresAtUtc:new Date(Date.now()+60_000).toISOString(),entryRouteKey:"work",
    routes:[{key:"work",hash:workHash,apiPaths:[first]}]};
  const directory=await mkdtemp(join(tmpdir(),"evoloop-browser-cancelled-list-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const scopePath=join(directory,"scope.json");await writeFile(scopePath,JSON.stringify(scope),{mode:0o600});
  const binding:RuntimeBinding={projectId,sessionId,roleId:scope.roleId,authorizationScope:scope.authorizationScope,
    cwd:scope.cwd,nativeThreadId:"owned",nativeSessionId:"owned-session",owner:"evoloop-codex-app-server"};
  const bridge=new BrowserReadBridge({scopePath,testOrigin:origin,
    backend:()=>createPlaywrightBrowserBackend(modulePath!,scopePath,origin,1000),authorize:async()=>token});
  t.after(()=>bridge.close());
  const controller=new AbortController();
  assert.equal((await bridge.call({threadId:"owned",turnId:"turn",callId:"nav",tool:"browser_navigate",
    arguments:{routeKey:"work"},signal:controller.signal},binding)).success,true);
  controller.abort();
  await new Promise(resolve=>setTimeout(resolve,900));
  let observedText="";
  for(let attempt=0;attempt<12;attempt++){
    const read=await bridge.call({threadId:"owned",turnId:"turn",callId:`snapshot-${attempt}`,
      tool:"browser_snapshot",arguments:{}},binding);
    observedText=read.contentItems[0]?.type==="inputText"?read.contentItems[0].text:"";
    if(observedText.includes("detail blocked"))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.match(observedText,/detail blocked/);
  assert.ok(observed.includes(`GET ${first}`));
  assert.equal(observed.includes(`GET ${detail}`),false);
});
