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
    cwd,sandbox:"danger-full-access",model:"reviewed-model",approvalPolicy:"never"};
  const session={projectId,id:randomUUID(),actorId:"business-owner",roleId:grant.roleId,
    authorizationScope:grant.authorizationScope,cwd,sandbox:grant.sandbox,
    approvalPolicy:grant.approvalPolicy,model:"old-model",state:"ready"} as RuntimeSessionRecord;
  const principal={actorId:"controller",projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
  let reviewer=true;
  const authority=staticRecoveryAuthority(()=>loadIntegrations(file),async()=>[{
    token:"r".repeat(40),actorId:"controller",projectIds:[projectId],
    permissions:reviewer?["read","write","review"]:["read","write"],
  },{token:"b".repeat(40),actorId:"business-owner",projectIds:[projectId],permissions:["read","write","review"]}]);
  const target={model:"reviewed-model",sandbox:"danger-full-access" as const,approvalPolicy:"never" as const};
  try {
    await writeFile(file,JSON.stringify({runtime:{enabled:true,grants:[grant]}}));
    assert.equal(await authority.canRevise(principal,session,target),true,'the real reviewer may revise a separately authorized business Session without borrowing its identity');
    assert.equal(await authority.canRevise({...principal,actorId:"other"},session,target),false);
    assert.equal(await authority.canRevise(principal,{...session,roleId:"other"},target),false);
    assert.equal(await authority.canRevise(principal,{...session,authorizationScope:"other"},target),false);
    assert.equal(await authority.canRevise(principal,{...session,sandbox:"read-only",approvalPolicy:"on-request"},target),true,
      "the exact target grant authorizes a versioned upgrade of the original legacy Session");
    assert.equal(await authority.canRevise(principal,session,{...target,model:"old-model"}),false);
    reviewer=false;
    assert.equal(await authority.canRevise(principal,session,target),false);
    reviewer=true;
    await writeFile(file,JSON.stringify({runtime:{enabled:true,grants:[]}}));
    assert.equal(await authority.canRevise(principal,session,target),false,"revocation applies on the next command");
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
