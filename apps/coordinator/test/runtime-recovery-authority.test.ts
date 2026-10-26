import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSessionRecord } from "@evoloop/contracts";
import { loadIntegrations } from "../src/configuration.js";
import { staticRecoveryAuthority } from "../src/runtime/recovery-authority.js";

test("profile revision authority reloads the exact Session actor and new model grant without database I/O", async () => {
  const cwd=await realpath(await mkdtemp(join(tmpdir(),"evoloop-revise-grant-")));
  const file=join(cwd,"integrations.json"),projectId=randomUUID();
  const grant={projectId,actorId:"business-owner",roleId:"fixed-role",authorizationScope:"task:fixed",
    cwd,sandbox:"read-only",model:"reviewed-model",approvalPolicy:"on-request"};
  const session={projectId,id:randomUUID(),actorId:"business-owner",roleId:grant.roleId,
    authorizationScope:grant.authorizationScope,cwd,sandbox:grant.sandbox,
    approvalPolicy:grant.approvalPolicy,model:"old-model",state:"ready"} as RuntimeSessionRecord;
  const principal={actorId:"controller",projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
  let reviewer=true;
  const authority=staticRecoveryAuthority(()=>loadIntegrations(file),async()=>[{
    token:"r".repeat(40),actorId:"controller",projectIds:[projectId],
    permissions:reviewer?["read","write","review"]:["read","write"],
  },{token:"b".repeat(40),actorId:"business-owner",projectIds:[projectId],permissions:["read","write","review"]}]);
  try {
    await writeFile(file,JSON.stringify({runtime:{enabled:true,grants:[grant]}}));
    assert.equal(await authority.canRevise(principal,session,"reviewed-model"),true,'the real reviewer may revise a separately authorized business Session without borrowing its identity');
    assert.equal(await authority.canRevise({...principal,actorId:"other"},session,"reviewed-model"),false);
    assert.equal(await authority.canRevise(principal,{...session,roleId:"other"},"reviewed-model"),false);
    assert.equal(await authority.canRevise(principal,{...session,authorizationScope:"other"},"reviewed-model"),false);
    assert.equal(await authority.canRevise(principal,{...session,approvalPolicy:"untrusted"},"reviewed-model"),false);
    assert.equal(await authority.canRevise(principal,session,"old-model"),false);
    reviewer=false;
    assert.equal(await authority.canRevise(principal,session,"reviewed-model"),false);
    reviewer=true;
    await writeFile(file,JSON.stringify({runtime:{enabled:true,grants:[]}}));
    assert.equal(await authority.canRevise(principal,session,"reviewed-model"),false,"revocation applies on the next command");
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
