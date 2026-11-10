// 仓库规范 › 已配置的能力 from GET /capabilities: judged for this project (本项目) or one setting for the whole service
// (全服务); why not; whether the reader can use one granted per actor and why not; what a restart would change; and an
// unknown code said in general words with the code kept, never guessed at.
import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectCapability } from "@evoloop/contracts/project-configuration";
import { capabilitiesUnavailableText, capabilityNotices, capabilityRows } from "../src/features/settings/capabilityPresentation.ts";

const capability = (overrides: Partial<ProjectCapability> & Pick<ProjectCapability, "key">): ProjectCapability =>
  ({ scope: "project", readAt: "start", state: "configured", reason: null, pending: null, ...overrides });
const row = (item: ProjectCapability) => capabilityRows([item])[0]!;

test("configured for this project, or one setting for the whole service", () => {
  const knowledge = row(capability({ key: "knowledge" }));
  assert.deepEqual([knowledge.label, knowledge.tag.label, knowledge.scope, knowledge.text, knowledge.caller, knowledge.pending],
    ["外部知识库", "已配置", "本项目", "本项目已配置。", null, null]);
  const originals = row(capability({ key: "documentOriginals", scope: "service" }));
  assert.deepEqual([originals.scope, originals.text], ["全服务", "全服务已开启。"]);
  assert.equal(row(capability({ key: "documentOriginals", scope: "service", state: "not_configured", reason: "documents_disabled" })).text,
    "全服务未配置：服务端没有接入文档原件存储。");
  assert.equal(knowledge.readAt, "服务启动时读取这项设置，改动要重启后才生效。");
  assert.equal(row(capability({ key: "scheduling", readAt: "start_and_use" })).readAt, "开关在服务启动时读取，其余每次使用时重读。");
});

test("each reason is said precisely; a refused repository registration is not 'no repository'", () => {
  // The service refuses its whole registration for every project, whether or not this project has an entry: the row
  // never says this project is not configured.
  const git = row(capability({ key: "gitSources", state: "not_configured", reason: "repository_registration_invalid" }));
  assert.deepEqual(git.tag, { tone: "blocked", label: "整份登记被拒" });
  assert.equal(git.text, "服务端的仓库登记里有 Git 来源不接受的条目（例如绝对路径、越出仓库、重复登记、非法字符或路径段），整份登记被拒，所有项目现在都读不了 Git 固定来源。");
  assert.doesNotMatch(git.text, /^本项目未配置/);
  assert.doesNotMatch(git.text, /没有为.*配置仓库/);
  assert.match(git.text, /例如/, "the reasons are examples, not a closed list");
  assert.equal(row(capability({ key: "gitSources", state: "not_configured", reason: "repository_registration_invalid",
    pending: { state: "configured", reason: null } })).pending, "改动要重启后才生效：重启后会变为已配置。");
  assert.match(row(capability({ key: "gitSources", pending: { state: "not_configured", reason: "repository_registration_invalid" } })).pending!,
    /^改动要重启后才生效：重启后会变为整份登记被拒（服务端的仓库登记里有/);
  assert.equal(row(capability({ key: "gitSources", state: "not_configured", reason: "project_not_configured" })).text,
    "本项目未配置：服务端有这项能力，但没有为本项目配置。");
  assert.equal(row(capability({ key: "wechat", state: "not_configured", reason: "gateway_not_configured" })).text, "本项目未配置：服务启动时没有配置微信网关。");
  const runtime = row(capability({ key: "runtime", reason: "runtime_unavailable" }));
  assert.deepEqual([runtime.tag, runtime.text], [{ tone: "waiting", label: "已配置，暂不可用" }, "已配置，但读取时运行时不可用。"]);
  const unreadable = row(capability({ key: "scheduling", state: "unknown", reason: "configuration_unreadable" }));
  assert.deepEqual([unreadable.state, unreadable.tag.label, unreadable.text], ["unknown", "无法判断", "现在无法判断：集成配置文件现在读不了。"]);
});

test("whether the reader can use a capability granted per actor, and why not", () => {
  const caller = (callerGranted: boolean | null, callerReason: ProjectCapability["callerReason"] = null, state: ProjectCapability["state"] = "configured") =>
    row(capability({ key: "scheduling", state, reason: state === "configured" ? null : "project_not_configured", callerGranted, callerReason })).caller;
  assert.equal(caller(true), "你可以使用。");
  assert.equal(caller(false, "caller_has_no_grant"), "本项目有授权，但你没有。");
  assert.equal(caller(false, "caller_has_no_grant", "not_configured"), "你没有本项目的这项授权。", "nobody has one: not 'the project has one'");
  assert.equal(caller(false, "caller_lacks_review"), "你有授权，但登录用的令牌缺复核权限。");
  assert.equal(caller(false, "caller_lacks_write"), "你有授权，但登录用的令牌缺写入权限。");
  assert.equal(caller(false, "caller_lacks_write_and_review"), "你有授权，但登录用的令牌缺写入和复核权限。");
  assert.match(caller(false, "caller_not_current_writer")!, /身份文件现在不认你是写入者/);
  assert.equal(caller(null), "你能否使用无法判断（身份或配置文件读不了）。");
  assert.equal(row(capability({ key: "knowledge" })).caller, null, "not granted per actor: nothing about the reader");
  assert.match(row(capability({ key: "taskTiming", callerGranted: true, callerReason: null })).caller!, /按职责给.*所属职责的授权/);
  // Holding a grant does not make a capability that is off as a whole usable.
  const holderOff = row(capability({ key: "scheduling", state: "not_configured", reason: "grant_holder_not_authorized", callerGranted: true, callerReason: null }));
  assert.equal(holderOff.caller, "你这边的授权和令牌都满足，但这项能力整体没有生效，现在用不了。");
  assert.doesNotMatch(holderOff.caller!, /你可以使用/);
  assert.equal(row(capability({ key: "scheduling", state: "unknown", reason: "identities_unreadable", callerGranted: true, callerReason: null })).caller,
    "你这边的授权和令牌都满足，但这项能力整体能否使用无法判断。");
});

test("what a restart would change, in one sentence", () => {
  const off = row(capability({ key: "scheduling", readAt: "start_and_use", pending: { state: "not_configured", reason: "scheduling_disabled" } }));
  assert.equal(off.pending, "改动要重启后才生效：重启后会变为未配置（服务端没有开启日程）。");
  const on = row(capability({ key: "knowledge", state: "not_configured", reason: "knowledge_disabled", pending: { state: "configured", reason: null } }));
  assert.equal(on.pending, "改动要重启后才生效：重启后会变为已配置。");
  const mine = row(capability({ key: "runtime", callerGranted: true, callerReason: null,
    pending: { state: "configured", reason: null, callerGranted: false, callerReason: "caller_has_no_grant" } }));
  assert.equal(mine.pending, "改动要重启后才生效：重启后会对你来说：本项目有授权，但你没有。");
  // A runtime that did not answer is not configuration: a restart is not said to bring it back.
  const runtimeDown = row(capability({ key: "runtime", readAt: "start_and_use", reason: "runtime_unavailable", callerGranted: true, callerReason: null,
    pending: { state: "configured", reason: null, callerGranted: false, callerReason: "caller_has_no_grant" } }));
  assert.equal(runtimeDown.pending, "改动要重启后才生效：重启后会对你来说：本项目有授权，但你没有。");
  assert.doesNotMatch(runtimeDown.pending!, /变为已配置/);
  assert.equal(row(capability({ key: "runtime", reason: "runtime_unavailable", pending: { state: "configured", reason: null } })).pending, null);
});

test("a file that cannot be read now is said once for the page, not as a change on every row", () => {
  const unreadableAfter = { state: "unknown" as const, reason: "configuration_unreadable" as const };
  const items = [capability({ key: "gitSources", pending: unreadableAfter }), capability({ key: "knowledge", pending: unreadableAfter }),
    capability({ key: "scheduling", readAt: "start_and_use", state: "unknown", reason: "configuration_unreadable", callerGranted: null, callerReason: null })];
  const rows = capabilityRows(items);
  assert.deepEqual(rows.map(item => item.pending), [null, null, null], "no row says a restart would make it unknown");
  assert.equal(rows[2]!.text, "现在无法判断：集成配置文件现在读不了。", "what is in effect now is still said");
  assert.deepEqual(capabilityNotices(items), ["集成配置文件现在读不了：依赖它的能力重启后会怎样无法判断；下面是现在生效的结论。"]);
  const identities = [capability({ key: "feishu", callerGranted: true, callerReason: null,
    pending: { state: "unknown", reason: "identities_unreadable", callerGranted: null, callerReason: null } })];
  assert.equal(capabilityRows(identities)[0]!.pending, null);
  assert.deepEqual(capabilityNotices(identities), ["身份文件现在读不了：依赖它的能力重启后会怎样无法判断；下面是现在生效的结论。"]);
  // Only the reader's judgment cannot be made after a restart: that is the unreadable file again, not a change.
  assert.equal(row(capability({ key: "runtime", callerGranted: true, callerReason: null,
    pending: { state: "configured", reason: null, callerGranted: null, callerReason: null } })).pending, null);
  assert.deepEqual(capabilityNotices([capability({ key: "knowledge" })]), []);
});

test("a code the page does not know is said in general words and kept for 完整标识", () => {
  const strange = row(capability({ key: "orchestration", state: "not_configured", reason: "new_reason" as "runtime_disabled" }));
  assert.equal(strange.text, "本项目未配置，原因服务端用了界面不认识的代码（见原因代码）。");
  assert.deepEqual(strange.codes, [{ label: "原因代码", value: "new_reason" }]);
  const callerStrange = row(capability({ key: "feishu", callerGranted: false, callerReason: "caller_new" as "caller_lacks_write" }));
  assert.match(callerStrange.caller!, /界面不认识的代码/);
  assert.deepEqual(callerStrange.codes, [{ label: "你的原因代码", value: "caller_new" }]);
  const unknownKey = row(capability({ key: "newThing" as "runtime" }));
  assert.deepEqual([unknownKey.label, unknownKey.codes], ["未识别的能力", [{ label: "能力代码", value: "newThing" }]]);
  const pendingStrange = row(capability({ key: "runtime", pending: { state: "not_configured", reason: "later_reason" as "runtime_disabled" } }));
  assert.equal(pendingStrange.pending, "改动要重启后才生效：重启后会变为未配置（原因代码见完整标识）。");
  assert.deepEqual(pendingStrange.codes, [{ label: "重启后的原因代码", value: "later_reason" }]);
});

test("a view the service cannot give is never 'nothing configured'", () => {
  const projectId = "p";
  assert.match(capabilitiesUnavailableText({ projectId, status: "unavailable", reason: "not_provided" }).text, /没有提供按项目的能力结论，现在无法判断/);
  assert.match(capabilitiesUnavailableText({ projectId, status: "unavailable", reason: "read_failed" }).text, /读取能力配置失败，现在无法判断/);
  assert.deepEqual(capabilitiesUnavailableText({ projectId, status: "unavailable", reason: "other" as "read_failed" }).code, "other");
});
