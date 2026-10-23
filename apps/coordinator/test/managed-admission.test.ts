import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {managedRuntimeAdmission} from "../src/orchestration/admission.js";
import {loopIntentId} from "../src/orchestration/runner.js";
import {runtimeThreadConfig} from "../src/configuration.js";

test("pause fences the deterministic Session and Run before either Run or resolve binding exists", async () => {
  const dispatch = randomUUID(), project = randomUUID();
  let state = "paused";
  const pool = {query: async () => ({rows: [{dispatch_id: dispatch, run_id: null, state}]})} as unknown as Pool;
  const admit = managedRuntimeAdmission(pool);
  assert.equal(await admit(project, "session", loopIntentId(dispatch, "session")), false);
  assert.equal(await admit(project, "run", loopIntentId(dispatch, "run")), false);
  state = "stopped";
  assert.equal(await admit(project, "run", loopIntentId(dispatch, "run")), false);
  state = "active";
  assert.equal(await admit(project, "run", loopIntentId(dispatch, "run")), true);
  assert.equal(await admit(project, "run", randomUUID()), true); // Ordinary non-loop Runs keep their existing grant path.
});
test("native network configuration belongs to the actual reservation actor", () => {
  const grant = {projectId: randomUUID(), actorId: "network-owner", roleId: "review", authorizationScope: "scope",
    cwd: "/private/work", sandbox: "workspace-write" as const, networkAccess: true};
  const spec = {actorId: "restricted-owner", sessionId: randomUUID(), projectId: grant.projectId, roleId: grant.roleId,
    authorizationScope: grant.authorizationScope, cwd: grant.cwd, sandbox: grant.sandbox, approvalPolicy: "on-request" as const};
  assert.equal(runtimeThreadConfig([grant], spec), undefined);
  assert.deepEqual(runtimeThreadConfig([grant], {...spec, actorId: grant.actorId}), {"sandbox_workspace_write.network_access": true});
  assert.equal(runtimeThreadConfig([grant], {...spec, actorId: grant.actorId, sandbox: "read-only"}), undefined);
});
