import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { observationPeriod, reviewDocumentKind } from './review-format.mjs';
const execute=promisify(execFile), digest=body=>createHash('sha256').update(body).digest('hex');
export async function projectCli(configPath){
  const config=JSON.parse(await readFile(configPath,'utf8'));
  if(!Array.isArray(config.argv)||!config.argv.length||config.argv.some(a=>typeof a!=='string'))throw new Error('CLI config requires the normal project CLI argv array');
  return async(...args)=>JSON.parse((await execute(config.argv[0],[...config.argv.slice(1),...args],{timeout:30000,maxBuffer:64*1024*1024})).stdout);
}
export async function readReview(cli,projectId,documentId,revisionId){
  const detail=await cli('get',`/api/projects/${projectId}/documents/${documentId}`);
  const revision=await cli('get',`/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}`);
  if(detail.document.kind!==reviewDocumentKind)throw new Error('This is not an organization review Document');
  const original=await cli('original',documentId,'--project',projectId,'--revision',revisionId);
  return{document:detail.document,revision,body:original.body,assets:original.assets??[]};
}
export async function listReviews(cli,projectId){
  const items=[],seen=new Set();let cursor;
  do{
    const page=await cli('get',`/api/projects/${projectId}/documents?kind=${reviewDocumentKind}&limit=50${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
    if(!Array.isArray(page.items)||page.items.some(d=>d.projectId!==projectId||d.kind!==reviewDocumentKind))throw new Error('The service did not return the requested Document type');
    items.push(...page.items);cursor=page.nextCursor;
    if(cursor&&seen.has(cursor))throw new Error('Repeated document cursor');if(cursor)seen.add(cursor);
  }while(cursor);
  items.sort((a,b)=>Date.parse(b.organizationReview?.observedTo??b.updatedAt??0)-Date.parse(a.organizationReview?.observedTo??a.updatedAt??0)||a.id.localeCompare(b.id));
  return{items,complete:true,observedAt:new Date().toISOString()};
}
function requestBody(request){return request.command?request.command.source.storage==='inline'?request.command.source.body:Buffer.from(request.uploads.find(u=>u.blobId===request.command.source.payloadRef).base64,'base64').toString('utf8'):request.body;}
async function assetsIn(folder,prefix='assets'){
  let entries;try{entries=await readdir(folder,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return[];throw e;}
  const result=[];for(const item of entries){if(item.name==='.DS_Store')continue;if(item.isSymbolicLink())throw new Error('Use actual asset files in the report bundle');
    const path=join(folder,item.name),name=`${prefix}/${item.name}`;
    if(item.isDirectory())result.push(...await assetsIn(path,name));else if(item.isFile()){if((await stat(path)).size>16*1024*1024)throw new Error('An asset exceeds the existing document limit');result.push({path:name,bytes:await readFile(path)});}if(result.length>50)throw new Error('Report exceeds 50 bundled assets');
  }return result;
}
const media={'.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.woff2':'font/woff2'};
async function main(){
  const[action,input,configPath,outPath,...options]=process.argv.slice(2);
  if(!['submit','status','list'].includes(action)||!input||!configPath)throw new Error('Usage: review-cli.mjs submit REPORT.html CLI_CONFIG.json RECEIPTS --title TITLE --from ISO --to ISO; list PROJECT_ID CLI_CONFIG.json; status REPORT CLI_CONFIG RECEIPTS');
  const cli=await projectCli(configPath),config=JSON.parse(await readFile(configPath,'utf8'));
  const session=await cli('session');
  if(action==='status'){
    if(!outPath)throw new Error('Use the saved receipt directory');
    const request=JSON.parse(await readFile(join(outPath,'request.json'),'utf8')),core=request.command??request;
    const operation=await cli('get',`/api/projects/${core.projectId}/operations/${core.operationId}`),result=operation.result??operation;
    if(result.status!=='applied')throw new Error(`Original operation is ${result.status??'unconfirmed'}; no write was sent`);
    const revisionId=result.revisionId??core.revisionId;
    const original=await cli('original',core.documentId,'--project',core.projectId,'--revision',revisionId);
    if(original.body!==requestBody(request))throw new Error('Fixed original differs from saved intent');
    console.log(JSON.stringify({status:'confirmed-original',documentId:core.documentId,revisionId,writesSent:0},null,2));return;
  }
  if(!session.capabilities?.organizationReviewDocuments)throw new Error('The project service must support organization_review Documents before saving; no temporary body marker is used');
  if(action==='list'){console.log(JSON.stringify(await listReviews(cli,input),null,2));return;}
  if(!session.capabilities?.documentOriginals)throw new Error('The project original-document storage is unavailable');
  if(!outPath)throw new Error('Keep a receipt directory for this save');
  const flags={};for(let i=0;i<options.length;i+=2){if(!options[i].startsWith('--')||options[i+1]===undefined)throw new Error('Expected an option and value');flags[options[i].slice(2)]=options[i+1];}
  const bundle=extname(input)==='.json'?JSON.parse(await readFile(input,'utf8')):{};
  const projectId=bundle.projectId??config.projectId,principal=session.principal;
  if(!principal.projectIds.includes(projectId)||!principal.permissions.includes('write'))throw new Error('Current project CLI cannot save this report');
  const filename=bundle.bodyFile?resolve(dirname(input),bundle.bodyFile):resolve(input);
  const fileBytes=await readFile(filename);
  const body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(fileBytes),format=['.html','.htm'].includes(extname(filename).toLowerCase())?'html':'markdown';
  const title=flags.title??bundle.title??basename(filename,extname(filename));
  const requestPath=join(outPath,'request.json');let request;
  try{request=JSON.parse(await readFile(requestPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const documentId=flags.document??bundle.documentId;
  const expectedVersion=flags.version?Number(flags.version):bundle.expectedVersion;
  let retained=request?(request.command??request).organizationReview:undefined;
  if(documentId&&!request){
    if(!Number.isInteger(expectedVersion)||expectedVersion<1)throw new Error('Revise using the observed Document --version');
    const current=await cli('get',`/api/projects/${projectId}/documents/${documentId}`);
    if(current.document.version!==expectedVersion)throw new Error('Document changed; read it before preparing a new save');
    retained=current.current.organizationReview;
  }
  const from=flags.from??bundle.organizationReview?.observedFrom??bundle.period?.from;
  const to=flags.to??bundle.organizationReview?.observedTo??bundle.period?.to;
  let previous=bundle.organizationReview?.previous??retained?.previous;
  if(flags.previous){const [id,revisionId]=flags.previous.split('@');previous={documentId:id,revisionId};}
  if(!documentId&&!request&&!previous){const list=await listReviews(cli,projectId);const last=list.items.find(d=>d.id!==documentId&&d.status!=='archived');if(last)previous={documentId:last.id,revisionId:last.currentRevisionId};}
  let previousPeriod;
  if(previous){const fixed=await cli('get',`/api/projects/${projectId}/documents/${previous.documentId}/revisions/${previous.revisionId}`);previousPeriod=fixed.organizationReview;if(!previousPeriod)throw new Error('Previous fixed review has no native observation period');}
  const organizationReview=observationPeriod({observedFrom:from??retained?.observedFrom??previousPeriod?.observedTo,observedTo:to??retained?.observedTo,timeZone:flags.timezone??bundle.organizationReview?.timeZone??bundle.period?.timeZone??retained?.timeZone??config.timeZone??'UTC',previous});
  const assetFiles=await assetsIn(join(dirname(filename),'assets'));
  if(format==='markdown'&&assetFiles.length)throw new Error('Use a complete HTML report for external resources; the current Markdown reader supports its native text and diagram format');
  await mkdir(outPath,{recursive:true});
  if(request){const core=request.command??request;
    const mode=documentId?'revise':'create',savedMode=request.command?.mode??'create';
    const reason=flags.reason??bundle.reason??'保存完整组织复盘文档';
    if(savedMode!==mode||(documentId&&core.documentId!==documentId)||(mode==='revise'&&core.expectedVersion!==expectedVersion)||
      (core.format??'markdown')!==format||(core.originalName&&core.originalName!==basename(filename))||
      (core.author&&core.author!==principal.actorId)||(core.reason&&core.reason!==reason))
      throw new Error('Report intent changed: target, version, format, author or reason differs; keep the original receipt');
    if(requestBody(request)!==body||core.projectId!==projectId||!isDeepStrictEqual(core.organizationReview,organizationReview)||(core.title&&core.title!==title))throw new Error('Report intent changed; preserve this receipt and prepare a new save');
    const saved=(request.command?.source.assets??[]).map(a=>({path:a.path,hash:a.contentHash})).sort((a,b)=>a.path.localeCompare(b.path));
    const actual=assetFiles.map(a=>({path:a.path,hash:digest(a.bytes)})).sort((a,b)=>a.path.localeCompare(b.path));
    if(JSON.stringify(saved)!==JSON.stringify(actual))throw new Error('Report resources changed; prepare a new save');
  }else{
    const bytes=Buffer.from(body),blobId=randomUUID(),uploads=[{blobId,base64:bytes.toString('base64')}];
    const assets=assetFiles.map(a=>{const id=randomUUID();uploads.push({blobId:id,base64:a.bytes.toString('base64')});return{path:a.path,blobId:id,contentHash:digest(a.bytes),size:a.bytes.length,mediaType:media[extname(a.path).toLowerCase()]??'application/octet-stream'};});
    if(bytes.length+assetFiles.reduce((sum,a)=>sum+a.bytes.length,0)>16*1024*1024)throw new Error('Report and resources exceed the existing16MiB limit');
    request={command:{projectId,operationId:randomUUID(),documentId:documentId??randomUUID(),revisionId:randomUUID(),format,mediaType:format==='html'?'text/html':'text/markdown',originalName:basename(filename),author:principal.actorId,reason:flags.reason??bundle.reason??'保存完整组织复盘文档',mode:documentId?'revise':'create',kind:reviewDocumentKind,organizationReview,...(documentId?{expectedVersion}:{title}),source:{storage:'blob',payloadRef:blobId,contentHash:digest(bytes),size:bytes.length,entrypoint:format==='html'?basename(filename):null,assets}},uploads};
  }
  const existed=await readFile(requestPath).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e});
  if(!existed)await writeFile(requestPath,JSON.stringify(request,null,2)+'\n',{flag:'wx'});
  const core=request.command??request;let result;
  if(existed){const operation=await cli('get',`/api/projects/${projectId}/operations/${core.operationId}`);result=operation.result??operation;}
  else{result=request.command?await cli('request','document.import','--project',projectId,'--file',requestPath):await cli('command','run',requestPath);result=result.result??result;}
  await writeFile(join(outPath,'operation-response.json'),JSON.stringify(result,null,2)+'\n');
  if(result.status!=='applied')throw new Error(`Operation is ${result.status??'unconfirmed'}; reconcile its original receipt`);
  const revisionId=result.revisionId??core.revisionId;
  const original=await cli('original',core.documentId,'--project',projectId,'--revision',revisionId);
  if(original.body!==body)throw new Error('Saved original differs from the report file');
  const fixed=await cli('get',`/api/projects/${projectId}/documents/${core.documentId}/revisions/${revisionId}`);
  if(!isDeepStrictEqual(fixed.organizationReview,organizationReview))throw new Error('Saved Document period differs');
  const web=(config.webUrl??'http://127.0.0.1:55431').replace(/\/$/,'');
  const receipt={status:'saved-and-read-back',projectId,documentId:core.documentId,revisionId,operationId:core.operationId,kind:reviewDocumentKind,organizationReview,format,author:fixed.author,bodySha256:digest(body),documentHref:`${web}/#/p/${projectId}/documents/${core.documentId}?revision=${revisionId}`,listHref:`${web}/#/p/${projectId}/reviews`};
  await writeFile(join(outPath,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1});
