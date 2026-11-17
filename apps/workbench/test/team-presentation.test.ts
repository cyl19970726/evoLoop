import assert from "node:assert/strict";
import test from "node:test";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { teamViewOf } from "../src/features/team/teamPresentation.ts";
import { roleGroups } from "../src/features/roles/rolePresentation.ts";
import { legacyTeamAddress, parseRoute } from "../src/shared/routes.ts";
import { spaceOf } from "../src/app/shell/spaces.ts";

const role = (id: string, title: string, state: RoleRecord["state"], roleClass?: "system" | "business") =>
  ({ id, state, proposal: { title, ...roleClass ? { roleClass } : {} } }) as unknown as RoleRecord;

test("each team section shows its own view, whatever address is on screen when the page mounts", () => {
  assert.equal(teamViewOf("reviews"), "reviews");
  assert.equal(teamViewOf("discussions"), "discussions");
  assert.equal(teamViewOf("roles"), "roles");
  assert.equal(teamViewOf("runtime"), "execution");
});

test("old team links open their current place; a managed agent stays in 运行与接入", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  assert.equal(legacyTeamAddress(`/p/a/runtime?view=roles&role=${id}`), `/p/a/roles?role=${id}`);
  assert.equal(legacyTeamAddress("/p/a/runtime?view=discussions"), "/p/a/discussions");
  assert.equal(legacyTeamAddress(`/p/a/runtime?view=execution&session=${id}`), `/p/a/runtime?session=${id}`);
  assert.equal(legacyTeamAddress("/p/a/runtime?view=execution"), "/p/a/runtime");
  assert.equal(legacyTeamAddress(`/p/a/runtime?session=owned%3A${id}&tab=queue`), `/p/a/sessions?session=owned%3A${id}&tab=queue`);
  assert.equal(legacyTeamAddress(`/p/a/runtime?session=${id}`), null, "a managed agent link is already the 运行与接入 address");
  assert.equal(legacyTeamAddress("/p/a/runtime"), null);
  assert.equal(legacyTeamAddress("/p/a/runtime/?view=roles"), "/p/a/roles", "a trailing slash is the same address");
  assert.equal(legacyTeamAddress("/p/a/roles?view=roles"), null);
  // Task 0f8c7a15: 统筹安排 has its own address; the directory's old 动态 link moves, every other /sessions address stays.
  assert.equal(legacyTeamAddress("/p/a/sessions?view=flow"), "/p/a/arrangement?view=flow", "the old 动态 address opens 统筹安排 › 动态");
  assert.equal(legacyTeamAddress("/p/a/sessions/?view=flow&x=1"), "/p/a/arrangement?view=flow&x=1");
  assert.equal(legacyTeamAddress("/p/a/sessions"), null, "the directory stays at /sessions");
  assert.equal(legacyTeamAddress(`/p/a/sessions?session=owned%3A${id}&view=flow`), null, "an agent link keeps its address");
  assert.equal(parseRoute("/p/a/arrangement").section, "arrangement");
  assert.equal(parseRoute("/p/a/arrangement?view=flow").section, "arrangement");
  assert.equal(spaceOf(parseRoute("/p/a/arrangement")), "work", "统筹安排 belongs to the work space, under 团队");
  assert.equal(spaceOf(parseRoute("/p/a/sessions")), "agents", "the directory belongs to the agents space");
  assert.equal(spaceOf(parseRoute(`/p/a/runtime?session=${id}`)), "work", "运行与接入 belongs to the work space");
  assert.equal(spaceOf(parseRoute(`/p/a/runtime?session=owned:${id}`)), "agents");
});

test("established and trial roles group by class; proposals and closed roles come last", () => {
  const groups = roleGroups([
    role("1", "测试验收", "trial"), role("2", "统筹", "active", "system"), role("3", "前端实现", "active"),
    role("4", "旧职责", "retired"), role("5", "新提议", "candidate", "business"),
  ]);
  assert.deepEqual(groups.map(group => [group.label, group.items.map(item => item.proposal.title)]), [
    ["业务职责", ["前端实现", "测试验收"]], ["系统职责", ["统筹"]], ["提议与已关闭", ["新提议", "旧职责"]],
  ]);
  assert.deepEqual(roleGroups([]), [], "empty groups are left out");
});
