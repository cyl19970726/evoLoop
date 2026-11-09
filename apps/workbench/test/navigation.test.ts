// Path addresses, the old `#/p/` links that must keep opening, and the shared history pages listen to.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appPath, isAppPath } from "../src/shared/appPath.ts";
import { currentPath, navigate, onNavigate, replaceQuietly } from "../src/shared/navigation.ts";
import { href, parseRoute, type Section } from "../src/shared/routes.ts";
import { projectPaths } from "../src/app/routePaths.ts";

const project = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";

test("old #/p/ links and path links become the same in-app path; nothing else does", () => {
  assert.equal(appPath(`#/p/${project}/work?filter=mine`), `/p/${project}/work?filter=mine`);
  assert.equal(appPath(`/p/${project}/tasks/${id}`), `/p/${project}/tasks/${id}`);
  assert.equal(appPath("#/"), "/");
  assert.equal(appPath("#/ui"), "/ui");
  for (const outside of ["/api/session", "#workspace-main", "//evil.example/p/x", "https://example.com/p/x", "/assets/a.js", "/p/", "p/x"])
    assert.equal(appPath(outside), null, outside);
  assert.ok(isAppPath("/") && isAppPath("/ui") && isAppPath(`/p/${project}`));
  assert.ok(!isAppPath("/uix") && !isAppPath("/api/p/x"));
});

test("every router address parses to its own section, and href writes the same paths", () => {
  const expected: Record<string, Section> = { "tasks/new": "create-task", "tasks/$taskId": "task", "documents/$documentId": "document", "evaluations/$evaluationId": "evaluations" };
  for (const path of projectPaths) {
    const concrete = path.replace(/\$\w+/, id);
    const route = parseRoute(`/p/${project}/${concrete}`);
    assert.equal(route.projectId, project, path);
    assert.equal(route.section, expected[path] ?? path, path);
    if (path.includes("$")) assert.equal(route.id, id, path);
  }
  assert.equal(href(project, "task", id), `/p/${project}/tasks/${id}`);
  assert.equal(href(project, "document", id, id), `/p/${project}/documents/${id}?revision=${id}`);
  assert.deepEqual(parseRoute(`/p/${project}/sessions?session=${id}`).session, `owned:${id}`);
  assert.deepEqual(parseRoute("/"), { projectId: null, section: "overview" });
  assert.equal(parseRoute(`/p/${project}/unknown`).section, "overview");
});

test("navigation is shared history: pages hear links and Back, not quiet view-state rewrites", () => {
  const heard: string[] = [];
  const stop = onNavigate(() => heard.push(currentPath()));
  try {
    assert.equal(navigate(`#/p/${project}/work`), true, "an old link is accepted");
    assert.equal(currentPath(), `/p/${project}/work`);
    assert.equal(navigate(`/p/${project}/work`), false, "already there");
    replaceQuietly(`/p/${project}/work?filter=mine`);
    assert.equal(currentPath(), `/p/${project}/work?filter=mine`);
    navigate(`/p/${project}/tasks/${id}`);
    assert.deepEqual(heard, [`/p/${project}/work`, `/p/${project}/tasks/${id}`]);
  } finally { stop(); }
});
