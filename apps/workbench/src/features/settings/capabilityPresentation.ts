// 仓库规范 › 已配置的能力: each capability the service judged for this project (GET /capabilities), in words. Whether it is
// judged for this project or is one setting for the whole service, why it is not simply configured, whether the reader
// can use one granted per actor (and why not), what a restart would change, and when the service reads the setting.
// A reason code the page does not know is said in general words, its code kept for the full-identifier layer, never
// guessed at. Pure, so the page and its tests agree.
//
// Two judgments are not what they look like, and are said for what they are:
// - a repository registration the Git source refuses as a whole is the service's, for every project, whether or not
//   this project has an entry: never “本项目未配置”;
// - a runtime that did not answer when read is not configuration: a restart is not said to bring it back (the service
//   compares the two judgments without it too), and a file that cannot be read now makes what a restart would do
//   unknowable for every row, which is said once above the rows instead of on each of them.
import type {
  ProjectCallerReason, ProjectCapabilitiesView, ProjectCapability, ProjectCapabilityJudgment, ProjectCapabilityReason,
} from "@evoloop/contracts/project-configuration";

export type CapabilityState = "yes" | "no" | "unknown";
export interface CapabilityRow {
  key: string;
  label: string;
  state: CapabilityState;
  /** The tag: 已配置, 未配置, 无法判断, 已配置但暂不可用, or 整份登记被拒. */
  tag: { tone: "done" | "idle" | "unknown" | "waiting" | "blocked"; label: string };
  /** 本项目 or 全服务. */
  scope: string;
  /** What is in effect now, and why. */
  text: string;
  /** Whether the reader can use it (only for a capability granted per actor), else null. */
  caller: string | null;
  /** What a restart would change, else null. */
  pending: string | null;
  /** When the service reads the setting this depends on. */
  readAt: string;
  /** Codes the page has no words for, to be shown under 完整标识. */
  codes: Array<{ label: string; value: string }>;
}

export const capabilityLabel: Record<string, string> = {
  gitSources: "Git 固定来源", knowledge: "外部知识库", scheduling: "日程", taskTiming: "任务定时与每日复制",
  orchestration: "自动循环与编排", runtime: "受管智能体运行", feishu: "飞书连接", wechat: "微信连接", documentOriginals: "文档原件与 HTML 报告",
};

/** The whole repository registration refused: the service's, for every project. */
export const registrationRefusedText = "服务端的仓库登记里有 Git 来源不接受的条目（例如绝对路径、越出仓库、重复登记、非法字符或路径段），"
  + "整份登记被拒，所有项目现在都读不了 Git 固定来源";

const reasonText: Record<ProjectCapabilityReason, string> = {
  repository_registration_invalid: registrationRefusedText,
  knowledge_disabled: "服务端没有开启外部知识库",
  scheduling_disabled: "服务端没有开启日程",
  orchestration_disabled: "服务端没有开启自动循环与编排",
  runtime_disabled: "服务端没有开启受管智能体运行",
  feishu_disabled: "服务端没有开启飞书连接",
  message_connectors_disabled: "服务端没有开启消息连接",
  session_messages_disabled: "服务端没有开启发给智能体的消息",
  documents_disabled: "服务端没有接入文档原件存储",
  gateway_not_configured: "服务启动时没有配置微信网关",
  project_not_configured: "服务端有这项能力，但没有为本项目配置",
  grant_holder_not_authorized: "本项目有授权，但持有授权的身份都没有服务要求的权限",
  grant_directory_unavailable: "本项目的运行授权指定的工作目录不被服务接受",
  controller_not_in_project: "自动循环的控制者身份不包含本项目",
  controller_not_authorized: "控制者身份缺少读取、写入或复核权限，自动循环不会启动",
  controller_grants_ambiguous: "控制者在本项目的职责下有多条运行授权，要恰好一条才能代表职责行动",
  runtime_unavailable: "已配置，但读取时运行时不可用",
  configuration_unreadable: "集成配置文件现在读不了",
  identities_unreadable: "身份文件现在读不了",
};

const callerText: Record<ProjectCallerReason, string> = {
  caller_has_no_grant: "你没有本项目的这项授权",
  caller_lacks_write: "你有授权，但登录用的令牌缺写入权限",
  caller_lacks_review: "你有授权，但登录用的令牌缺复核权限",
  caller_lacks_write_and_review: "你有授权，但登录用的令牌缺写入和复核权限",
  caller_not_current_writer: "你有授权，但身份文件现在不认你是写入者（每日复制要求）",
};

/** The files whose being unreadable makes a judgment unknown. */
const unreadableReasons = new Set<string>(["configuration_unreadable", "identities_unreadable"]);

const known = <T extends string>(table: Record<T, string>, code: string): code is T => Object.hasOwn(table, code);

interface Said { text: string; codes: Array<{ label: string; value: string }> }

/** What one judgment says: configured for whom, or why not; an unknown reason in general words with its code kept. */
function judgmentText(judgment: ProjectCapabilityJudgment, scope: ProjectCapability["scope"] | string): Said {
  const where = scope === "service" ? "全服务" : "本项目";
  const reason = judgment.reason;
  const why = reason === null ? null : known(reasonText, reason) ? reasonText[reason] : null;
  const codes = reason !== null && !why ? [{ label: "原因代码", value: reason }] : [];
  // The service's own registration refused: not about this project, whatever the state says.
  if (reason === "repository_registration_invalid") return { text: `${registrationRefusedText}。`, codes };
  if (judgment.state === "configured") {
    if (reason === null) return { text: scope === "service" ? "全服务已开启。" : "本项目已配置。", codes };
    return { text: why ? `${why}。` : `${where}已配置，但服务端另报了一个原因（见原因代码）。`, codes };
  }
  if (judgment.state === "not_configured")
    return { text: why ? `${where}未配置：${why}。` : `${where}未配置，原因服务端用了界面不认识的代码（见原因代码）。`, codes };
  if (judgment.state === "unknown")
    return { text: why ? `现在无法判断：${why}。` : "现在无法判断，原因服务端用了界面不认识的代码（见原因代码）。", codes };
  return { text: "服务端报告了界面不认识的状态，无法判断。", codes: [...codes, { label: "状态代码", value: String(judgment.state) }] };
}

/**
 * Whether the reader can use a capability granted per actor. Null for one that is not granted per actor. The reader
 * can use it only when the capability is configured as a whole: holding a grant does not make it work.
 */
function callerSaid(judgment: ProjectCapabilityJudgment, key: string): Said | null {
  if (judgment.callerGranted === undefined) return null;
  if (judgment.callerGranted === null) return { text: "你能否使用无法判断（身份或配置文件读不了）。", codes: [] };
  if (judgment.callerGranted) {
    if (judgment.state === "not_configured") return { text: "你这边的授权和令牌都满足，但这项能力整体没有生效，现在用不了。", codes: [] };
    if (judgment.state !== "configured") return { text: "你这边的授权和令牌都满足，但这项能力整体能否使用无法判断。", codes: [] };
    return { text: key === "taskTiming"
      ? "你可以使用。每日复制的授权按职责给，给某项任务设每日复制仍要有该任务所属职责的授权。" : "你可以使用。", codes: [] };
  }
  const reason = judgment.callerReason ?? null;
  if (reason === "caller_has_no_grant" && judgment.state === "configured") return { text: "本项目有授权，但你没有。", codes: [] };
  if (reason !== null && known(callerText, reason)) return { text: `${callerText[reason]}。`, codes: [] };
  return { text: "你不能使用；原因服务端没有报告，或用了界面不认识的代码。", codes: reason ? [{ label: "你的原因代码", value: reason }] : [] };
}

function tagOf(judgment: ProjectCapabilityJudgment): CapabilityRow["tag"] {
  if (judgment.reason === "repository_registration_invalid") return { tone: "blocked", label: "整份登记被拒" };
  if (judgment.state === "configured") return judgment.reason === "runtime_unavailable" ? { tone: "waiting", label: "已配置，暂不可用" } : { tone: "done", label: "已配置" };
  if (judgment.state === "not_configured") return { tone: "idle", label: "未配置" };
  return { tone: "unknown", label: "无法判断" };
}

/** A judgment as configuration: a runtime that did not answer is not configuration (the service compares without it). */
const asConfiguration = (judgment: ProjectCapabilityJudgment): ProjectCapabilityJudgment =>
  judgment.reason === "runtime_unavailable" ? { ...judgment, reason: null } : judgment;

/** A judgment after a restart that only says a file cannot be read now: what a restart would do is not known. */
const unreadableAfter = (after: ProjectCapabilityJudgment) => after.reason !== null && unreadableReasons.has(after.reason);

/**
 * What a restart would change, as one sentence: 改动要重启后才生效：重启后会…… A restart judged on a file that cannot be
 * read now says nothing here (capabilityNotices says it once for the page).
 */
function pendingText(capability: ProjectCapability): Said | null {
  const after = capability.pending;
  if (!after || unreadableAfter(after)) return null;
  const now = asConfiguration(capability);
  const parts: string[] = [];
  const codes: Said["codes"] = [];
  if (after.state !== now.state || after.reason !== now.reason) {
    const reason = after.reason;
    const why = reason === null ? null : known(reasonText, reason) ? reasonText[reason] : "原因代码见完整标识";
    if (reason !== null && !known(reasonText, reason)) codes.push({ label: "重启后的原因代码", value: reason });
    const state = reason === "repository_registration_invalid" ? "整份登记被拒"
      : after.state === "configured" ? "已配置" : after.state === "not_configured" ? "未配置" : "无法判断";
    parts.push(why ? `变为${state}（${why}）` : `变为${state}`);
  }
  // A caller judgment that cannot be made after a restart is the unreadable file again, not a change.
  if (after.callerGranted !== null && ((after.callerGranted ?? null) !== (now.callerGranted ?? null) || (after.callerReason ?? null) !== (now.callerReason ?? null))) {
    const said = callerSaid(after, capability.key);
    if (said) { parts.push(`对你来说：${said.text.replace(/。$/, "")}`); codes.push(...said.codes.map(code => ({ ...code, label: `重启后的${code.label}` }))); }
  }
  if (!parts.length) return null;
  return { text: `改动要重启后才生效：重启后会${parts.join("；")}。`, codes };
}

const readAtText: Record<string, string> = {
  start: "服务启动时读取这项设置，改动要重启后才生效。",
  start_and_use: "开关在服务启动时读取，其余每次使用时重读。",
};

/** One row per capability, in the service's order. */
export function capabilityRows(items: readonly ProjectCapability[]): CapabilityRow[] {
  return items.map(item => {
    const now = judgmentText(item, item.scope);
    const caller = callerSaid(item, item.key);
    const pending = pendingText(item);
    const named = Object.hasOwn(capabilityLabel, item.key);
    return {
      key: item.key, label: named ? capabilityLabel[item.key]! : "未识别的能力", state: item.state === "configured" ? "yes" : item.state === "not_configured" ? "no" : "unknown",
      tag: tagOf(item), scope: item.scope === "service" ? "全服务" : "本项目", text: now.text, caller: caller?.text ?? null, pending: pending?.text ?? null,
      readAt: readAtText[item.readAt] ?? "服务端没有说明何时读取这项设置。",
      codes: [...named ? [] : [{ label: "能力代码", value: item.key }], ...now.codes, ...caller?.codes ?? [], ...pending?.codes ?? []],
    };
  });
}

/**
 * What the page says once above the rows: a file the service cannot read now, so what a restart would do cannot be
 * judged for any capability that depends on it (rather than “重启后会变为无法判断” on every row).
 */
export function capabilityNotices(items: readonly ProjectCapability[]): string[] {
  const reasons = new Set(items.flatMap(item => item.pending && unreadableAfter(item.pending) ? [item.pending.reason!] : []));
  const notices: string[] = [];
  if (reasons.has("configuration_unreadable")) notices.push("集成配置文件现在读不了：依赖它的能力重启后会怎样无法判断；下面是现在生效的结论。");
  if (reasons.has("identities_unreadable")) notices.push("身份文件现在读不了：依赖它的能力重启后会怎样无法判断；下面是现在生效的结论。");
  return notices;
}

/** Why the capability view as a whole cannot be read; never “nothing configured”. */
export function capabilitiesUnavailableText(view: Extract<ProjectCapabilitiesView, { status: "unavailable" }>): { text: string; code: string | null } {
  if (view.reason === "not_provided") return { text: "服务端没有提供按项目的能力结论，现在无法判断哪些能力已为本项目配置。", code: null };
  if (view.reason === "read_failed") return { text: "服务端读取能力配置失败，现在无法判断哪些能力已为本项目配置。", code: null };
  return { text: "服务端说能力结论暂不可用，原因用了界面不认识的代码，现在无法判断。", code: String(view.reason) };
}
