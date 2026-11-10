// The project's configuration in the screenshot fixture (contracts.md 项目配置只读): two repositories, the capabilities
// judged for the reader, and the members, with an edited identity file. Every name here is invented.
import { actorId, projectId } from "./common.mjs";

export const repositories = () => ({ projectId, status: "available", items: [
  { repositoryId: "workbench", allowedPaths: ["docs/", "README.md"] },
  { repositoryId: "design-notes", allowedPaths: ["pages/"] },
] });

const capability = (key, judgment, extra = {}) => ({ key, scope: "project", readAt: "start", reason: null, pending: null, ...judgment, ...extra });
export const capabilities = () => ({ projectId, status: "available", items: [
  capability("gitSources", { state: "configured" }),
  capability("knowledge", { state: "configured" }, { pending: { state: "not_configured", reason: "knowledge_disabled" } }),
  capability("scheduling", { state: "configured", callerGranted: true, callerReason: null }, { readAt: "start_and_use" }),
  capability("taskTiming", { state: "configured", callerGranted: false, callerReason: "caller_has_no_grant" }, { readAt: "start_and_use" }),
  capability("orchestration", { state: "not_configured", reason: "orchestration_disabled" }),
  capability("runtime", { state: "configured", callerGranted: true, callerReason: null }, { readAt: "start_and_use" }),
  capability("feishu", { state: "not_configured", reason: "feishu_disabled", callerGranted: false, callerReason: "caller_has_no_grant" }),
  capability("wechat", { state: "configured" }, { readAt: "start_and_use" }),
  capability("documentOriginals", { state: "configured" }, { scope: "service" }),
] });

const member = (id, identityKind, canWrite, canReview, pending = null) => ({ actorId: id, identityKind, canRead: true, canWrite, canReview, pending });
export const members = () => ({ projectId, status: "available", source: "local_identities", identityFile: "changed", items: [
  member(actorId, "human", true, true),
  member("chen-pm", "human", true, false, { identityKind: "human", canRead: true, canWrite: true, canReview: true }),
  member("li-observer", "human", false, false),
  member("verify-agent", "agent", true, false),
  member("loop-controller", "agent", true, true),
] });
