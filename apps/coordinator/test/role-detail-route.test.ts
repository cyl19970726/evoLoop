import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { authConfigSchema } from "../src/auth.js";
import { buildServer } from "../src/server.js";

test("single Role read uses authenticated project scope without listing roles", async t => {
  const projectId="20000001-0000-4000-8000-000000000001";
  const foreignProject="20000002-0000-4000-8000-000000000002";
  const roleId="20000003-0000-4000-8000-000000000003";
  const token="r".repeat(40);
  const credentials=authConfigSchema.parse([{token,actorId:"reader",projectIds:[projectId],permissions:["read"]}]);
  const seen: Array<{actorId:string;projectId:string;roleId:string}>=[];
  let listReads=0;
  const service={
    getRole: async (principal:{actorId:string;projectIds:string[]},pid:string,id:string) => {
      if (!principal.projectIds.includes(pid)) throw new DomainError("FORBIDDEN","foreign project");
      seen.push({actorId:principal.actorId,projectId:pid,roleId:id});
      return {projectId:pid,id,proposal:{title:"实际职责"}};
    },
    listRoles: async () => {listReads++;return {items:[],nextCursor:null};},
    listRoleRevisions: async () => [], listRoleReviews: async () => [],
    listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [],
  } as unknown as WorkflowService;
  const app=await buildServer({credentials,service}); t.after(()=>app.close());
  const url=`/api/projects/${projectId}/roles/${roleId}`;
  assert.equal((await app.inject({url})).statusCode,401);
  const allowed=await app.inject({url,headers:{authorization:`Bearer ${token}`}});
  assert.equal(allowed.statusCode,200);
  assert.equal(allowed.json().proposal.title,"实际职责");
  assert.deepEqual(seen,[{actorId:"reader",projectId,roleId}]);
  assert.equal(listReads,0);
  assert.equal((await app.inject({url:`/api/projects/${foreignProject}/roles/${roleId}`,headers:{authorization:`Bearer ${token}`}})).statusCode,403);
  assert.equal((await app.inject({url:`/api/projects/${projectId}/roles/not-a-uuid`,headers:{authorization:`Bearer ${token}`}})).statusCode,400);
});
