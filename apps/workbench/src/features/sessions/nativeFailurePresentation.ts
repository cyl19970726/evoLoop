import { nativeFailureClass, type NativeFailureClass } from "@evoloop/contracts/runtime";

interface FailureWording { title: string; who: string }
const wording: Record<NativeFailureClass, FailureWording> = {
  quota_or_auth: { title: "运行受阻：模型服务额度不足或鉴权失败", who: "需账户使用者处理（充值或重新授权）；处理前再恢复，新的运行会以同样原因失败" },
  context_too_long: { title: "上下文超长", who: "同一会话可重试，原生运行时会先压缩上下文" },
  connection: { title: "与模型服务的连接中断", who: "通常自行恢复；持续出现时请检查网络与服务状态" },
  other: { title: "原生运行失败", who: "原因未归入已知类别，请核对原始记录" },
};

/** Null when the failure was not classified (older records, or a Turn that ended without a native error). */
export function nativeFailureWording(category: string | null | undefined): FailureWording | null {
  const failureClass = nativeFailureClass(category);
  return failureClass ? wording[failureClass] : null;
}

/** One line for a notice: what stopped, then who has to act. */
export function nativeFailureLine(category: string | null | undefined): string | null {
  const text = nativeFailureWording(category);
  return text ? `${text.title}。${text.who}。` : null;
}
