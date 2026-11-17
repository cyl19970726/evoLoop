// Task 306bdd7a: the knowledge page asks the service whether the project has a backend before it sends the three reads that could only be refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectCapabilitiesView } from "@evoloop/contracts/project-configuration";
import { knowledgeBackendOf } from "../src/features/knowledge/knowledgeData.ts";

const view = (state: "configured" | "not_configured" | "unknown", reason: string | null = null): ProjectCapabilitiesView => ({ projectId: "p", status: "available",
  items: [{ key: "knowledge", scope: "project", readAt: "start", pending: null, state, reason } as never] });

test("only the service's own 'not configured' means no backend; anything else is asked and answers for itself", () => {
  assert.equal(knowledgeBackendOf(view("not_configured", "project_not_configured")), "none");
  assert.equal(knowledgeBackendOf(view("not_configured", "knowledge_disabled")), "none");
  assert.equal(knowledgeBackendOf(view("configured")), "maybe");
  assert.equal(knowledgeBackendOf(view("unknown", "configuration_unreadable")), "maybe", "a service that cannot judge is not taken as 'no backend'");
  assert.equal(knowledgeBackendOf({ projectId: "p", status: "unavailable" } as never), "maybe");
  assert.equal(knowledgeBackendOf({ projectId: "p", status: "available", items: [] }), "maybe", "no knowledge item: not judged");
});
