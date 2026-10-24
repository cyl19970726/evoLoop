import { lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { request as httpRequest, type ClientRequest } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { RuntimeBinding, RuntimeSessionSpec } from "@evoloop/contracts/runtime";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { Task } from "@evoloop/contracts";
import type { DynamicToolCall, DynamicToolResult, DynamicToolSpec } from "@evoloop/adapter-codex-app-server";

export const BROWSER_ORIGIN = "http://127.0.0.1:55431";
const uuid = z.uuid();
const uriSuffix = "[A-Za-z0-9._~!$&'()*+,;=:@/?%-]+";
const route = z.strictObject({key:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  hash:z.string().max(2048).regex(new RegExp(`^#/p/[0-9a-f-]{36}/${uriSuffix}$`)),
  apiPaths:z.array(z.string().max(2048).regex(new RegExp(`^/api/projects/[0-9a-f-]{36}(?:/${uriSuffix})?$`))).max(30)});
export const browserReadScopeSchema = z.strictObject({
  enabled:z.literal(true), projectId:uuid, taskId:uuid, contentRevisionId:uuid, sessionId:uuid, runId:uuid,
  runOperationId:uuid, roleId:z.literal("temporary-experience"), authorizationScope:z.string().min(1), cwd:z.string().startsWith("/"),
  authorizationKind:z.enum(["static","dynamic"]),
  sandbox:z.enum(["read-only","workspace-write"]),
  readerActorId:z.string().min(1), origin:z.url(), expiresAtUtc:z.iso.datetime(),
  entryRouteKey:z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  routes:z.array(route).min(1).max(32),
});
export type BrowserReadScope = z.infer<typeof browserReadScopeSchema>;
export interface BrowserReadBackend {
  navigate(scope:BrowserReadScope,token:string,key:string):Promise<void>;
  snapshot(scope:BrowserReadScope):Promise<string>;
  readMore(scope:BrowserReadScope):Promise<string>;
  expandDetails(scope:BrowserReadScope):Promise<string>;
  screenshot(scope:BrowserReadScope):Promise<string>;
  close():Promise<void>;
}
const denied = ():DynamicToolResult => ({contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false});
class ReaderLoginDenied extends Error {
  constructor(readonly status:number){super("Reader identity denied");}
}
const text = (value:string):DynamicToolResult => ({contentItems:[{type:"inputText",text:value}],success:true});
const specs:DynamicToolSpec[] = [
  {type:"function",name:"browser_navigate",description:"Open one preapproved read-only workbench route by routeKey.",inputSchema:{type:"object",properties:{routeKey:{type:"string"}},required:["routeKey"],additionalProperties:false}},
  {type:"function",name:"browser_snapshot",description:"Read visible workbench text and approved links.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
  {type:"function",name:"browser_read_more",description:"Read the next segment of the same visible page after a partial snapshot.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
  {type:"function",name:"browser_expand_details",description:"Expand up to 20 currently visible collapsed sections on the approved page.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
  {type:"function",name:"browser_screenshot",description:"Capture the approved viewport and return a private PNG receipt path and SHA-256.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
];
const exactKeys = (value:Record<string,unknown>,keys:string[]):boolean =>
  Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const sameSpec = (scope:BrowserReadScope,spec:RuntimeSessionSpec):boolean =>
  scope.projectId===spec.projectId && scope.sessionId===spec.sessionId && scope.roleId===spec.roleId &&
  scope.authorizationScope===spec.authorizationScope && scope.cwd===spec.cwd && spec.sandbox===scope.sandbox;

async function readBrowserScope(path:string,now:number,expectedOrigin=BROWSER_ORIGIN):Promise<BrowserReadScope|null> {
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try {
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const file=await handle.stat();
    if (!file.isFile() || file.mode&0o077 ||
      process.getuid && file.uid!==process.getuid()) return null;
    const scope=browserReadScopeSchema.parse(JSON.parse(await handle.readFile("utf8")));
    if (scope.origin!==expectedOrigin || Date.parse(scope.expiresAtUtc)<=now ||
      !scope.routes.some(route=>route.key===scope.entryRouteKey) ||
      scope.routes.some(route=>!route.hash.startsWith(`#/p/${scope.projectId}/`) ||
        route.apiPaths.some(path=>(path!==`/api/projects/${scope.projectId}` &&
          !path.startsWith(`/api/projects/${scope.projectId}/`)) ||
          new URL(path,scope.origin).pathname+new URL(path,scope.origin).search!==path)) ||
      new Set(scope.routes.map(route=>route.key)).size!==scope.routes.length ||
      new Set(scope.routes.map(route=>route.hash)).size!==scope.routes.length) return null;
    return scope;
  } catch { return null; }
  finally { await handle?.close().catch(()=>{}); }
}
const sameBinding = (scope:BrowserReadScope,binding:RuntimeBinding):boolean =>
  scope.projectId===binding.projectId && scope.sessionId===binding.sessionId && scope.roleId===binding.roleId &&
  scope.authorizationScope===binding.authorizationScope && scope.cwd===binding.cwd;

/** Pure portion of the per-call persisted authority check; no first eligible Run lookup. */
export function matchesBrowserRun(scope:BrowserReadScope,binding:RuntimeBinding,call:DynamicToolCall,
  session:RuntimeSessionRecord,run:RuntimeRunRecord,task:Task,
  currentRevision:{id:string;taskId:string;contentRevisionId:string;basisSetId:string|null}):boolean {
  return sameBinding(scope,binding) && call.threadId===binding.nativeThreadId &&
    session.projectId===scope.projectId && session.id===scope.sessionId && session.state==="ready" &&
    session.nativeThreadId===binding.nativeThreadId && session.nativeSessionId===binding.nativeSessionId &&
    session.roleId===scope.roleId && session.authorizationScope===scope.authorizationScope &&
    session.cwd===scope.cwd && session.sandbox===scope.sandbox &&
    run.projectId===scope.projectId && run.id===scope.runId && run.sessionId===scope.sessionId &&
    run.taskId===scope.taskId &&
    run.operationId===scope.runOperationId && run.actorId===session.actorId && run.state==="running" &&
    !run.interruptRequested && !!run.nativeTurnId && run.nativeTurnId===call.turnId &&
    task.projectId===scope.projectId && task.id===scope.taskId && task.state==="in_progress" &&
    task.contentRevisionId===scope.contentRevisionId && task.owner===scope.roleId &&
    task.currentRevisionId===run.taskRevisionId && currentRevision.id===run.taskRevisionId &&
    currentRevision.taskId===scope.taskId && currentRevision.contentRevisionId===scope.contentRevisionId &&
    !!currentRevision.basisSetId && currentRevision.basisSetId===run.basisSetId;
}

export function readerTokenForScope(scope:BrowserReadScope,
  credentials:readonly {actorId:string;projectIds:string[];permissions:string[];token:string}[]):string|null {
  const readers=credentials.filter(item=>item.actorId===scope.readerActorId);
  const reader=readers.length===1?readers[0]:undefined;
  return reader?.projectIds.length===1 && reader.projectIds[0]===scope.projectId &&
    reader.permissions.length===1 && reader.permissions[0]==="read" ? reader.token : null;
}

function redactBrowserSecrets(value:string,readerToken:string|null):string {
  let output=readerToken?value.replaceAll(readerToken,"[redacted]"):value;
  return output.replace(/Bearer\s+[A-Za-z0-9._~-]{20,}/gi,"Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g,"[redacted]")
    .replace(/(?:set-cookie|cookie|authorization)\s*[:=]\s*[^\s,;"}]+/gi,"[redacted]");
}
export function sanitizeBrowserText(value:string,readerToken:string|null):string {
  return redactBrowserSecrets(value,readerToken).slice(0,20000);
}

export function allowBrowserRequest(scope:BrowserReadScope,urlText:string,method:string,resourceType:string):boolean {
  try {
    const url=new URL(urlText);
    const path=url.pathname+url.search;
    const apiPaths=scope.routes.flatMap(value=>value.apiPaths);
    return url.origin===scope.origin && !url.username && !url.password && method==="GET" &&
      ["document","script","stylesheet","image","font","fetch","xhr"].includes(resourceType) &&
      (path==="/" || /^\/assets\/[a-zA-Z0-9._/-]+$/.test(path) || path==="/api/session" || apiPaths.includes(path));
  } catch { return false; }
}
export function allowBrowserResponse(status:number,size:number,disposition:string|null):boolean {
  return status>=200 && status<=599 && !(status>=300 && status<400) &&
    size<=5_000_000 && !/attachment/i.test(disposition??"");
}
export function isApprovedPageUrl(scope:BrowserReadScope,urlText:string,approvedHash:string|null):boolean {
  if (!approvedHash || !scope.routes.some(route=>route.hash===approvedHash)) return false;
  try {
    const url=new URL(urlText);
    return url.origin===scope.origin && url.pathname==="/" && !url.search && url.hash===approvedHash;
  } catch { return false; }
}
export function validPngBase64(value:string):boolean {
  if (value.length<60 || value.length>2_666_672 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes=Buffer.from(value,"base64");
  if (bytes.length<45 || bytes.length>2_000_000 || bytes.toString("base64")!==value ||
    !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    bytes.readUInt32BE(8)!==13 || bytes.toString("ascii",12,16)!=="IHDR" ||
    bytes.readUInt32BE(16)===0 || bytes.readUInt32BE(20)===0) return false;
  let offset=8, hasImageData=false;
  while (offset+12<=bytes.length) {
    const size=bytes.readUInt32BE(offset);
    if (size>bytes.length-offset-12) return false;
    const kind=bytes.toString("ascii",offset+4,offset+8);
    if (kind==="IDAT") hasImageData=true;
    if (kind==="IEND") return size===0 && hasImageData && offset+12===bytes.length;
    offset+=12+size;
  }
  return false;
}

const sha256=(value:Buffer|string):string=>createHash("sha256").update(value).digest("hex");
type ScreenshotReceipt={projectId:string;taskId:string;contentRevisionId:string;sessionId:string;runId:string;
  runOperationId:string;nativeThreadId:string;turnId:string;callId:string;routeKey:string;pageHash:string;
  atUtc:string;sha256:string;bytes:number;capture:"viewport"};

async function privateReceiptFile(path:string,maxBytes:number):Promise<Buffer|null> {
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try {
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await handle.stat();
    if(!stat.isFile() || stat.size>maxBytes || stat.mode&0o077 ||
      process.getuid && stat.uid!==process.getuid()) throw new Error("invalid private receipt");
    return await handle.readFile();
  } catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
  finally {await handle?.close().catch(()=>{});}
}

async function writePrivateReceiptFile(path:string,bytes:Buffer):Promise<void> {
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try {
    handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await handle.writeFile(bytes);await handle.sync();
  } catch(error) {if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
  finally {await handle?.close().catch(()=>{});}
}

async function persistScreenshotReceipt(scopePath:string,scope:BrowserReadScope,binding:RuntimeBinding,
  call:DynamicToolCall,routeKey:string,pngBase64:string,now:number):Promise<{pngPath:string;jsonPath:string;receipt:ScreenshotReceipt}> {
  if(!validPngBase64(pngBase64) || call.callId.length<1 || call.callId.length>256) throw new Error("invalid screenshot receipt");
  const pageHash=scope.routes.find(route=>route.key===routeKey)?.hash;
  if(!pageHash)throw new Error("unapproved screenshot route");
  const directory=join(dirname(scopePath),"receipts");
  await mkdir(directory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;});
  const directoryStat=await lstat(directory);
  if(!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.mode&0o077 ||
    process.getuid && directoryStat.uid!==process.getuid())throw new Error("invalid receipt directory");
  const stem=`${scope.runId}-${sha256(call.callId)}`;
  const pngPath=join(directory,`${stem}.png`),jsonPath=join(directory,`${stem}.json`);
  const png=Buffer.from(pngBase64,"base64");
  const identity={projectId:scope.projectId,taskId:scope.taskId,contentRevisionId:scope.contentRevisionId,
    sessionId:scope.sessionId,runId:scope.runId,runOperationId:scope.runOperationId,
    nativeThreadId:binding.nativeThreadId,turnId:call.turnId,callId:call.callId,
    routeKey,pageHash,sha256:sha256(png),bytes:png.length,capture:"viewport" as const};
  await writePrivateReceiptFile(pngPath,png);
  const storedPng=await privateReceiptFile(pngPath,2_000_000);
  if(!storedPng?.equals(png))throw new Error("screenshot receipt collision");
  const proposed={...identity,atUtc:new Date(now).toISOString()};
  await writePrivateReceiptFile(jsonPath,Buffer.from(JSON.stringify(proposed)+"\n"));
  const storedJson=await privateReceiptFile(jsonPath,4096);
  if(!storedJson)throw new Error("missing screenshot provenance");
  const parsed=JSON.parse(storedJson.toString("utf8")) as ScreenshotReceipt;
  if(typeof parsed.atUtc!=="string" || Number.isNaN(Date.parse(parsed.atUtc)) ||
    Object.keys(parsed).length!==Object.keys(proposed).length ||
    Object.entries(identity).some(([key,value])=>parsed[key as keyof ScreenshotReceipt]!==value))
    throw new Error("screenshot provenance collision");
  return {pngPath,jsonPath,receipt:parsed};
}

/** Scope is reloaded on every call: removing/changing the external file immediately revokes access. */
export class BrowserReadBridge {
  private backend:BrowserReadBackend|null=null;
  private activeToken:string|null=null;
  private activeScopeJson:string|null=null;
  private activeRouteKey:string|null=null;
  private busy=false;
  private epoch=0;
  constructor(private readonly options:{scopePath:string;backend:()=>Promise<BrowserReadBackend>;
    authorize:(scope:BrowserReadScope,binding:RuntimeBinding,call:DynamicToolCall)=>Promise<string|null>;
    now?:()=>number;testOrigin?:string}) {}
  private async scope():Promise<BrowserReadScope|null> {
    return readBrowserScope(this.options.scopePath,(this.options.now??Date.now)(),this.options.testOrigin??BROWSER_ORIGIN);
  }
  async tools(spec:RuntimeSessionSpec):Promise<DynamicToolSpec[]|undefined> {
    const scope=await this.scope();
    return scope && sameSpec(scope,spec) ? specs : undefined;
  }
  async call(call:DynamicToolCall,binding:RuntimeBinding):Promise<DynamicToolResult> {
    if (this.busy) return denied();
    this.busy=true;
    const epoch=this.epoch;
    try { return await this.perform(call,binding,epoch); }
    finally { if(this.epoch===epoch)this.busy=false; }
  }
  private async perform(call:DynamicToolCall,binding:RuntimeBinding,epoch:number):Promise<DynamicToolResult> {
    const scope=await this.scope();
    if (call.signal?.aborted || epoch!==this.epoch || !scope || !sameBinding(scope,binding) || call.threadId!==binding.nativeThreadId ||
      !specs.some(spec=>spec.name===call.tool)) { if(epoch===this.epoch)await this.close(); return denied(); }
    const args=call.arguments;
    if (call.tool==="browser_navigate" ? !exactKeys(args,["routeKey"]) || typeof args.routeKey!=="string" ||
      !scope.routes.some(route=>route.key===args.routeKey) : !exactKeys(args,[])) return denied();
    try {
      const token=await this.options.authorize(scope,binding,call);
      if (call.signal?.aborted || epoch!==this.epoch) throw new Error("cancelled");
      if (!token) { await this.close(); return denied(); }
      const scopeJson=JSON.stringify(scope);
      const stillAuthorized=async()=>{
        const latest=await this.scope();
        return !call.signal?.aborted && epoch===this.epoch && !!latest && JSON.stringify(latest)===scopeJson &&
          await this.options.authorize(scope,binding,call)===token;
      };
      if (this.backend && (this.activeToken!==token || this.activeScopeJson!==scopeJson)) {
        await this.close();return denied();
      }
      let backend=this.backend;
      if (!backend) {
        const created=await this.options.backend();
        if (call.signal?.aborted || epoch!==this.epoch) {await created.close().catch(()=>{});throw new Error("cancelled");}
        this.backend=created;backend=created;
      }
      if (call.signal?.aborted || epoch!==this.epoch) throw new Error("cancelled");
      this.activeToken=token;
      this.activeScopeJson=scopeJson;
      if (call.tool==="browser_navigate") { await backend.navigate(scope,token,args.routeKey as string);
        if(!await stillAuthorized())throw new Error("cancelled");this.activeRouteKey=args.routeKey as string;
        return text("Approved route opened"); }
      if (call.tool==="browser_snapshot") { const observed=await backend.snapshot(scope);
        if(!await stillAuthorized())throw new Error("cancelled");return text(sanitizeBrowserText(observed,token)); }
      if (call.tool==="browser_read_more") { const observed=await backend.readMore(scope);
        if(!await stillAuthorized())throw new Error("cancelled");return text(sanitizeBrowserText(observed,token)); }
      if (call.tool==="browser_expand_details") { const observed=await backend.expandDetails(scope);
        if(!await stillAuthorized())throw new Error("cancelled");return text(sanitizeBrowserText(observed,token)); }
      const png=await backend.screenshot(scope);
      if (!validPngBase64(png) || !this.activeRouteKey || !await stillAuthorized()) throw new Error("invalid image");
      const saved=await persistScreenshotReceipt(this.options.scopePath,scope,binding,call,this.activeRouteKey,png,
        (this.options.now??Date.now)());
      if(!await stillAuthorized())throw new Error("cancelled");
      return {contentItems:[{type:"inputImage",imageUrl:`data:image/png;base64,${png}`},
        {type:"inputText",text:`Viewport screenshot of approved route ${saved.receipt.routeKey} (${saved.receipt.pageHash}). Private PNG: ${saved.pngPath}; provenance: ${saved.jsonPath}; SHA-256: ${saved.receipt.sha256}; bytes: ${saved.receipt.bytes}. This inspection receipt is not a business Delivery.`}],success:true};
    } catch(error) { if(epoch===this.epoch)await this.close();
      return error instanceof ReaderLoginDenied
        ? {contentItems:[{type:"inputText",text:`Reader identity denied (HTTP ${error.status})`}],success:false}
        : denied(); }
  }
  async close():Promise<void> { this.epoch++;this.busy=false;const backend=this.backend; this.backend=null;
    this.activeToken=null;this.activeScopeJson=null;this.activeRouteKey=null;if(backend)await backend.close().catch(()=>{}); }
}

/** Host-only Playwright backend. The optional module is loaded only after an authorized tool call. */
const PAGE_VISIBILITY_SOURCE = `const visible=element=>{
  for(let child=element;child;child=child.parentElement){
    const style=getComputedStyle(child);
    if(style.display==="none"||style.visibility==="hidden"||style.visibility==="collapse"||
      style.opacity==="0"||style.contentVisibility==="hidden"||
      child.hasAttribute("hidden")||child.hasAttribute("inert")||child.getAttribute("aria-hidden")==="true"||
      child.classList.contains("auth-shell"))return false;
    const parent=child.parentElement;
    if(parent?.tagName==="DETAILS"&&!parent.open){
      const summary=[...parent.children].find(item=>item.tagName==="SUMMARY");
      if(!summary||(child!==summary&&!summary.contains(child)))return false;
    }
  }
  return true;
};`;
const VISIBLE_PAGE_SOURCE = `(()=>{
  ${PAGE_VISIBILITY_SOURCE}
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const lines=[];let size=0,truncated=false,node;
  while((node=walker.nextNode())){
    const parent=node.parentElement;
    if(parent&&!["SCRIPT","STYLE","NOSCRIPT","INPUT","TEXTAREA"].includes(parent.tagName)&&visible(parent)){
      const value=node.textContent?.trim();
      if(value){if(size+value.length>200000){truncated=true;break;}lines.push(value);size+=value.length+1;}
    }
  }
  const links=[...document.querySelectorAll("a[href]")].filter(visible)
    .map(item=>({text:(item.textContent??"").trim().slice(0,120),href:item.href}));
  const tabs=[...document.querySelectorAll("button[role=tab]")].filter(visible)
    .map(item=>({text:(item.textContent??"").trim().slice(0,120),id:item.id,
      controls:item.getAttribute("aria-controls"),disabled:item.disabled}));
  const collapsedDetails=[...document.querySelectorAll("details:not([open])")].filter(visible).length;
  return {text:lines.join("\\n"),links,tabs,collapsedDetails,truncated};
})()`;
const EXPAND_DETAILS_SOURCE = `(()=>{
  ${PAGE_VISIBILITY_SOURCE}
  const sections=[...document.querySelectorAll("details:not([open])")].filter(visible);
  for(const section of sections.slice(0,20))section.open=true;
  return {expanded:Math.min(sections.length,20),remaining:Math.max(0,sections.length-20)};
})()`;
/** Node's HTTP stream is bounded before Playwright receives a body; redirects and compressed bodies fail closed. */
function boundedLocalGet(url:string,authorization:string|null,accept:string|null,
  activeRequests:Set<ClientRequest>,timeoutMs:number):Promise<{status:number;headers:Record<string,string>;body:Buffer}> {
  return new Promise((resolve,reject)=>{
    const headers:Record<string,string>={"accept-encoding":"identity"};
    if (authorization) headers.authorization=authorization;
    if (accept) headers.accept=accept;
    const request=httpRequest(url,{method:"GET",headers},response=>{
      const status=response.statusCode??0;
      const encoding=response.headers["content-encoding"];
      const length=Number(response.headers["content-length"]??0);
      if (!allowBrowserResponse(status,0,String(response.headers["content-disposition"]??"")) ||
        (encoding && encoding!=="identity") || !Number.isFinite(length) || length>5_000_000) {
        request.destroy(new Error("response denied"));return;
      }
      const chunks:Buffer[]=[];let size=0;
      response.on("data",(chunk:Buffer)=>{
        size+=chunk.length;
        if (size>5_000_000) {request.destroy(new Error("response too large"));return;}
        chunks.push(chunk);
      });
      response.on("end",()=>{
        const safeHeaders:Record<string,string>={};
        for (const [name,value] of Object.entries(response.headers)) {
          if (["set-cookie","connection","transfer-encoding","content-length","content-encoding"].includes(name) || value===undefined) continue;
          safeHeaders[name]=Array.isArray(value)?value.join(", "):String(value);
        }
        resolve({status,headers:safeHeaders,body:Buffer.concat(chunks,size)});
      });
      response.on("error",reject);
    });
    activeRequests.add(request);
    request.once("close",()=>activeRequests.delete(request));
    request.on("error",reject);
    request.setTimeout(timeoutMs,()=>request.destroy(new Error("request timeout")));
    request.end();
  });
}
export async function createPlaywrightBrowserBackend(modulePath:string,scopePath:string,expectedOrigin=BROWSER_ORIGIN,
  networkTimeoutMs=10000):Promise<BrowserReadBackend> {
  if (!Number.isInteger(networkTimeoutMs) || networkTimeoutMs<1 || networkTimeoutMs>10000)
    throw new Error("invalid browser network timeout");
  const imported=await import(pathToFileURL(modulePath).href);
  const playwright=imported.default??imported;
  const browser=await playwright.chromium.launch({headless:true,timeout:10000});
  const context=await browser.newContext({acceptDownloads:false,serviceWorkers:"block",bypassCSP:false,
    storageState:{cookies:[],origins:[]}});
  let page:any=null, approvedHash:string|null=null, readerToken:string|null=null;
  const activeRequests=new Set<ClientRequest>();
  let lastSnapshot:{text:string;cursor:number;hash:string}|null=null;
  const readVisible=async(scope:BrowserReadScope)=>{
    if (!page || activeScope?.runId!==scope.runId || !isApprovedPageUrl(scope,page.url(),approvedHash)) throw new Error("no approved page");
    const observed:{text:string;links:{text:string;href:string}[];
      tabs:{text:string;id:string;controls:string|null;disabled:boolean}[];collapsedDetails:number;truncated:boolean}=
      await page.evaluate(VISIBLE_PAGE_SOURCE);
    if (!isApprovedPageUrl(scope,page.url(),approvedHash)) throw new Error("page moved");
    const links=observed.links.flatMap(link=>{
      const route=scope.routes.find(route=>isApprovedPageUrl(scope,link.href,route.hash));
      return route?[{routeKey:route.key,text:redactBrowserSecrets(link.text,readerToken)}]:[];
    }).filter((link,index,array)=>array.findIndex(other=>other.routeKey===link.routeKey)===index);
    const tabs=scope.routes.flatMap(route=>{
      const match=route.hash.match(new RegExp(`^#/p/${scope.projectId}/tasks/([0-9a-f-]{36})\\?tab=(overview|basis|delivery|runtime|history)$`));
      if (!match) return [];
      const [,taskId,tab]=match;
      const button=observed.tabs.find(item=>!item.disabled &&
        item.id===`task-tab-${scope.projectId}-${taskId}-current-${tab}` &&
        item.controls===`task-panel-${scope.projectId}-${taskId}-current-${tab}`);
      return button?[{routeKey:route.key,text:redactBrowserSecrets(button.text,readerToken)}]:[];
    });
    return {text:redactBrowserSecrets(observed.text,readerToken),links,tabs,collapsedDetails:observed.collapsedDetails,
      truncated:observed.truncated};
  };
  const pageChunk=(observed:Awaited<ReturnType<typeof readVisible>>,offset:number)=>{
    let end=Math.min(observed.text.length,offset+10000);
    let value="";
    do {
      value=redactBrowserSecrets(JSON.stringify({text:observed.text.slice(offset,end),links:observed.links,tabs:observed.tabs,
        partial:end<observed.text.length||observed.truncated,hasMore:end<observed.text.length,
        hardLimit:observed.truncated,collapsedDetails:observed.collapsedDetails}),readerToken);
      if (value.length<=19000) return {value,end};
      end=offset+Math.floor((end-offset)/2);
    } while(end>offset);
    throw new Error("snapshot too large");
  };
  context.routeWebSocket("**/*",(socket:any)=>socket.close());
  await context.route("**/*",async (route:any)=>{
    const request=route.request();
    try {
      const scope=activeScope;
      const current=await readBrowserScope(scopePath,Date.now(),expectedOrigin);
      if (!scope || !current || JSON.stringify(current)!==JSON.stringify(scope) ||
        !allowBrowserRequest(scope,request.url(),request.method(),request.resourceType())) { await route.abort(); return; }
      const requestHeaders=await request.allHeaders();
      const authorization=requestHeaders.authorization??null;
      if (authorization && authorization!==`Bearer ${readerToken}`) {await route.abort();return;}
      const response=await boundedLocalGet(request.url(),authorization,requestHeaders.accept??null,activeRequests,networkTimeoutMs);
      const latest=await readBrowserScope(scopePath,Date.now(),expectedOrigin);
      if (!latest || JSON.stringify(latest)!==JSON.stringify(scope) ||
        !allowBrowserResponse(response.status,response.body.length,response.headers["content-disposition"]??null)) {
        await route.abort(); return;
      }
      await route.fulfill(response);
    } catch { await route.abort().catch(()=>{}); }
  });
  let activeScope:BrowserReadScope|null=null;
  return {
    async navigate(scope,token,key) {
      const selected=scope.routes.find(route=>route.key===key);
      if (!selected) throw new Error("route denied");
      if (activeScope && (activeScope.runId!==scope.runId || activeScope.readerActorId!==scope.readerActorId)) throw new Error("scope changed");
      if (!approvedHash && key!==scope.entryRouteKey) throw new Error("entry denied");
      if (approvedHash) {
        const current=await readVisible(scope);
        if (!current.links.some(link=>link.routeKey===key) && !current.tabs.some(tab=>tab.routeKey===key))
          throw new Error("navigation target not observed");
      }
      activeScope=scope;
      if (!page) {
        readerToken=token;
        page=await context.newPage();
        page.setDefaultTimeout(10000);
        page.on("download",(download:any)=>{void download.cancel();});
        await page.goto(expectedOrigin+"/",{waitUntil:"domcontentloaded",timeout:10000});
        await page.locator("#token").fill(token);
        const loginResponse=page.waitForResponse((response:any)=>{
          try {return new URL(response.url()).pathname==="/api/session";} catch{return false;}
        },{timeout:10000});
        await page.locator("form button[type=submit]").click();
        const status=(await loginResponse).status();
        if (status===401 || status===403) throw new ReaderLoginDenied(status);
        await page.locator("#token").waitFor({state:"detached",timeout:10000});
      }
      if (readerToken!==token) throw new Error("reader changed");
      await page.evaluate((hash:string)=>{window.location.hash=hash;},selected.hash);
      await page.waitForTimeout(250);
      if (!isApprovedPageUrl(scope,page.url(),selected.hash)) throw new Error("navigation mismatch");
      approvedHash=selected.hash;
      lastSnapshot=null;
    },
    async snapshot(scope) {
      const observed=await readVisible(scope);
      const chunk=pageChunk(observed,0);
      lastSnapshot={text:observed.text,cursor:chunk.end,hash:approvedHash!};
      return chunk.value;
    },
    async readMore(scope) {
      if (!lastSnapshot || !approvedHash || lastSnapshot.hash!==approvedHash) throw new Error("no partial snapshot");
      const observed=await readVisible(scope);
      if (observed.text!==lastSnapshot.text || lastSnapshot.cursor>=observed.text.length) throw new Error("snapshot changed or complete");
      const offset=lastSnapshot.cursor;
      const chunk=pageChunk(observed,offset);
      lastSnapshot.cursor=chunk.end;
      return chunk.value;
    },
    async expandDetails(scope) {
      if (!page || activeScope?.runId!==scope.runId || !isApprovedPageUrl(scope,page.url(),approvedHash)) throw new Error("no approved page");
      const result:{expanded:number;remaining:number}=await page.evaluate(EXPAND_DETAILS_SOURCE);
      if (!isApprovedPageUrl(scope,page.url(),approvedHash)) throw new Error("page moved");
      lastSnapshot=null;
      return JSON.stringify(result);
    },
    async screenshot(scope) {
      if (!page || activeScope?.runId!==scope.runId || !isApprovedPageUrl(scope,page.url(),approvedHash)) throw new Error("no approved page");
      const visible:string=await page.locator("body").innerText();
      if (await page.locator(".auth-shell").count() || redactBrowserSecrets(visible,readerToken)!==visible)
        throw new Error("sensitive page");
      const bytes:Buffer=await page.screenshot({type:"png",animations:"disabled",timeout:10000,
        mask:[page.locator("input"),page.locator("textarea"),page.locator("[data-sensitive]")]});
      if (!isApprovedPageUrl(scope,page.url(),approvedHash)) throw new Error("page moved");
      if (bytes.length>2_000_000) throw new Error("image too large");
      return bytes.toString("base64");
    },
    async close(){for(const request of activeRequests)request.destroy();await context.close();await browser.close();},
  };
}
