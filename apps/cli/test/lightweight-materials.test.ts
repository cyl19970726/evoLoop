import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "../src/client.js";
import { materialAsset, materialBody, materialCatalog, materialHandoff } from "../src/lightweight-materials.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [projectId, taskId, taskRevisionId, documentId, revisionId, blobId] = [1, 2, 3, 4, 5, 6].map(id);
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const body = "中文内容", asset = Buffer.from([0, 255, 33]);
const client = (reply: unknown): ApiClient => ({ get: async () => reply }) as ApiClient;

test("CLI checks fixed catalog scope, body byte page and both asset hashes", async () => {
  const catalog = { projectId, taskId, taskRevisionId, basisSetId: id(7), title: "Task", acceptance: "Read",
    documents: [{ documentId, revisionId, contentHash: digest(body), sizeBytes: Buffer.byteLength(body), assets: [
      { blobId, contentHash: digest(asset), sizeBytes: asset.length }] }], externalReferences: [] };
  assert.equal((await materialCatalog(client(catalog), projectId, taskId, taskRevisionId)).documents.length, 1);
  await assert.rejects(materialCatalog(client({ ...catalog, taskRevisionId: id(8) }), projectId, taskId, taskRevisionId), /Task revision/);
  const page = { projectId, documentId, revisionId, contentHash: digest(body), body, startByte: 0,
    endByte: Buffer.byteLength(body), totalBytes: Buffer.byteLength(body), nextCursor: null, truncated: false };
  assert.equal((await materialBody(client(page), projectId, documentId, revisionId, digest(body), 0, 4096)).body, body);
  await assert.rejects(materialBody(client({ ...page, body: "篡改" }), projectId, documentId, revisionId, digest(body), 0, 4096), /inconsistent|hash/);
  const reply = { projectId, documentId, revisionId, documentContentHash: digest(body), blobId,
    contentHash: digest(asset), size: asset.length, base64: asset.toString("base64") };
  const directory = await mkdtemp(join(tmpdir(), "evoloop-single-asset-"));
  try {
    const out = join(directory, "asset.bin");
    assert.equal((await materialAsset(client(reply), projectId, documentId, revisionId, blobId,
      digest(body), digest(asset), out)).status, "exported");
    assert.deepEqual(await readFile(out), asset);
    await assert.rejects(materialAsset(client(reply), projectId, documentId, revisionId, blobId,
      digest(body), digest(asset), out), /EEXIST/);
    await assert.rejects(materialAsset(client({ ...reply, base64: Buffer.from("tampered").toString("base64") }),
      projectId, documentId, revisionId, blobId, digest(body), digest(asset)), /hash mismatch/);
    await assert.rejects(materialAsset(client(reply), projectId, documentId, revisionId, blobId,
      digest("changed"), digest(asset)), /Document hash/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("v2 first read verifies identity and fixed input, then shows complete acceptance and material pointers", async () => {
  const runId=id(8), basisSetId=id(7), channelId=id(9), answerId=id(10), answerRevisionId=id(11);
  const actorId="recipient";
  const input=JSON.stringify({protocol:"evoloop-run-v2",taskId,taskRevisionId,basisSetId,
    kind:"queue.continue",reason:"补上后部条件",previousRun:{id:id(12),taskRevisionId:id(13),inputHash:digest("old")},
    answers:[{discussionId:id(14),questionEventId:id(16),messageEventId:id(15),documentId:answerId,revisionId:answerRevisionId,contentHash:digest("answer")}],
    channel:{discussionId:channelId,recipientActorId:actorId,issuerActorId:"lead"}});
  const content="# 任务\n\n说明本轮目标。\n\n## 范围与边界\n保留后部条件："+"中文".repeat(5000)+
    "\n\n## 限制\n仍需读取这里的限制。";
  const catalog={projectId,taskId,taskRevisionId,basisSetId,documents:[{documentId,revisionId,contentHash:digest(content),
    sizeBytes:Buffer.byteLength(content),bodyCommand:"evoloop body fixed",assets:[]}],externalReferences:[]};
  const api=(identity=actorId,actualInput=input):ApiClient=>({get:async(path:string)=>{
    if(path==="/api/session")return {principal:{actorId:identity}};
    if(path.includes(`/runtime/runs/${runId}/input?`))return {projectId,runId,taskRevisionId,inputHash:digest(input),
      body:actualInput,startByte:0,endByte:Buffer.byteLength(actualInput),totalBytes:Buffer.byteLength(actualInput),
      nextCursor:null,truncated:false};
    if(path.endsWith(`/tasks/${taskId}/revisions/${taskRevisionId}`))return {revision:{id:taskRevisionId,
      taskId,projectId,basisSetId,contentDocumentId:documentId,contentRevisionId:revisionId,
      title:"任务",content,acceptance:"验收：完整检查后部条件与原图。"}};
    if(path.endsWith("/materials"))return catalog;
    throw new Error(`unexpected ${path}`);
  }}) as ApiClient;
  const result=await materialHandoff(api(),projectId,runId,digest(input));
  assert.equal(result.introduction,"# 任务\n\n说明本轮目标。");
  assert.equal(result.acceptance,"验收：完整检查后部条件与原图。");
  assert.match(result.boundarySections[0]!,/保留后部条件/);
  assert.equal(result.introductionTruncated,false);
  assert.equal(result.boundarySectionsTotal,2);
  assert.equal(result.boundarySectionsTruncated,true);
  assert.ok(Buffer.byteLength(result.boundarySections.join(""),"utf8")<=6144);
  assert.ok(!JSON.stringify(result.boundarySections).includes("仍需读取这里的限制"));
  assert.equal(result.fullContentCommand,"evoloop body fixed");
  assert.equal(result.contentComplete,false);
  assert.equal(result.contentBytes,Buffer.byteLength(content));
  assert.equal(result.materials.documents.length,1);
  assert.equal(result.change.answeredQuestions[0]?.contentHash,digest("answer"));
  assert.ok(!JSON.stringify(result).includes("old fixed source body"));
  await assert.rejects(materialHandoff(api("other"),projectId,runId,digest(input)),/identity/);
  await assert.rejects(materialHandoff(api(actorId,input+"corrupt"),projectId,runId,digest(input)),/inconsistent|hash/);
});
