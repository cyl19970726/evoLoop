import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {observationPeriod,reviewDocumentKind} from './review-format.mjs';
const cli=fileURLToPath(new URL('./review-cli.mjs',import.meta.url));
const projectId='11111111-1111-4111-8111-111111111111';
// A file-backed stand-in for the project CLI, shared by the tests below.
const providerSource=`import fs from 'node:fs';import{randomUUID}from'node:crypto';const[file,...a]=process.argv.slice(2),s=JSON.parse(fs.readFileSync(file));let r;
const find=id=>s.docs.find(d=>d.id===id);
if(a[0]==='session')r={principal:{actorId:'author',projectIds:['${projectId}'],permissions:['read','write']},capabilities:{organizationReviewDocuments:true,documentOriginals:true}};
else if(a[0]==='command'||a[0]==='request'){
const q=JSON.parse(fs.readFileSync(a[0]==='request'?a[a.indexOf('--file')+1]:a[2])),c=q.command??q;
const body=q.command?Buffer.from(q.uploads.find(u=>u.blobId===c.source.payloadRef).base64,'base64').toString('utf8'):c.body;
const old=find(c.documentId),id=c.revisionId??randomUUID(),at='2026-10-31T12:00:00Z';
const rev={id,documentId:c.documentId,projectId:c.projectId,organizationReview:c.organizationReview,body:q.command?null:body,format:c.format??'markdown',createdAt:at,author:'author'};
const d={projectId:c.projectId,id:c.documentId,title:c.title??old?.title,kind:c.kind,currentRevisionId:id,organizationReview:c.organizationReview,createdAt:old?.createdAt??at,updatedAt:at,status:'draft',version:(old?.version??0)+1,revisions:{...(old?.revisions??{}),[id]:rev},originals:{...(old?.originals??{}),[id]:{body,assets:c.source?.assets??[]}}};
if(old)s.docs=s.docs.map(x=>x.id===d.id?d:x);else s.docs.push(d);s.posts++;s.lastRequest=q;r={status:'applied',operationId:c.operationId,entityId:c.documentId,revisionId:id};s.operations[c.operationId]=r;
}else if(a[0]==='original')r=find(a[1]).originals[a[a.indexOf('--revision')+1]];
else if(a[1].includes('/operations/'))r=s.unknown?{status:'unknown'}:s.operations[a[1].split('/').pop()];
else if(a[1].includes('/revisions/')){const p=a[1].split('/');r=structuredClone(find(p[p.length-3]).revisions[p.at(-1)]);if(r.organizationReview)r.organizationReview=Object.fromEntries(Object.entries(r.organizationReview).reverse());}
else if(a[1].includes('/documents?'))r={items:s.docs.filter(d=>d.kind==='organization_review').map(({originals,revisions,...d})=>d),nextCursor:null};
else if(a[1].includes('/documents/')){const d=find(a[1].split('/').pop());r={document:d,current:d.revisions[d.currentRevisionId]};}
fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(r));`;

test('review period is small native metadata; it does not encode or require report sections',()=>{
  const period=observationPeriod({observedFrom:'2026-10-29T10:00:00+08:00',observedTo:'2026-10-30T10:00:00+08:00',timeZone:'Asia/Taipei'});
  assert.deepEqual(Object.keys(period),['observedFrom','observedTo','timeZone']);
  assert.equal(reviewDocumentKind,'organization_review');
  assert.throws(()=>observationPeriod({...period,observedTo:period.observedFrom}),/observation/);
  assert.throws(()=>observationPeriod({...period,timeZone:'Unknown/Place'}),/time zone/);
});

test('whole report bytes, Document type, resource recovery and default cutoff use one native path',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'evo-native-review-')),run=promisify(execFile);
  try{
    const state=join(dir,'db.json'),fake=join(dir,'provider.mjs'),config=join(dir,'cli.json');
    await writeFile(state,JSON.stringify({posts:0,docs:[],operations:{},unknown:false}));
    await writeFile(config,JSON.stringify({argv:[process.execPath,fake,state],projectId,timeZone:'Asia/Taipei'}));
    await writeFile(fake,providerSource);
    const html=join(dir,'report.html'),firstOut=join(dir,'first');
    const raw='<!doctype html><html><body><h1>任意报告结构</h1><img src="assets/diagram.svg"></body></html>';
    await writeFile(html,raw);await mkdir(join(dir,'assets'));await writeFile(join(dir,'assets/diagram.svg'),'<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const firstArgs=[cli,'submit',html,config,firstOut,'--title','第一轮','--from','2026-10-29T10:00:00+08:00','--to','2026-10-30T10:00:00+08:00'];
    await run(process.execPath,firstArgs);
    let db=JSON.parse(await readFile(state));const request=db.lastRequest,c=request.command;
    assert.equal(c.kind,'organization_review');assert.equal(c.organizationReview.observedTo,'2026-10-30T10:00:00+08:00');
    assert.equal(Buffer.from(request.uploads[0].base64,'base64').toString(),raw,'original bytes have no injected protocol header');
    assert.equal(c.source.assets[0].path,'assets/diagram.svg');
    await run(process.execPath,firstArgs);assert.equal(JSON.parse(await readFile(state)).posts,1,'same receipt is queried, not written again');
    const first=JSON.parse(await readFile(join(firstOut,'receipt.json')));
    await mkdir(join(dir,'next'));const md=join(dir,'next/report.md'),secondOut=join(dir,'second');await writeFile(md,'# 自由 Markdown 报告');
    await run(process.execPath,[cli,'submit',md,config,secondOut,'--title','第二轮','--to','2026-10-31T10:00:00+08:00']);
    const second=JSON.parse(await readFile(join(secondOut,'receipt.json')));
    assert.equal(second.organizationReview.observedFrom,'2026-10-30T10:00:00+08:00');
    assert.equal(second.organizationReview.previous.documentId,first.documentId);
    assert.notEqual(second.organizationReview.observedFrom,'2026-10-31T12:00:00Z','default uses observation cutoff, not save time');
    await run(process.execPath,[cli,'status',html,config,firstOut]);assert.equal(JSON.parse(await readFile(state)).posts,2);
    const reviseOut=join(dir,'revision');
    const reviseArgs=[cli,'submit',html,config,reviseOut,'--document',first.documentId,'--version','1','--reason','修订表达'];
    await run(process.execPath,reviseArgs);assert.equal(JSON.parse(await readFile(state)).posts,3);
    await run(process.execPath,reviseArgs);assert.equal(JSON.parse(await readFile(state)).posts,3);
    const changedTarget=[...reviseArgs];changedTarget[changedTarget.indexOf('--document')+1]=second.documentId;
    await assert.rejects(run(process.execPath,changedTarget),/intent changed/);
    const changedVersion=[...reviseArgs];changedVersion[changedVersion.indexOf('--version')+1]='2';
    await assert.rejects(run(process.execPath,changedVersion),/intent changed/);
    const changedReason=[...reviseArgs];changedReason[changedReason.indexOf('--reason')+1]='另一理由';
    await assert.rejects(run(process.execPath,changedReason),/intent changed/);
    await mkdir(join(dir,'format'));const otherFormat=join(dir,'format/report.md');await writeFile(otherFormat,raw);
    const changedFormat=[...reviseArgs];changedFormat[2]=otherFormat;
    await assert.rejects(run(process.execPath,changedFormat),/intent changed/);
    assert.equal(JSON.parse(await readFile(state)).posts,3,'changed retry options cause no writes');
    await writeFile(join(dir,'assets/diagram.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="24"></svg>');
    await assert.rejects(run(process.execPath,firstArgs),/resources changed/);assert.equal(JSON.parse(await readFile(state)).posts,3);
    db=JSON.parse(await readFile(state));db.unknown=true;await writeFile(state,JSON.stringify(db));
    await assert.rejects(run(process.execPath,[cli,'submit',md,config,secondOut,'--title','第二轮','--to','2026-10-31T10:00:00+08:00']),/unconfirmed|unknown/);
    assert.equal(JSON.parse(await readFile(state)).posts,3,'unknown result sends no new write');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a review migrated without its native period is not linked; the round is saved only with an explicit start',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'evo-migrated-review-')),run=promisify(execFile);
  try{
    const state=join(dir,'db.json'),fake=join(dir,'provider.mjs'),config=join(dir,'cli.json');
    const oldId='22222222-2222-4222-8222-222222222222',oldRevision='33333333-3333-4333-8333-333333333333';
    // The earlier report exists and is listed, but its fixed revision carries no observation period.
    const migrated={projectId,id:oldId,title:'迁移来的上一轮',kind:'organization_review',currentRevisionId:oldRevision,createdAt:'2026-10-30T00:00:00Z',updatedAt:'2026-10-30T00:00:00Z',status:'draft',version:1,
      revisions:{[oldRevision]:{id:oldRevision,documentId:oldId,projectId,body:'# 上一轮',format:'markdown',createdAt:'2026-10-30T00:00:00Z',author:'author'}},originals:{[oldRevision]:{body:'# 上一轮',assets:[]}}};
    await writeFile(state,JSON.stringify({posts:0,docs:[migrated],operations:{},unknown:false}));
    await writeFile(config,JSON.stringify({argv:[process.execPath,fake,state],projectId,timeZone:'Asia/Tashkent'}));
    await writeFile(fake,providerSource);
    const md=join(dir,'report.md');await writeFile(md,'# 迁移后的第一轮');
    const withoutStart=[cli,'submit',md,config,join(dir,'no-start'),'--title','缺起点','--to','2026-11-11T16:20:00+05:00'];
    await assert.rejects(run(process.execPath,withoutStart),/no native observation period/);
    assert.equal(JSON.parse(await readFile(state)).posts,0,'nothing is written while the start is unknown');
    const out=join(dir,'out'),args=[cli,'submit',md,config,out,'--title','迁移后的第一轮','--from','2026-11-07T07:18:07Z','--to','2026-11-11T16:20:00+05:00'];
    await run(process.execPath,args);
    const receipt=JSON.parse(await readFile(join(out,'receipt.json')));
    assert.equal(receipt.organizationReview.observedFrom,'2026-11-07T07:18:07Z');
    assert.equal(receipt.organizationReview.previous,undefined,'the service would refuse a previous review without a period');
    assert.deepEqual(receipt.unlinkedPrevious,{documentId:oldId,revisionId:oldRevision},'the receipt still names the report this round follows');
    await run(process.execPath,args);assert.equal(JSON.parse(await readFile(state)).posts,1,'the saved receipt is re-read, not written again');
    assert.deepEqual(JSON.parse(await readFile(join(out,'receipt.json'))).unlinkedPrevious,receipt.unlinkedPrevious,'a repeated run keeps the recorded gap');
    const named=[cli,'submit',md,config,join(dir,'named'),'--title','指名上一轮','--from','2026-11-07T07:18:07Z','--to','2026-11-11T16:20:00+05:00','--previous',`${oldId}@${oldRevision}`];
    await assert.rejects(run(process.execPath,named),/no native observation period/,'an explicitly named previous review is never dropped silently');
  }finally{await rm(dir,{recursive:true,force:true});}
});
