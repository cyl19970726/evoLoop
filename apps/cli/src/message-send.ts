import { readFile } from "node:fs/promises";
import type { SessionTarget } from "@evoloop/contracts/session-work";

export const MAX_MESSAGE_CONTENT = 16000;

export class MessageBodyError extends Error {
  constructor(message: string) { super(message); this.name = "MessageBodyError"; }
}

/** Decode bytes once with fatal UTF-8 so corruption cannot become a plausible shorter message. */
export function decodeMessageBody(bytes: Uint8Array): string {
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new MessageBodyError("Message body is not valid UTF-8; save it as a UTF-8 text file and retry."); }
  const normalized = content.trim();
  if (!normalized) throw new MessageBodyError("Message body is empty after trimming whitespace.");
  if (normalized.length > MAX_MESSAGE_CONTENT)
    throw new MessageBodyError(`Message body exceeds ${MAX_MESSAGE_CONTENT} characters; split it or attach the full text as a document.`);
  if (normalized.includes("\uFFFD"))
    throw new MessageBodyError("Message body contains the Unicode replacement character; the source text was probably corrupted.");
  if (!/[\p{L}\p{N}]/u.test(normalized))
    throw new MessageBodyError("Message body has no letters or numbers; it looks empty or truncated. Check the source text before sending.");
  return normalized;
}

export async function readMessageBody(file: string | undefined, stdin: AsyncIterable<Uint8Array>): Promise<string> {
  if (file !== undefined) return decodeMessageBody(await readFile(file));
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return decodeMessageBody(Buffer.concat(chunks));
}

export function parseSessionTarget(key: string): SessionTarget {
  const match = /^(owned|external):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(key);
  if (!match) throw new MessageBodyError("Use an exact owned:UUID or external:UUID recipient key.");
  return match[1]!.toLowerCase() === "owned"
    ? { kind: "owned", sessionId: match[2]! }
    : { kind: "external", linkId: match[2]! };
}
