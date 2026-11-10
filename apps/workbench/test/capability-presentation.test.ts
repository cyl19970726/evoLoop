// 仓库规范 › 已配置的能力 from GET /capabilities: judged for this project (本项目) or one setting for the whole service
// (全服务); why not; whether the reader can use one granted per actor and why not; what a restart would change; and an
// unknown code said in general words with the code kept, never guessed at.
import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectCapability } from "@evoloop/contracts/project-configuration";
import { capabilitiesUnavailableText, capabilityRows } from "../src/features/settings/capabilityPresentation.ts";

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
  const git = row(capability({ key: "gitSources", state: "not_configured", reason: "repository_registration_invalid" }));
  assert.equal(git.tag.label, "未配置");
  assert.match(git.text, /仓库登记有误[\s\S]*整份登记被拒，所有项目都读不了 Git 固定来源/);
  assert.doesNotMatch(git.text, /没有为.*配置仓库/);
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
});

test("what a restart would change, in one sentence", () => {
  const off = row(capability({ key: "scheduling", readAt: "start_and_use", pending: { state: "not_configured", reason: "scheduling_disabled" } }));
  assert.equal(off.pending, "改动要重启后才生效：重启后会变为未配置（服务端没有开启日程）。");
  const on = row(capability({ key: "knowledge", state: "not_configured", reason: "knowledge_disabled", pending: { state: "configured", reason: null } }));
  assert.equal(on.pending, "改动要重启后才生效：重启后会变为已配置。");
  const mine = row(capability({ key: "runtime", callerGranted: true, callerReason: null,
    pending: { state: "configured", reason: null, callerGranted: false, callerReason: "caller_has_no_grant" } }));
  assert.equal(mine.pending, "改动要重启后才生效：重启后会对你来说：本项目有授权，但你没有。");
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
