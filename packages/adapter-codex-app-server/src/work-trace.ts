import type { RuntimeWorkItem } from "@evoloop/contracts/runtime";

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const positiveDuration = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const field = (value: unknown): { value: string | null; truncated: boolean } => {
  const text = string(value);
  return text === null ? { value: null, truncated: false } : { value: text.slice(0, 2000), truncated: text.length > 2000 };
};
const contentText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  return value.map(part => string(object(part)?.text) ?? string(object(part)?.inputText)).filter((part): part is string => part !== null).join("\n");
};
const textContent = (value: unknown): string | null => contentText(object(value)?.content);

/** Explicit allowlist for 0.154.0 ThreadItem fields. Never stringify an unknown item or reasoning content. */
export function mapWorkItem(value: unknown): RuntimeWorkItem | null {
  const item = object(value);
  if (!item || typeof item.id !== "string") return null;
  let kind: RuntimeWorkItem["kind"];
  let name: string | null = null, status: string | null = null, rawText: string | null = null;
  let rawOutput: string | null = null, rawError: string | null = null, refs: string[] = [];
  let refsTruncated = false, contentUnsupported = false;
  let exitCode: number | null = null, durationMs: number | null = null;
  switch (item.type) {
    case "commandExecution":
      kind = "command"; name = string(item.command); status = string(item.status);
      rawOutput = string(item.aggregatedOutput); exitCode = Number.isSafeInteger(item.exitCode) ? item.exitCode as number : null;
      durationMs = positiveDuration(item.durationMs); break;
    case "mcpToolCall":
      kind = "tool"; name = [string(item.server), string(item.tool)].filter(Boolean).join("/"); status = string(item.status);
      rawOutput = textContent(item.result); rawError = string(object(item.error)?.message);
      contentUnsupported = Array.isArray(object(item.result)?.content) &&
        (object(item.result)!.content as unknown[]).some(part => typeof object(part)?.text !== "string");
      contentUnsupported ||= object(item.result)?.structuredContent != null;
      durationMs = positiveDuration(item.durationMs); break;
    case "dynamicToolCall":
      kind = "tool"; name = [string(item.namespace), string(item.tool)].filter(Boolean).join("/"); status = string(item.status);
      rawOutput = contentText(item.contentItems);
      contentUnsupported = Array.isArray(item.contentItems) && item.contentItems.some(part =>
        typeof object(part)?.text !== "string" && typeof object(part)?.inputText !== "string");
      durationMs = positiveDuration(item.durationMs); break;
    case "fileChange":
      kind = "file_change"; name = "file change"; status = string(item.status);
      refsTruncated = Array.isArray(item.changes) && item.changes.length > 20;
      refs = Array.isArray(item.changes) ? item.changes.map(change => string(object(change)?.path)).filter((path): path is string => path !== null).slice(0, 20) : [];
      break;
    case "agentMessage":
      kind = "message"; name = string(item.phase); rawText = string(item.text); break;
    case "userMessage":
      kind = "message"; name = "user";
      rawText = Array.isArray(item.content) ? item.content.map(part => string(object(part)?.text)).filter((part): part is string => part !== null).join("\n") : null;
      contentUnsupported = Array.isArray(item.content) && item.content.some(part => typeof object(part)?.text !== "string");
      break;
    case "webSearch":
      kind = "web_search"; name = "web search"; rawText = string(item.query); break;
    case "imageView":
      kind = "artifact"; name = "image"; refs = string(item.path) ? [item.path as string] : []; break;
    default: return null;
  }
  const text = field(rawText), output = field(rawOutput), error = field(rawError);
  const boundedId = field(item.id), boundedName = field(name), boundedStatus = field(status), boundedRefs = refs.map(ref => field(ref));
  return { id: boundedId.value!, kind, name: boundedName.value, status: boundedStatus.value, exitCode, text: text.value,
    output: output.value, error: error.value, artifactRefs: boundedRefs.map(ref => ref.value!),
    startedAtUtc: null, completedAtUtc: null, durationMs,
    truncated: text.truncated || output.truncated || error.truncated || boundedId.truncated || boundedName.truncated || boundedStatus.truncated || refsTruncated || contentUnsupported || boundedRefs.some(ref => ref.truncated) };
}
