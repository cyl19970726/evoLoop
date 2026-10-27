import type { NativeQuestionView } from "./NativeSessionPanel";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const states = new Set(["pending", "response_saved", "resolved", "unavailable"]);
const outcomes = new Set(["pending", "attempted", "submitted", "unknown"]);
const reasonText = (value: string | null): string | null => value === "native_resolved" ? "原生请求已结束。"
  : value === "disconnected" ? "原生连接已断开，请重新读取执行状态。"
  : value === "unsupported" ? "此类原生提问当前不支持在工作区回答。" : value;

/** Reject the whole projection if an owned Session receives malformed or foreign native input. */
export function nativeInputPresentation(value: unknown, sessionId: string): { questions: NativeQuestionView[]; error: string | null } {
  if (value === undefined) return { questions: [], error: null };
  if (!Array.isArray(value) || value.length > 20) return { questions: [], error: "原生提问列表无法核实" };
  const questions: NativeQuestionView[] = [];
  const seen = new Set<string>();
  for (const request of value) {
    if (!record(request) || request.sessionId !== sessionId || typeof request.id !== "string" ||
      !Number.isSafeInteger(request.version) || Number(request.version) < 1 || !nullableString(request.turnId) ||
      !nullableString(request.itemId) || typeof request.isBlocking !== "boolean" ||
      !states.has(String(request.state)) || typeof request.canReply !== "boolean" ||
      !nullableString(request.reason) || typeof request.createdAt !== "string" ||
      !Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 3)
      return { questions: [], error: "原生提问身份或状态无法核实" };
    if (seen.has(request.id)) return { questions: [], error: "原生提问身份重复" };
    seen.add(request.id);
    const source = request.source;
    if (source !== null && (!record(source) || !["run", "message"].includes(String(source.kind)) ||
      typeof (source.kind === "run" ? source.runId : source.messageId) !== "string"))
      return { questions: [], error: "原生提问来源无法核实" };
    const response = request.response;
    if (response !== null && (!record(response) || typeof response.actorId !== "string" ||
      typeof response.savedAt !== "string" || !outcomes.has(String(response.outcome))))
      return { questions: [], error: "原生答复状态无法核实" };
    if (request.state === "response_saved" && response === null)
      return { questions: [], error: "原生答复状态无法核实" };
    const items: NativeQuestionView["questions"] = [];
    const questionIds = new Set<string>();
    for (const item of request.questions) {
      if (!record(item) || typeof item.id !== "string" || typeof item.header !== "string" ||
        typeof item.question !== "string" || typeof item.isOther !== "boolean" ||
        item.options !== null && !Array.isArray(item.options) || questionIds.has(item.id))
        return { questions: [], error: "原生问题内容无法核实" };
      questionIds.add(item.id);
      const options: NativeQuestionView["questions"][number]["options"] = [];
      const optionLabels = new Set<string>();
      for (const choice of item.options ?? []) {
        if (!record(choice) || typeof choice.label !== "string" || typeof choice.description !== "string" ||
          optionLabels.has(choice.label))
          return { questions: [], error: "原生问题选项无法核实" };
        optionLabels.add(choice.label);
        options.push({ label: choice.label, description: choice.description, value: choice.label });
      }
      items.push({ id: item.id, header: item.header, prompt: item.question, secret: false,
        allowOther: item.isOther, options });
    }
    questions.push({ id: request.id, version: Number(request.version), sessionId, threadId: null,
      turnId: request.turnId, itemId: request.itemId,
      sourceKind: source ? source.kind as "run" | "message" : "unbound",
      sourceId: source ? String(source.kind === "run" ? source.runId : source.messageId) : null,
      taskId: source?.kind === "run" && typeof source.taskId === "string" ? source.taskId : null,
      requestedAt: request.createdAt, isBlocking: request.isBlocking,
      state: request.state as NativeQuestionView["state"],
      canReply: request.canReply && source !== null && request.turnId !== null,
      unavailableReason: reasonText(request.reason), respondedBy: response ? String(response.actorId) : null,
      respondedAt: response ? String(response.savedAt) : null,
      responseOutcome: response ? response.outcome as NativeQuestionView["responseOutcome"] : null,
      questions: items });
  }
  return { questions, error: null };
}
