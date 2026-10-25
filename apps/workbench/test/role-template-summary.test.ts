import assert from "node:assert/strict";
import { test } from "node:test";
import { initialRoleTemplates } from "@evoloop/contracts/roles";
import { parseRoleTemplateSummary, roleTemplateHref } from "../src/roles/RoleTemplateSummary";

const projectId = "30000001-0000-4000-8000-000000000001";
const roleId = "30000002-0000-4000-8000-000000000002";
const otherProject = "30000003-0000-4000-8000-000000000003";
const response = () => ({
  templates: initialRoleTemplates.map(item => ({ ...item, state: item.key === "lead" ? "established" : "not-established", roleIds: item.key === "lead" ? [roleId] : [] })),
  roles: [{ projectId, id: roleId, state: "trial", proposal: { title: "实际 Lead 职责", roleClass: "system", templateKey: "lead" } }],
  nextCursor: null as string | null,
});

test("seven contract templates show real role names and keep work kind separate", () => {
  const value = parseRoleTemplateSummary(response(), projectId);
  assert.equal(value.rows.length, 7);
  assert.deepEqual(value.rows.map(row => [row.key, row.roleClass, row.state]), [
    ["lead", "system", "established"], ["cognition", "system", "not-established"],
    ["division", "system", "not-established"], ["product", "business", "not-established"],
    ["architecture", "business", "not-established"], ["development-workflow", "business", "not-established"],
    ["functional-development", "business", "not-established"],
  ]);
  assert.deepEqual(value.rows[0]?.roles, [{ id: roleId, title: "实际 Lead 职责" }]);
  assert.equal(roleTemplateHref(projectId, roleId), `#/p/${projectId}/roles?role=${roleId}`);
  assert.equal(roleTemplateHref(projectId, "not-a-role"), null);
});

test("partial role list cannot claim missing templates are unestablished", () => {
  const value = response();
  value.nextCursor = otherProject;
  const parsed = parseRoleTemplateSummary(value, projectId);
  assert.equal(parsed.rows[1]?.state, "unknown");
  assert.equal(parsed.rows[0]?.state, "established");
});

test("unverified or mismatched role keeps its ID without a name or navigation target", () => {
  const value = response();
  value.roles[0]!.projectId = otherProject;
  const parsed = parseRoleTemplateSummary(value, projectId);
  assert.deepEqual(parsed.rows[0]?.roles, []);
  assert.deepEqual(parsed.rows[0]?.unresolvedIds, [roleId]);
  assert.equal(parsed.rows[0]?.state, "unknown");
  value.roles[0]!.projectId = projectId;
  value.roles[0]!.proposal.templateKey = "product";
  assert.deepEqual(parseRoleTemplateSummary(value, projectId).rows[0]?.unresolvedIds, [roleId]);
});

test("malformed template list is an error, never a trustworthy empty state", () => {
  const missing = response();
  missing.templates.pop();
  assert.throws(() => parseRoleTemplateSummary(missing, projectId), /模板数量/);
  const changed = response();
  changed.templates[0]!.roleClass = "business";
  assert.throws(() => parseRoleTemplateSummary(changed, projectId), /模板与合同/);
});
