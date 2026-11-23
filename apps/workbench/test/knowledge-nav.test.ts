import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectCapabilitiesView } from "../src/shared/api";
import { knowledgeConfiguredIn } from "../src/features/knowledge/knowledgeNav";

const view = (state: string | null): ProjectCapabilitiesView => ({ projectId: "p", status: "available",
  items: state ? [{ key: "knowledge", scope: "project", readAt: "start", pending: null, state, reason: state === "not_configured" ? "project_not_configured" : null }] : [] } as unknown as ProjectCapabilitiesView);

test("知识空间 is listed only when the service's own judgment of the project says configured (Task 95fc1fb1)", () => {
  assert.equal(knowledgeConfiguredIn(view("configured")), true);
  assert.equal(knowledgeConfiguredIn(view("not_configured")), false, "a project without a backend is a normal state, not listed");
  assert.equal(knowledgeConfiguredIn(view("unknown")), false, "an unknown state lists nothing");
  assert.equal(knowledgeConfiguredIn(view(null)), false, "a service that does not judge it lists nothing");
  assert.equal(knowledgeConfiguredIn({ projectId: "p", status: "unavailable" } as unknown as ProjectCapabilitiesView), false);
});
