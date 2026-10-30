import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {encodeReview,decodeReview} from './review-format.mjs';
const cli=fileURLToPath(new URL('./review-cli.mjs',import.meta.url));
const projectId='11111111-1111-4111-8111-111111111111',threadId='22222222-2222-4222-8222-222222222222';
const meta={schemaVersion:1,projectId,writerThreadId:threadId,leaderThreadId:threadId,summary:'Synthetic test report',period:{from:'2026-10-29T10:00:00+08:00',to:'2026-10-30T10:00:00+08:00',timeZone:'Asia/Taipei',mode:'initial'},sources:[{kind:'synthetic'}],followups:[]};
test('Review metadata preserves readable body and rejects silent gaps',()=>{
  const body='# Real report\n\nUnicode 中文 and --> remain intact.';
  assert.equal(decodeReview(encodeReview({...meta,summary:'Literal --> in metadata'},body)).markdown,body);
  assert.equal(decodeReview('An ordinary report'),null);
  const m={...meta,period:{...meta.period,mode:'since_previous'},previousReview:{documentId:projectId,revisionId:threadId,observedTo:'2026-10-29T02:00:00Z'}};
  assert.doesNotThrow(()=>encodeReview(m,body));
  assert.throws(()=>encodeReview({...m,period:{...m.period,from:'2026-10-29T10:00:01+08:00'}},body),/cutoff/);
  assert.throws(()=>encodeReview({...meta,period:{...meta.period,timeZone:undefined}},body),/time zone/);
});
test('Real CLI protocol keeps retries stable and defaults to observation cutoff',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'evo-report-test-'));const run=promisify(execFile);
  try{
    const statePath=join(dir,'db.json'),fake=join(dir,'provider.mjs'),config=join(dir,'cli.json');
    await writeFile(statePath,JSON.stringify({posts:0,docs:[],operations:{}}));
    await writeFile(config,JSON.stringify({argv:[process.execPath,fake,statePath],projectId,timeZone:'Asia/Taipei'}));
    await writeFile(fake,`import fs from 'node:fs';import{randomUUID}from'node:crypto';const[file,...a]=process.argv.slice(2);const s=JSON.parse(fs.readFileSync(file));let r;
if(a[0]==='session')r={principal:{projectIds:['${projectId}'],permissions:['read','write'],actorId:'test-writer'}};
else if(a[0]==='original'){const d=s.docs.find(d=>d.id===a[1]);r=d.original??{body:d.revision.body,assets:[]};}
else if(a[0]==='command'){const q=JSON.parse(fs.readFileSync(a[2]));s.posts++;const rev={id:randomUUID(),body:q.body,author:'test-writer',createdAt:'2026-10-30T12:00:00Z'};s.docs.push({id:q.documentId,title:q.title,kind:'report',status:'draft',currentRevisionId:rev.id,revision:rev});r={status:'applied',operationId:q.operationId,revisionId:rev.id,entityId:q.documentId};s.operations[q.operationId]=r;}
else if(a[0]==='request'){const q=JSON.parse(fs.readFileSync(a[a.indexOf('--file')+1]));s.posts++;s.lastImport=q;const body=Buffer.from(q.uploads.find(u=>u.blobId===q.command.source.payloadRef).base64,'base64').toString('utf8');const rev={id:q.command.revisionId,body:null,author:'test-writer',createdAt:'2026-11-01T12:00:00Z',format:'html'};s.docs.push({id:q.command.documentId,title:q.command.title,kind:'report',status:'draft',currentRevisionId:rev.id,revision:rev,original:{body,assets:q.command.source.assets}});r={status:'applied',operationId:q.command.operationId,revisionId:rev.id,entityId:q.command.documentId};s.operations[q.command.operationId]=r;}
else if(a[1].includes('/operations/'))r=s.unknown?{status:'unknown'}:s.operations[a[1].split('/').pop()];
else if(a[1].includes('/revisions/'))r=s.docs.find(d=>d.currentRevisionId===a[1].split('/').pop()).revision;
else if(a[1].includes('/documents?'))r={items:s.docs.map(({revision,...d})=>d),nextCursor:null};
fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(r));`);
    const bundle=join(dir,'first.json');await writeFile(join(dir,'body.md'),'# Synthetic report\n\nAn actual test body.');
    await writeFile(bundle,JSON.stringify({...meta,title:'Synthetic first',bodyFile:'body.md'}));
    const firstOut=join(dir,'first-receipt');await run(process.execPath,[cli,'submit',bundle,config,firstOut]);
    const first=JSON.parse(await readFile(join(firstOut,'receipt.json')));
    await run(process.execPath,[cli,'submit',bundle,config,firstOut]);
    assert.equal(JSON.parse(await readFile(statePath)).posts,1);
    const second=join(dir,'second.json');await writeFile(second,JSON.stringify({...meta,title:'Synthetic next',period:{to:'2026-10-31T10:00:00+08:00',timeZone:'Asia/Taipei'},bodyFile:'body.md'}));
    const secondOut=join(dir,'second-receipt');await run(process.execPath,[cli,'submit',second,config,secondOut]);
    const receipt=JSON.parse(await readFile(join(secondOut,'receipt.json')));
    assert.equal(receipt.period.from,meta.period.to);
    assert.notEqual(receipt.period.from,first.submittedAt);
    await run(process.execPath,[cli,'status',second,config,secondOut]);
    assert.equal(JSON.parse(await readFile(statePath)).posts,2);
    const html=join(dir,'report.html');await writeFile(html,'<!doctype html><html><body><h1>Free report layout</h1><img src="assets/diagram.svg"></body></html>');
    await (await import('node:fs/promises')).mkdir(join(dir,'assets'));await writeFile(join(dir,'assets/diagram.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"></svg>');
    const richOut=join(dir,'html-receipt');await run(process.execPath,[cli,'submit',html,config,richOut,'--title','Synthetic original report','--to','2026-11-01T10:00:00+08:00']);
    const rich=JSON.parse(await readFile(join(richOut,'receipt.json')));assert.equal(rich.format,'html');assert.equal(rich.assetCount,1);
    const imported=JSON.parse(await readFile(statePath));assert.equal(imported.lastImport.command.source.assets[0].path,'assets/diagram.svg');
    await run(process.execPath,[cli,'status',html,config,richOut]);assert.equal(JSON.parse(await readFile(statePath)).posts,3);
    await writeFile(join(dir,'assets/diagram.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>');
    await assert.rejects(run(process.execPath,[cli,'submit',html,config,richOut,'--title','Synthetic original report','--to','2026-11-01T10:00:00+08:00']),/resources changed/);assert.equal(JSON.parse(await readFile(statePath)).posts,3,'Changed resources must not reuse a confirmed intent');
    const state=JSON.parse(await readFile(statePath));state.unknown=true;await writeFile(statePath,JSON.stringify(state));
    await assert.rejects(run(process.execPath,[cli,'submit',second,config,secondOut]));
    assert.equal(JSON.parse(await readFile(statePath)).posts,3,'Unknown outcome must not send another mutation');
  }finally{await rm(dir,{recursive:true,force:true});}
});
