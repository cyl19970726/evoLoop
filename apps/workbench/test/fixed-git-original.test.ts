import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import { ApiError, request } from "../src/api.ts";
import { type FixedGitRead, verifyFixedGitRead } from "../src/references/fixedGitOriginal.ts";

const projectId="11111111-1111-4111-8111-111111111111";
const referenceId="22222222-2222-4222-8222-222222222222";
const commit="a".repeat(40);
const bytes=Buffer.from("# 固定规划\n\n<script>alert('not executed')</script>\n","utf8");
const hash=createHash("sha256").update(bytes).digest("hex");
const record={projectId,id:"33333333-3333-4333-8333-333333333333",kind:"git",
  referenceId,revision:commit,contentHash:hash} as TaskExternalReferenceRecord;
const available: FixedGitRead={status:"available",referenceId,ref:{projectId,repositoryId:"repo",path:"docs/product/functional-scenarios.md",
  commit,contentHash:hash},base64:bytes.toString("base64"),observedAt:"2026-10-24T00:00:00Z"};

test("fixed reader accepts only the exact recorded Git object and its complete SHA-256 bytes", async () => {
  const original=await verifyFixedGitRead(record,available);
  assert.equal(original.ref.path,"docs/product/functional-scenarios.md");
  assert.equal(Buffer.from(original.bytes).equals(bytes),true);
  assert.equal(original.text,bytes.toString("utf8"));
  for (const altered of [
    {...available,referenceId:record.id},
    {...available,ref:{...available.ref,projectId:record.id}},
    {...available,ref:{...available.ref,commit:"b".repeat(40)}},
    {...available,ref:{...available.ref,contentHash:"b".repeat(64)}},
    {...available,base64:Buffer.from("later HEAD bytes").toString("base64")},
    {...available,base64:`${available.base64}\n`},
  ]) await assert.rejects(verifyFixedGitRead(record,altered as FixedGitRead),/原文未展示/);
});

test("unavailable, permission and malformed results never show a substitute original", async () => {
  await assert.rejects(verifyFixedGitRead(record,{status:"unavailable",referenceId,ref:available.ref,
    reason:"permission",observedAt:"2026-10-24T00:00:00Z"}),/无权读取原件/);
  await assert.rejects(verifyFixedGitRead(record,{...available,status:"available",base64:"%%%"}),/Base64/);
  const fetch=mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({message:"forbidden"}),{status:403}));
  try {
    await assert.rejects(request<FixedGitRead>("private",`/api/projects/${projectId}/references/git/${referenceId}`,1000),
      cause => cause instanceof ApiError && cause.status === 403);
  } finally { fetch.mock.restore(); }
});

test("binary original remains available only as verified bytes, without lossy text replacement", async () => {
  const binary=Buffer.from([0xff,0xfe,0x00,0x3c,0x3e]);
  const binaryHash=createHash("sha256").update(binary).digest("hex");
  const original=await verifyFixedGitRead({...record,contentHash:binaryHash},
    {...available,ref:{...available.ref,contentHash:binaryHash},base64:binary.toString("base64")});
  assert.equal(original.text,null);
  assert.equal(Buffer.from(original.bytes).equals(binary),true);
});
