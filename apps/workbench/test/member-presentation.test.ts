// Choosing a member by name (GET /members) where a form took a typed sign-in identity: only members who can do what the
// place needs are offered, a member whose write cannot be judged is shown and not offered, an edited identity file is
// said with what changes after a restart, and with no list the identity is typed. The value stays the identity itself.
import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMember, ProjectMembersView } from "@evoloop/contracts/project-configuration";
import { acceptanceMemberKind, acceptanceMemberNeed, memberChoices, memberPendingText, memberPlaceholder } from "../src/shared/memberPresentation.ts";
import { scheduleTemplate } from "../src/features/scheduling/managedTarget.ts";
import { acceptanceResponsibilityCommand } from "../src/features/workflow/taskCommands.ts";
import { emptyTaskDraft, taskCreateCommand } from "../src/features/workflow/taskCreate.ts";

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
  assert.deepEqual(kept("li-reader"), { value: "li-reader", label: "li-reader（当前所填；不能写入）", disabled: false });
  assert.equal(kept("someone-else").label, "someone-else（当前所填；不在本项目的成员清单里）");
  assert.equal(kept("verify-agent").label, "verify-agent（当前所填；是智能体，这里要人）");
  assert.equal(kept("wang-unsure").label, "wang-unsure（当前所填；能否写入无法判断）");
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

test("a member chosen by name sends the request body the typed identity sent, field for field", () => {
  // The chooser hands the form the member's identity as it is listed; each command is compared with the body the typed
  // form sent before this change, written out in full.
  const [chosen] = memberChoices(view(team), "write", "human").options;
  assert.equal(chosen!.value, "zhang-reviewer");
  const detail = { task: { id: "t", version: 3, title: "巡检", content: "按清单", acceptance: "留报告", owner: "role-1", kind: null },
    links: [{ documentId: "d1" }], basis: null, proposal: { acceptanceMode: "human_required", consumer: null } } as unknown as Parameters<typeof acceptanceResponsibilityCommand>[0];
  assert.deepEqual(acceptanceResponsibilityCommand(detail, { taskVersion: 3 }, { acceptanceMode: "human_required", consumer: chosen!.value, reason: "本人验收" }), {
    taskId: "t", expectedVersion: 3, type: "task.update", title: "巡检", content: "按清单", acceptance: "留报告", owner: "role-1", kind: null,
    documentIds: ["d1"], acceptanceMode: "human_required", useRequired: true, consumer: "zhang-reviewer", reason: "本人验收" });
  assert.deepEqual(scheduleTemplate({ title: "巡检", content: "", acceptance: "a", owner: "r", acceptanceMode: "human_required", consumer: chosen!.value }),
    { title: "巡检", content: "", acceptance: "a", owner: "r", acceptanceMode: "human_required", consumer: "zhang-reviewer" });
  const draft = { ...emptyTaskDraft("Asia/Shanghai"), title: "整理验收清单", why: "旧清单过时", outcome: "新清单", acceptance: "本人用过", owner: "role-1",
    acceptanceMode: "human_required" as const, consumer: chosen!.value };
  assert.deepEqual(taskCreateCommand(draft, "task-1"), { type: "task.create", taskId: "task-1", title: "整理验收清单", kind: null,
    content: "旧清单过时\n\n期望结果\n新清单", acceptance: "本人用过", owner: "role-1", acceptanceMode: "human_required", useRequired: true,
    consumer: "zhang-reviewer" });
  // Nothing chosen for an optional identity: the field is left out, as when nothing was typed.
  assert.equal("consumer" in taskCreateCommand({ ...draft, acceptanceMode: "independent_agent", consumer: "" }, "task-1"), false);
});

test("an old task's acceptance takes any member, or someone outside the project", () => {
  // A reviewer records a person's use for them under the old agreement: no permission of their own is needed.
  assert.equal(acceptanceMemberNeed("legacy"), "any");
  assert.equal(acceptanceMemberNeed("human_required"), "write");
  assert.equal(acceptanceMemberNeed("independent_agent"), "write");
  const legacy = memberChoices(view(team), "any", null);
  assert.deepEqual(legacy.options.map(option => [option.value, option.disabled]),
    [["zhang-reviewer", false], ["li-reader", false], ["wang-unsure", false], ["verify-agent", false], ["loop-controller", false]]);
  assert.equal(legacy.leftOut, null);
  assert.equal(memberChoices(view(team, "unreadable"), "any", null).notice, null, "an unreadable file does not matter where no permission is needed");
  assert.equal(memberChoices(view(team), "any", null, "outside-person").options[0]!.label, "outside-person（当前所填；不在本项目的成员清单里）");
});

test("the empty choice never says nobody when it cannot tell; a held undecided member is listed once", () => {
  const unsure = view([member("a", { canWrite: null }), member("b", { canWrite: null })], "unreadable");
  const choices = memberChoices(unsure, "write", "human");
  assert.deepEqual([choices.eligible, choices.undecided], [0, 2]);
  assert.equal(memberPlaceholder(choices, true), "暂时无法判断谁可选");
  assert.equal(memberPlaceholder({ eligible: 0, undecided: 0 }, true), "本项目没有可选的成员");
  assert.equal(memberPlaceholder({ eligible: 2, undecided: 0 }, true), "不指定");
  assert.equal(memberPlaceholder({ eligible: 2, undecided: 0 }, false), "选择成员", "a place that must name someone offers no 不指定");
  const held = memberChoices(unsure, "write", "human", "a");
  assert.deepEqual(held.options.map(option => [option.value, option.disabled]), [["a", false], ["b", true]]);
  assert.equal(new Set(held.options.map(option => option.value)).size, held.options.length, "no two options share a value");
});

test("an edited identity file that changes nobody here says so", () => {
  const unchangedHere = memberChoices(view(team, "changed"), "write", null);
  assert.deepEqual(unchangedHere.notice, { tone: "info", title: "身份文件已改动，本项目成员的权限没有变化", text: "下面按现在生效的权限列出。" });
  assert.deepEqual(unchangedHere.pending, []);
});
