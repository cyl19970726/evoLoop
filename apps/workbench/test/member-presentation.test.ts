// Choosing a member by name (GET /members) where a form took a typed sign-in identity: only members who can do what the
// place needs are offered, a member whose write cannot be judged is shown and not offered, an edited identity file is
// said with what changes after a restart, and with no list the identity is typed. The value stays the identity itself.
import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMember, ProjectMembersView } from "@evoloop/contracts/project-configuration";
import { acceptanceMemberKind, memberChoices, memberPendingText } from "../src/shared/memberPresentation.ts";
import { scheduleTemplate } from "../src/features/scheduling/managedTarget.ts";
import { acceptanceResponsibilityCommand } from "../src/features/workflow/taskCommands.ts";

const projectId = "p";
const member = (actorId: string, overrides: Partial<ProjectMember> = {}): ProjectMember =>
  ({ actorId, identityKind: "human", canRead: true, canWrite: true, canReview: false, pending: null, ...overrides });
const view = (items: ProjectMember[], identityFile: "unchanged" | "changed" | "unreadable" | null = "unchanged"): ProjectMembersView =>
  ({ projectId, status: "available", source: "local_identities", identityFile, items });
const team = [
  member("zhang-reviewer", { canReview: true }),
  member("li-reader", { canWrite: false }),
  member("wang-unsure", { canWrite: null }),
  member("verify-agent", { identityKind: "agent" }),
  member("loop-controller", { identityKind: "agent", canReview: true }),
];

test("a place that needs write offers only members who can write, of the kind it takes", () => {
  const people = memberChoices(view(team), "write", "human");
  assert.deepEqual(people.options.map(option => [option.value, option.disabled]), [["zhang-reviewer", false], ["wang-unsure", true]]);
  assert.equal(people.options[0]!.label, "zhang-reviewer · 人");
  assert.equal(people.options[1]!.label, "wang-unsure · 能否写入无法判断（身份文件读不了）", "unknown write is shown, never offered");
  assert.equal(people.eligible, 1);
  assert.equal(people.leftOut, "另有 1 位不能写入、2 位不是人，没有列出。");
  const agents = memberChoices(view(team), "write", "agent");
  assert.deepEqual(agents.options.map(option => option.value), ["verify-agent", "loop-controller"]);
  assert.equal(memberChoices(view(team), "write", null).eligible, 3);
});

test("a place that needs review offers only members who can review", () => {
  const reviewers = memberChoices(view(team), "review", null);
  assert.deepEqual(reviewers.options.map(option => option.value), ["zhang-reviewer", "loop-controller"]);
  assert.equal(reviewers.leftOut, "另有 3 位不能复核，没有列出。");
});

test("the value already registered stays offered as it is, said for what it is", () => {
  const kept = (value: string, kind: "human" | "agent" | null = "human") => memberChoices(view(team), "write", kind, value).options[0]!;
  assert.deepEqual(kept("li-reader"), { value: "li-reader", label: "li-reader（当前登记；不能写入）", disabled: false });
  assert.equal(kept("someone-else").label, "someone-else（当前登记；不在本项目的成员清单里）");
  assert.equal(kept("verify-agent").label, "verify-agent（当前登记；是智能体，这里要人）");
  assert.equal(kept("wang-unsure").label, "wang-unsure（当前登记；能否写入无法判断）");
  assert.equal(memberChoices(view(team), "write", "human", "zhang-reviewer").options.filter(option => option.value === "zhang-reviewer").length, 1,
    "an offered member is not listed twice");
});

test("an edited identity file is said, with what each member could do after a restart", () => {
  const edited = view([member("zhang-reviewer", { pending: { identityKind: "human", canRead: true, canWrite: false, canReview: false } }),
    member("new-person", { canWrite: false, pending: { identityKind: "human", canRead: true, canWrite: true, canReview: true } }),
    member("agent-now", { identityKind: "agent", pending: { identityKind: "human", canRead: false, canWrite: true, canReview: false } })], "changed");
  const choices = memberChoices(edited, "write", null);
  assert.deepEqual(choices.notice, { tone: "waiting", title: "身份文件已改动，部分成员的权限要重启后才生效", text: "下面按现在生效的权限列出；重启后会变的成员另行写明。" });
  assert.deepEqual(choices.pending, ["zhang-reviewer：重启后不能再写入", "new-person：重启后才能写入，才能复核",
    "agent-now：重启后身份类型变为人，不能再登录读取"]);
  assert.deepEqual(choices.options.map(option => option.value), ["zhang-reviewer", "agent-now"], "what is in effect now decides who is offered");
  assert.equal(memberPendingText(member("x")), null);
  assert.equal(memberPendingText(member("y", { canWrite: null, pending: { identityKind: "human", canRead: true, canWrite: false, canReview: false } })), "y：重启后不能写入");
  assert.equal(memberChoices(view(team, "unreadable"), "write", null).notice?.title, "身份文件现在读不了");
  assert.equal(memberChoices(view(team, null), "write", null).notice, null, "a member source that is not an identity file says nothing about one");
});

test("without a member list the identity is typed, and the reason is said", () => {
  const notProvided = memberChoices({ projectId, status: "unavailable", reason: "not_provided" }, "write", "human");
  assert.equal(notProvided.mode, "typed");
  assert.match(notProvided.notice!.text, /没有提供本项目的成员清单，请按完整标识填写/);
  assert.match(memberChoices({ projectId, status: "unavailable", reason: "read_failed" }, "write", null).notice!.text, /读取成员清单失败/);
  assert.equal(memberChoices({ projectId, status: "unavailable", reason: "later" as "read_failed" }, "write", null).code, "later");
});

test("the kind follows the acceptance mode", () => {
  assert.equal(acceptanceMemberKind("human_required"), "human");
  assert.equal(acceptanceMemberKind("independent_agent"), "agent");
  assert.equal(acceptanceMemberKind("legacy"), null);
  assert.equal(acceptanceMemberKind(undefined), null);
});

test("a member chosen by name sends the same request body as the identity typed", () => {
  // The chooser hands the form the member's identity, the very string that was typed before.
  const [chosen] = memberChoices(view(team), "write", "human").options;
  const detail = { task: { id: "t", version: 3 }, links: [], basis: null, proposal: { acceptanceMode: "human_required", consumer: null } } as unknown as Parameters<typeof acceptanceResponsibilityCommand>[0];
  const byName = acceptanceResponsibilityCommand(detail, { taskVersion: 3 }, { acceptanceMode: "human_required", consumer: chosen!.value, reason: "本人验收" });
  const typed = acceptanceResponsibilityCommand(detail, { taskVersion: 3 }, { acceptanceMode: "human_required", consumer: "zhang-reviewer", reason: "本人验收" });
  assert.deepEqual(byName, typed);
  assert.equal((byName as { consumer: string }).consumer, "zhang-reviewer");
  const template = (consumer: string) => scheduleTemplate({ title: "巡检", content: "", acceptance: "a", owner: "r", acceptanceMode: "human_required", consumer });
  assert.deepEqual(template(chosen!.value), template("zhang-reviewer"));
});
