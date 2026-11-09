import assert from "node:assert/strict";
import test from "node:test";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { roleGroups, sectionOf, teamViewOf } from "../src/features/team/teamPresentation.ts";

const role = (id: string, title: string, state: RoleRecord["state"], roleClass?: "system" | "business") =>
  ({ id, state, proposal: { title, ...roleClass ? { roleClass } : {} } }) as unknown as RoleRecord;

test("team addresses map to their view", () => {
  assert.equal(teamViewOf("/p/a/reviews"), "reviews");
  assert.equal(teamViewOf("/p/a/discussions"), "discussions");
  assert.equal(teamViewOf("/p/a/runtime?view=execution"), "execution");
  assert.equal(teamViewOf("/p/a/runtime?view=roles&role=r1"), "roles");
  assert.equal(teamViewOf("/p/a/runtime"), "execution");
  assert.equal(teamViewOf("/p/a/roles"), "roles");
  assert.equal(sectionOf("/p/a/runtime?view=execution"), "runtime");
  assert.equal(sectionOf("/p/a/roles"), "roles");
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
