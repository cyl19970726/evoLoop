import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { encodeReview, decodeReview } from './review-format.mjs';
const execute=promisify(execFile), digest=body=>createHash('sha256').update(body).digest('hex');
export async function projectCli(configPath){
  const config=JSON.parse(await readFile(configPath,'utf8'));
  if(!Array.isArray(config.argv)||!config.argv.length||config.argv.some(a=>typeof a!=='string'))throw new Error('CLI config requires the normal project CLI argv array');
  return async(...args)=>JSON.parse((await execute(config.argv[0],[...config.argv.slice(1),...args],{timeout:30000,maxBuffer:64*1024*1024})).stdout);
}
export async function readReview(cli,projectId,documentId,revisionId,title){
  const revision=await cli('get',`/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}`);
  const original=revision.body===null?await cli('original',documentId,'--project',projectId,'--revision',revisionId):{body:revision.body,assets:[]};
  const review=decodeReview(original.body);if(!review)return null;
  if(review.meta.projectId!==projectId)throw new Error('Review project differs from its authenticated record');
  let first=revision;const seen=new Set([revision.id]);
  while(first.previousRevisionId){if(seen.has(first.previousRevisionId))throw new Error('Repeated report revision');seen.add(first.previousRevisionId);first=await cli('get',`/api/projects/${projectId}/documents/${documentId}/revisions/${first.previousRevisionId}`);}
  return{...review.meta,id:documentId,revisionId,title,body:review.markdown,format:revision.format??'markdown',assets:original.assets??[],originalName:revision.originalName,author:revision.author,submittedAt:first.createdAt,updatedAt:revision.createdAt,contentHash:revision.contentHash};
}
export async function listReviews(cli,projectId){
  const documents=[],seen=new Set();let cursor;
  do{const page=await cli('get',`/api/projects/${projectId}/documents?limit=50${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
    if(!Array.isArray(page.items))throw new Error('Invalid document list');documents.push(...page.items);cursor=page.nextCursor;
    if(cursor&&seen.has(cursor))throw new Error('Repeated document cursor');if(cursor)seen.add(cursor);
  }while(cursor);
  const candidates=documents.filter(d=>d.kind==='report'&&d.status!=='archived'),items=[],errors=[];let at=0;
  async function worker(){while(at<candidates.length){const d=candidates[at++];try{const r=await readReview(cli,projectId,d.id,d.currentRevisionId,d.title);if(r)items.push({...r,documentState:d.status});}catch{errors.push({documentId:d.id,message:'Original unavailable or invalid'});}}}
  await Promise.all(Array.from({length:4},worker));
  items.sort((a,b)=>Date.parse(b.period.to)-Date.parse(a.period.to)||b.submittedAt.localeCompare(a.submittedAt)||a.id.localeCompare(b.id));
  return{source:'project-api-database',observedAt:new Date().toISOString(),items,scannedDocuments:documents.length,complete:!errors.length,errors};
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
  if(!['submit','status','list'].includes(action)||!input||!configPath)throw new Error('Usage: review-cli.mjs submit REPORT.html CLI_CONFIG.json RECEIPTS --title TITLE --from ISO --to ISO; list PROJECT_ID CLI_CONFIG.json; status uses the same arguments');
  const cli=await projectCli(configPath);
  if(action==='list'){console.log(JSON.stringify(await listReviews(cli,input),null,2));return;}
  if(!outPath)throw new Error('Keep a durable receipt directory');
  const flags={};for(let n=0;n<options.length;n+=2){if(!options[n].startsWith('--')||options[n+1]===undefined)throw new Error('Expected a named option and value');flags[options[n].slice(2)]=options[n+1];}
  const config=JSON.parse(await readFile(configPath,'utf8'));
  if(action==='status'){
    const savedRequest=JSON.parse(await readFile(join(outPath,'request.json'),'utf8')),core=savedRequest.command??savedRequest;
    const operation=await cli('get',`/api/projects/${core.projectId}/operations/${core.operationId}`),result=operation.result??operation;
    if(result.status!=='applied')throw new Error(`Original operation is ${result.status??'unconfirmed'}; no write was sent`);
    const revisionId=result.revisionId??result.resultRefId??core.revisionId;
    const original=await cli('original',core.documentId,'--project',core.projectId,'--revision',revisionId);
    if(original.body!==requestBody(savedRequest))throw new Error('Fixed original differs from saved intent');
    const receipt={status:'confirmed-original',operationId:core.operationId,documentId:core.documentId,revisionId,bodySha256:digest(original.body),writesSent:0};
    await writeFile(join(outPath,'status-readback.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));return;
  }
  let bundle;
  if(extname(input)==='.json')bundle=JSON.parse(await readFile(input,'utf8'));
  else{
    const title=flags.title??basename(input,extname(input));
    bundle={schemaVersion:1,projectId:config.projectId,writerThreadId:process.env.CODEX_THREAD_ID,leaderThreadId:flags.leader,title,summary:flags.summary??title,period:{from:flags.from,to:flags.to,timeZone:flags.timezone??config.timeZone??'UTC'},bodyFile:resolve(input)};
    if(flags.document){const d=await cli('get',`/api/projects/${bundle.projectId}/documents/${flags.document}`);const old=await readReview(cli,bundle.projectId,flags.document,d.document.currentRevisionId,d.document.title);if(!old)throw new Error('Existing document is not an organization review');
      bundle={...old,...bundle,period:{...old.period,...Object.fromEntries(Object.entries(bundle.period).filter(([,v])=>v!==undefined))},documentId:flags.document,expectedVersion:Number(flags.version??d.document.version)};
      for(const key of ['id','revisionId','body','assets','author','submittedAt','contentHash','originalName'])delete bundle[key];
    }
  }
  const requestPath=join(outPath,'request.json');let request,existed=false;
  try{request=JSON.parse(await readFile(requestPath,'utf8'));existed=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existed&&!bundle.period.mode){const saved=decodeReview(requestBody(request));if(!saved)throw new Error('Saved intent is not a review');bundle.period={...saved.meta.period,...Object.fromEntries(Object.entries(bundle.period).filter(([,v])=>v!==undefined))};bundle.previousReview??=saved.meta.previousReview;}
  const principal=(await cli('session')).principal;
  if(!principal.projectIds.includes(bundle.projectId)||!principal.permissions.includes('write'))throw new Error('Current project CLI cannot save this report');
  if(!bundle.period.mode){const list=await listReviews(cli,bundle.projectId);if(!list.complete)throw new Error('Cannot choose the previous report from an incomplete read');
    const previous=list.items.find(r=>r.id!==bundle.documentId&&(!bundle.leaderThreadId||r.leaderThreadId===bundle.leaderThreadId)&&r.period.mode!=='custom');
    bundle.period.mode=previous?'since_previous':'initial';if(previous)bundle.previousReview={documentId:previous.id,revisionId:previous.revisionId,observedTo:previous.period.to};
  }
  if(bundle.period.mode==='since_previous'){const p=bundle.previousReview;if(!p?.documentId||!p.revisionId)throw new Error('Missing fixed previous report');const old=await readReview(cli,bundle.projectId,p.documentId,p.revisionId,'Previous report');if(!old)throw new Error('Previous document is not a review');bundle.previousReview.observedTo=old.period.to;bundle.period.from??=old.period.to;}
  const filename=resolve(dirname(input),bundle.bodyFile),format=['.html','.htm'].includes(extname(filename).toLowerCase())?'html':'markdown';
  const original=await readFile(filename,'utf8');
  const{bodyFile,title,documentId,expectedVersion,reason,...meta}=bundle;
  const body=encodeReview(meta,original),assetFiles=await assetsIn(join(dirname(filename),'assets'));
  await mkdir(outPath,{recursive:true});
  if(existed){const core=request.command??request;if(requestBody(request)!==body||core.projectId!==bundle.projectId||(core.title&&core.title!==title))throw new Error('Different report intent: preserve this receipt and use a new one');
    const savedAssets=(request.command?.source.assets??[]).map(a=>({path:a.path,hash:a.contentHash})).sort((a,b)=>a.path.localeCompare(b.path));
    const actualAssets=assetFiles.map(a=>({path:a.path,hash:digest(a.bytes)})).sort((a,b)=>a.path.localeCompare(b.path));
    if(JSON.stringify(savedAssets)!==JSON.stringify(actualAssets))throw new Error('Report resources changed: preserve this receipt and use a new intent');
  }
  else if(format==='html'||assetFiles.length||body.length>65536||documentId){
    if(assetFiles.length>50)throw new Error('Report exceeds 50 bundled assets');const bytes=Buffer.from(body),blobId=randomUUID(),uploads=[{blobId,base64:bytes.toString('base64')}];
    const assets=assetFiles.map(a=>{const id=randomUUID();uploads.push({blobId:id,base64:a.bytes.toString('base64')});return{path:a.path,blobId:id,contentHash:digest(a.bytes),size:a.bytes.length,mediaType:media[extname(a.path).toLowerCase()]??'application/octet-stream'};});
    if(bytes.length+assetFiles.reduce((sum,a)=>sum+a.bytes.length,0)>16*1024*1024)throw new Error('Report and assets exceed the existing 16MiB storage limit');
    request={command:{projectId:bundle.projectId,operationId:randomUUID(),documentId:documentId??randomUUID(),revisionId:randomUUID(),format,mediaType:format==='html'?'text/html':'text/markdown',originalName:basename(filename),author:principal.actorId,reason:reason??'保存组织复盘报告原件',mode:documentId?'revise':'create',...(documentId?{expectedVersion}:{title,kind:'report'}),source:{storage:'blob',payloadRef:blobId,contentHash:digest(bytes),size:bytes.length,entrypoint:basename(filename),assets}},uploads};
  }else request={type:'document.create',projectId:bundle.projectId,operationId:randomUUID(),documentId:randomUUID(),title,kind:'report',body};
  if(!existed)await writeFile(requestPath,JSON.stringify(request,null,2)+'\n',{flag:'wx'});
  const core=request.command??request;let result;
  if(existed||action==='status'){const op=await cli('get',`/api/projects/${bundle.projectId}/operations/${core.operationId}`);result=op.result??op;}
  else{result=request.command?await cli('request','document.import','--project',bundle.projectId,'--file',requestPath):await cli('command','run',requestPath);result=result.result??result;}
  await writeFile(join(outPath,'operation-response.json'),JSON.stringify(result,null,2)+'\n');
  if(result.status!=='applied')throw new Error(`Operation is ${result.status??'unconfirmed'}; query its original receipt before retrying`);
  const revisionId=result.revisionId??result.resultRefId??core.revisionId;if(!revisionId)throw new Error('Missing fixed revision in confirmed result');
  const fixed=await cli('get',`/api/projects/${bundle.projectId}/documents/${core.documentId}/revisions/${revisionId}`);
  const saved=fixed.body===null?await cli('original',core.documentId,'--project',bundle.projectId,'--revision',revisionId):{body:fixed.body};
  if(saved.body!==body||!decodeReview(saved.body))throw new Error('Saved original differs from this report');
  const receipt={status:'submitted-and-read-back',projectId:bundle.projectId,operationId:core.operationId,documentId:core.documentId,revisionId,format,assetCount:assetFiles.length,author:fixed.author,submittedAt:fixed.createdAt,period:bundle.period,bodySha256:digest(body),productHref:`http://127.0.0.1:55431/#/p/${bundle.projectId}/documents/${core.documentId}?revision=${revisionId}`,previewPath:`#/reviews/${core.documentId}?revision=${revisionId}`};
  await writeFile(join(outPath,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1});
