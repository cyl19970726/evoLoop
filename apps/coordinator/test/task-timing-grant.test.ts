import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { hasTaskTimingGrant } from "../src/configuration.js";

test("a Role timing capability covers new Task IDs only in its project and actor", () => {
  const projectId=randomUUID(), roleId=randomUUID(), actorId="ordinary-task-author";
  const scopeId=`task-timing:${randomUUID()}`;
  const config={enabled:true,grants:[],taskTimingGrants:[{projectId,actorId,roleId}]};
  assert.equal(hasTaskTimingGrant(config,projectId,actorId,roleId,scopeId),true);
  assert.equal(hasTaskTimingGrant(config,randomUUID(),actorId,roleId,scopeId),false);
  assert.equal(hasTaskTimingGrant(config,projectId,"another-actor",roleId,scopeId),false);
  assert.equal(hasTaskTimingGrant(config,projectId,actorId,randomUUID(),scopeId),false);
  assert.equal(hasTaskTimingGrant(config,projectId,actorId,roleId,"legacy-schedule-scope"),false);
  assert.equal(hasTaskTimingGrant({...config,enabled:false},projectId,actorId,roleId,scopeId),false);
});
