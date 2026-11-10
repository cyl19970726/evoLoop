// What a failed request says to the reader (docs/frontend/principles.md 界面用语). Server answers carry a code and a
// message written for agents and logs, often in English ("Knowledge baseline changed"). The reader sees Chinese:
// an answer already written in Chinese is kept; a known code is said in words; any other answer gets a general
// sentence by its HTTP status. The original answer is never lost: it is the `detail` an expandable 诊断信息 shows.
// The code table (shared/errorCodes.ts) is not in the first-load bundle: the workspace and project-list chunks
// register it when they load. Pure and free of the request code (api.ts builds on it).

export interface ErrorDescription {
  /** One sentence for the body, in Chinese, without a closing period (callers add their own sentence after it). */
  text: string;
  /** The original answer (message and code) when `text` replaced it; null when `text` is the original. */
  detail: string | null;
  code: string | null;
  /** HTTP status; 0 for a connection that broke or an answer that could not be checked; null when not a request error. */
  status: number | null;
}

/** Codes said by name, then by family (first match wins). */
export interface ErrorCodeTable { known: Readonly<Record<string, string>>; families: ReadonlyArray<readonly [RegExp, string]> }

let table: ErrorCodeTable = { known: {}, families: [] };

/** Make the code table available (called when a workspace chunk loads; later calls replace it). */
export function registerErrorCodes(codes: ErrorCodeTable): void {
  table = codes;
}

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

/** The Chinese sentence for a code, or null when the registered table does not know it by name or family. */
export function codeText(code: string): string | null {
  return table.known[code] ?? table.families.find(([pattern]) => pattern.test(code))?.[1] ?? null;
}

const chinese = /[㐀-鿿]/;
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

/**
 * 诊断信息 under a failure said in Chinese: the original answer (errorDiagnostic) when it says more than the sentence
 * on the page, undefined when it would only repeat it.
 */
export function diagnosticOf(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  const raw = errorDiagnostic(error);
  return raw && raw !== describeError(error).text ? raw : undefined;
}

/** A failure kept as text for the page, with its 诊断信息 (for state that outlives the error object). */
export interface Failure { text: string; detail?: string | undefined }
export function failureOf(error: unknown): Failure {
  return { text: describeError(error).text, detail: diagnosticOf(error) };
}
