import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { activeFullExecution } from "../src/runtime/fullExecution.ts";

const revisionId = "11111111-1111-4111-8111-111111111111";
const session = {
  state: "ready", model: "gpt-6-sol", cwd: "/work/project", authorizationScope: "开发任务",
  sandbox: "danger-full-access", approvalPolicy: "never",
  executionProfile: { activationState: "active", activeRevisionId: revisionId,
    revision: { revisionId, model: "gpt-6-sol", cwd: "/work/project", authorizationScope: "开发任务",
      sandbox: "danger-full-access", approvalPolicy: "never" } },
} as RuntimeSessionRecord;

test("new work requires an active matching full execution profile", () => {
  assert.equal(activeFullExecution(session), true);
  assert.equal(activeFullExecution({ ...session, state: "unknown" }), false);
  assert.equal(activeFullExecution({ ...session, sandbox: "read-only" }), false);
  assert.equal(activeFullExecution({ ...session, approvalPolicy: "on-request" }), false);
  assert.equal(activeFullExecution({ ...session, executionProfile: null }), false);
  assert.equal(activeFullExecution({ ...session, executionProfile: { ...session.executionProfile!, activationState: "pending" } }), false);
  assert.equal(activeFullExecution({ ...session, executionProfile: { ...session.executionProfile!, activeRevisionId: null } }), false);
  assert.equal(activeFullExecution({ ...session, executionProfile: { ...session.executionProfile!, revision: {
    ...session.executionProfile!.revision, model: "different-model" } } }), false);
  assert.equal(activeFullExecution({ ...session, executionProfile: { ...session.executionProfile!, revision: {
    ...session.executionProfile!.revision, authorizationScope: "其他任务" } } }), false);
});
