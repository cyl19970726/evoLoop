// What a failed request says to the reader (docs/frontend/principles.md 界面用语). Server answers carry a code and a
// message written for agents and logs, often in English ("Knowledge baseline changed"). The reader sees Chinese:
// an answer already written in Chinese is kept; a known code is said in words; any other code or status gets a general
// sentence. The original answer is never lost: it is the `detail` an expandable 诊断信息 shows.
// Pure and free of the request code (api.ts builds on it), so tests read it without a server.

export interface ErrorDescription {
  /** One sentence for the body, in Chinese, without a closing period (callers add their own sentence after it). */
  text: string;
  /** The original answer (message and code) when `text` replaced it; null when `text` is the original. */
  detail: string | null;
  code: string | null;
  /** HTTP status; 0 for a connection that broke or an answer that could not be checked; null when not a request error. */
  status: number | null;
}

/** Codes the coordinator and its services answer with (packages/contracts, apps/coordinator, packages/core). */
const known: Record<string, string> = {
  // Something seen before has changed: read it again before deciding.
  VERSION_CONFLICT: "所见版本已经变化",
  BASELINE_CHANGED: "依据的基线已经变化",
  BASELINE_MISMATCH: "所依据的基线与当前记录不一致",
  CONTENT_BASELINE_CHANGED: "正文依据的基线已经变化",
  DOCUMENT_CHANGED: "文档已经被修改",
  TARGET_CHANGED: "操作对象已经变化",
  DECISION_TARGET_CHANGED: "要决定的对象已经变化",
  REVIEW_TARGET_CHANGED: "要复核的对象已经变化",
  WORK_INDEX_CHANGED: "当前工作记录已经变化",
  TASK_CHANGED: "任务已经被修改",
  TASK_INPUT_CHANGED: "任务的输入已经变化",
  SOURCE_CHANGED: "来源已经变化",
  BASIS_CHANGED: "依据已经变化",
  ACCEPTANCE_CHANGED: "验收要求已经变化",
  EVALUATION_SOURCE_CHANGED: "评价依据的来源已经变化",
  SUBMISSION_VERSION_CONFLICT: "交付的版本已经变化",
  ORCHESTRATION_VERSION_CONFLICT: "统筹记录已经变化",
  TASK_BASELINE_CONFLICT: "任务的基线已经变化",
  STALE_IMPACT: "影响记录已经过期",
  STALE_DELIVERY: "交付记录已经过期",
  // Missing or not visible.
  NOT_FOUND: "要找的记录不存在或已被移除",
  TASK_NOT_FOUND: "任务不存在或已被移除",
  STAGE_NOT_FOUND: "阶段不存在或已被移除",
  PROJECT_NOT_FOUND: "项目不存在，或当前身份看不到它",
  OPERATION_NOT_FOUND: "还没有查到这次提交的记录",
  NOTICE_NOT_FOUND: "通知不存在或已被移除",
  ATTENTION_NOT_FOUND: "关注项不存在或已被移除",
  // Who may do it.
  FORBIDDEN: "当前身份没有这项权限",
  UNAUTHENTICATED: "登录已失效，请重新登录",
  PROJECT_SCOPE: "这条记录不属于当前项目",
  DOCUMENT_SCOPE: "这份文档不属于当前项目",
  SCOPE_NOT_AUTHORIZED: "超出了当前身份的授权范围",
  DELEGATION_DENIED: "当前身份不能代为执行这项操作",
  CREATION_DENIED: "当前身份不能创建这条记录",
  TRUSTED_HUMAN_REQUIRED: "这一步需要由可信的人确认",
  SELF_ACCEPTANCE: "不能验收自己负责的工作",
  // Not set up or not available here.
  KNOWLEDGE_NOT_CONFIGURED: "这个项目还没有配置知识后端",
  CAPABILITY_UNAVAILABLE: "服务暂不支持这项操作",
  UNAVAILABLE: "服务暂时不可用",
  SOURCE_UNAVAILABLE: "来源暂时无法读取或核验",
  SOURCE_WITHDRAWN: "来源已被撤回",
  SOURCE_MISSING: "缺少来源",
  ORIGINAL_UNAVAILABLE: "原件暂时无法读取",
  BASIS_UNAVAILABLE: "依据暂时无法读取",
  TASK_UNAVAILABLE: "任务暂时不可承接",
  SESSION_UNAVAILABLE: "智能体暂时不可用",
  SESSION_NOT_READY: "智能体还没有准备好",
  SESSION_BUSY: "智能体正在处理别的请求",
  RUNTIME_UNAVAILABLE: "运行环境暂时不可用",
  RUNTIME_READ_UNAVAILABLE: "运行状态暂时无法读取",
  ROLE_UNAVAILABLE: "职责暂时不可用",
  MODEL_CATALOG_UNAVAILABLE: "模型目录暂时无法读取",
  MODEL_CATALOG_EMPTY: "模型目录是空的",
  MODEL_NOT_ACTIVE: "所选模型当前不可用",
  MIGRATION_REQUIRED: "服务需要先完成数据升级",
  LEASE_LOST: "服务正在切换，请稍后重试",
  // What was sent does not fit.
  INVALID_INPUT: "填写的内容不符合要求",
  INVALID_COMMAND: "提交的内容不符合要求",
  INVALID_CURSOR: "列表位置已经失效，请从头重新读取",
  INVALID_PAGE: "列表分页参数不符合要求",
  INVALID_FILTER: "筛选条件不符合要求",
  INVALID_STATE: "当前状态不允许这项操作",
  INVALID_SCHEDULE: "日程设置不符合要求",
  INVALID_TIME: "时间不符合要求",
  INVALID_REASON: "理由不符合要求",
  INPUT_LIMIT: "输入超过了允许的长度",
  TOO_LARGE: "内容超过大小上限",
  BODY_TOO_LARGE: "提交的内容超过大小上限",
  RESULT_TOO_LARGE: "结果超过大小上限",
  DOCUMENT_FORMAT: "文档格式不受支持",
  DOCUMENT_ARCHIVED: "文档已归档，不能再修改",
  DUPLICATE_DOCUMENT: "同样的文档已经存在",
  ALREADY_EXISTS: "同样的记录已经存在",
  ALREADY_RECORDED: "这条记录已经登记过",
  OPERATION_REUSED: "这次提交的编号已用于另一项请求",
  OPERATION_CONFLICT: "这次提交的编号已用于另一项请求",
  DEPENDENCY_CYCLE: "这样设置依赖会形成循环",
  // Not the right moment.
  NOT_REVIEWED: "还没有通过审阅",
  NOT_CANDIDATE: "这不是待处理的候选",
  STAGE_NOT_ACTIVE: "阶段不在进行中",
  TASK_NOT_ACTIVE: "任务不在进行中",
  TASK_NOT_READY: "任务还没有准备好",
  TASK_BUSY: "任务正在处理别的请求",
  TASK_DEPENDENCY_BLOCKED: "前置任务还没有放行",
  TASK_REOPEN_REQUIRED: "需要先重新打开任务",
  REOPEN_REQUIRED: "需要先重新打开",
  PARENT_NOT_READY: "上级记录还没有准备好",
  ACTION_EXPIRED: "这项操作已经过期，请重新读取后再试",
  RESULT_UNCONFIRMED: "结果还没有确认",
  NO_CHANGE: "没有需要保存的变化",
};

/** Codes not listed above are said by their family. Order matters: the first match wins. */
const families: Array<[RegExp, string]> = [
  [/(^|_)NOT_FOUND$/, "要找的记录不存在或已被移除"],
  [/_(CHANGED|CONFLICT|SUPERSEDED)$/, "所见内容已经变化"],
  [/(DENIED|FORBIDDEN|NOT_AUTHORIZED|AUTHORITY_REQUIRED|GRANT_MISSING|UNAUTHENTICATED)/, "当前身份没有这项权限"],
  [/(_UNCONFIRMED|_UNKNOWN|_UNVERIFIED)$/, "结果还没有确认"],
  [/(_UNAVAILABLE|_DISABLED|_UNCONFIGURED)$/, "相关服务暂时不可用"],
  [/^INVALID_/, "提交的内容不符合要求"],
  [/_MISMATCH$/, "提交的内容与当前记录不一致"],
  [/(_BUSY|_OCCUPIED|_HELD|_IN_FLIGHT)$/, "对象正在处理别的请求"],
  [/(TOO_LARGE|TOO_LONG|_LIMIT|_EXHAUSTED)$/, "超过了允许的上限"],
  [/(^ALREADY_|_EXISTS$|^DUPLICATE_|_REUSED$|_ALREADY_RECORDED$)/, "同样的记录已经存在"],
  [/_REQUIRED$/, "还缺少这项操作的前提"],
  [/(^NOT_|_NOT_)/, "当前状态不允许这项操作"],
];

function byStatus(status: number | null): string {
  if (status === 400 || status === 422) return "提交的内容不符合要求";
  if (status === 401) return "登录已失效，请重新登录";
  if (status === 403) return "当前身份没有这项权限";
  if (status === 404) return "要找的记录不存在或已被移除";
  if (status === 409) return "服务拒绝了这项请求";
  if (status === 413) return "内容超过大小上限";
  if (status === 429) return "请求太频繁，请稍后再试";
  if (status !== null && status >= 500) return "服务暂时出错";
  if (status === 0) return "连接中断或超时，结果尚未确认";
  return "请求没有完成";
}

/** The Chinese sentence for a code, or null when the code is not known by name or family. */
export function codeText(code: string): string | null {
  return known[code] ?? families.find(([pattern]) => pattern.test(code))?.[1] ?? null;
}

const chinese = /[\u3400-\u9fff]/;
/** No closing period, so a caller can add its own sentence (`${text}。可以重试。`) without doubling it. */
const sentence = (value: string) => value.trim().replace(/[。．.；;，,\s]+$/u, "");

function parts(error: unknown): { message: string; code: string | null; status: number | null } {
  if (!(error instanceof Error)) return { message: typeof error === "string" ? error : "", code: null, status: null };
  const fields = error as Error & { status?: unknown; detail?: unknown };
  const status = typeof fields.status === "number" ? fields.status : null;
  const detail = fields.detail;
  const code = detail && typeof detail === "object" && typeof (detail as { code?: unknown }).code === "string" ? (detail as { code: string }).code : null;
  return { message: error.message, code, status };
}

/** The original answer as sent: message with its code, for 诊断信息. */
function original(message: string, code: string | null): string {
  const text = message.trim();
  return text ? `${text}${code && code !== text ? `（${code}）` : ""}` : code ?? "";
}

/** A failed answer described for the reader: Chinese text, plus the original kept as detail. */
export function describeFailure(message: string, code: string | null, status: number | null): ErrorDescription {
  const said = sentence(message);
  if (said && chinese.test(said)) return { text: said, detail: null, code, status };
  const raw = original(message, code) || null;
  const text = (code ? codeText(code) : null) ?? (status === null && !code ? "请求没有完成" : byStatus(status));
  return { text, detail: raw, code, status };
}

/** What went wrong, for the body of a page or a notice. */
export function describeError(error: unknown): ErrorDescription {
  const { message, code, status } = parts(error);
  return describeFailure(message, code, status);
}

/** The service code of a failed request, when it sent one. */
export function errorCode(error: unknown): string | null {
  return parts(error).code;
}

/** The original answer for a diagnostic layer (诊断信息), whatever language it is in. */
export function errorDiagnostic(error: unknown): string {
  const { message, code } = parts(error);
  return original(message, code) || describeError(error).text;
}
