import { spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

const conversationId = z.string().regex(/^[0-9a-f]{32}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/);
const localRequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(128);
const applicationId = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const positive = z.number().int().positive().safe();
const text = z.string().refine(value => {
  const length = Array.from(value).length;
  return value.trim().length > 0 && length <= 2000 && Buffer.byteLength(value, "utf8") <= 16000
    && !/[\r\n]$/.test(value) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}, "Invalid wx-cli text");
const common = { conversation_id: conversationId };
const withDelivery = { ...common, delivery_id: positive };
const transportToken = z.string().min(1).max(512);
const schemas = {
  binding: z.strictObject(common),
  inbox_status: z.strictObject(common),
  inbox_claim: z.strictObject({ ...common, lease_seconds: z.number().int().min(30).max(3600).optional() }),
  transport_status: z.strictObject(common),
  reserve_turn: z.strictObject({ ...withDelivery, token: transportToken }),
  record_turn: z.strictObject({ ...withDelivery, token: transportToken, turn_id: identifier }),
  finish_turn: z.strictObject({ ...withDelivery, token: transportToken, status: z.enum(["completed", "interrupted", "failed"]) }),
  inbox_show: z.strictObject(withDelivery),
  events: z.strictObject({ ...withDelivery, after: z.number().int().min(0).safe().optional(), limit: z.number().int().min(1).max(100).optional() }),
  complete: z.strictObject({ ...withDelivery, token: identifier, decision: z.enum(["skip", "defer", "draft", "reply"]),
    request_id: localRequestId.optional(), text: z.string().min(1).optional(), reason: z.string().trim().min(1).max(512).optional(),
    condition: z.string().trim().min(1).max(512).optional(), due_at: z.number().int().min(0).safe().optional() }).superRefine((value, context) => {
      if ((value.decision === "reply") !== (value.request_id !== undefined)
          || (value.decision === "draft") !== (value.text !== undefined)) {
        context.addIssue({ code: "custom", message: "decision parameters do not match" });
      }
      if (value.decision === "draft" && (value.text?.trim().length === 0 || Buffer.byteLength(value.text ?? "", "utf8") > 65536)) {
        context.addIssue({ code: "custom", message: "invalid draft text" });
      }
    }),
  send_text: z.strictObject({ ...common, request_id: localRequestId, text }),
  result: z.strictObject({ ...common, request_id: localRequestId })
} as const;

export type GatewayMethod = keyof typeof schemas;
export type GatewayParams<M extends GatewayMethod> = z.input<(typeof schemas)[M]>;
export type GatewayOutcome =
  | { state: "ok"; method: GatewayMethod; businessRequestId: string | null; correlationId: string; result: Record<string, unknown> }
  | { state: "rejected"; method: GatewayMethod; businessRequestId: string | null; correlationId: string | null; code: string }
  | { state: "unknown"; method: GatewayMethod; businessRequestId: string | null; correlationId: string | null; reason: "timeout" | "process_error" | "response_unknown" };

const responseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
const response = z.discriminatedUnion("ok", [
  z.strictObject({ protocol_version: z.literal(1), id: responseId, ok: z.literal(true), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ protocol_version: z.literal(1), id: responseId.nullable(), ok: z.literal(false), error: z.strictObject({ code: z.string().regex(/^[a-z_]{1,40}$/) }) })
]);

const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isPositive = (value: unknown): value is number => isSafeInteger(value) && value > 0;
const isNonnegative = (value: unknown): value is number => isSafeInteger(value) && value >= 0;

// wx-agent transport_status projects only active reserved/recorded rows. Terminal
// turn states remain ledger evidence and are read through inbox_show, not this list.
const transportRow = z.strictObject({
  delivery_id: positive, conversation_id: conversationId, owner: identifier, epoch: positive,
  status: z.enum(["pending", "claimed", "replied", "skipped", "deferred", "draft"]),
  turn_state: z.enum(["reserved", "recorded"]), session_ref: identifier,
  thread_id: identifier.nullable(), turn_id: identifier.nullable(), transport_token: transportToken
}).superRefine((row, context) => {
  if (row.turn_state === "recorded" ? row.thread_id === null || row.turn_id === null
    : row.thread_id !== null || row.turn_id !== null) {
    context.addIssue({ code: "custom", message: "inconsistent turn identity" });
  }
});
const transportStatus = z.strictObject({ conversation_id: conversationId, deliveries: z.array(transportRow).max(16) });
const bindingView = z.object({
  conversation_id:conversationId,owner:identifier,epoch:positive,
  control:z.enum(["active","paused"]),owner_session_ref:identifier,thread_id:identifier,
}).passthrough();
const deliveryStatusRow = z.object({
  delivery_id:positive,owner:identifier,epoch:positive,
  cursor_start:z.number().int().nonnegative().safe(),
  cursor_end:z.number().int().nonnegative().safe(),
  status:z.enum(["pending","claimed","replied","skipped","deferred","draft"]),
  session_ref:identifier.optional(),
}).passthrough().refine(row=>row.cursor_end>=row.cursor_start,"Invalid delivery cursor range");
const inboxStatusView = z.object({conversation_id:conversationId,
  deliveries:z.array(deliveryStatusRow).max(16)}).passthrough();
const inboxShowView = z.object({
  conversation_id:conversationId,delivery_id:positive,owner:identifier,epoch:positive,
  status:z.literal("claimed"),session_ref:identifier,
  cursor_start:z.number().int().nonnegative().safe(),
  cursor_end:z.number().int().nonnegative().safe(),
}).passthrough().refine(row=>row.cursor_end>=row.cursor_start,"Invalid delivery cursor range");
const completeReceipt = z.object({
  delivery_id:positive,status:z.enum(["replied","skipped","deferred","draft"]),
}).passthrough();
const reserveReceipt = z.strictObject({ delivery_id: positive,
  turn_state: z.enum(["reserved", "recorded", "completed", "interrupted", "failed"]),
  session_ref: identifier, already_reserved: z.boolean() });
const recordReceipt = z.strictObject({ delivery_id: positive, turn_state: z.literal("recorded"),
  thread_id: identifier, turn_id: identifier });
const finishReceipt = z.strictObject({ delivery_id: positive,
  turn_state: z.enum(["completed", "interrupted", "failed"]) });

function validTransportResult(method: GatewayMethod, params: Record<string, unknown>, result: Record<string, unknown>): boolean {
  if (method === "transport_status") {
    const parsed = transportStatus.safeParse(result);
    if (!parsed.success || parsed.data.conversation_id !== params.conversation_id) return false;
    const seen = new Set<number>();
    for (const row of parsed.data.deliveries) {
      if (row.conversation_id !== params.conversation_id || seen.has(row.delivery_id)) return false;
      seen.add(row.delivery_id);
    }
    return true;
  }
  if (method === "reserve_turn") {
    const parsed = reserveReceipt.safeParse(result);
    return parsed.success && parsed.data.delivery_id === params.delivery_id
      && (parsed.data.already_reserved || parsed.data.turn_state === "reserved");
  }
  if (method === "record_turn") {
    const parsed = recordReceipt.safeParse(result);
    return parsed.success && parsed.data.delivery_id === params.delivery_id && parsed.data.turn_id === params.turn_id;
  }
  if (method === "finish_turn") {
    const parsed = finishReceipt.safeParse(result);
    return parsed.success && parsed.data.delivery_id === params.delivery_id && parsed.data.turn_state === params.status;
  }
  return true;
}

/** A successful envelope is not enough to consume a lease or an event page. */
function validInboxResult(method: GatewayMethod, params: Record<string, unknown>, result: Record<string, unknown>): boolean {
  if (method === "binding") {
    const parsed=bindingView.safeParse(result);
    return parsed.success&&parsed.data.conversation_id===params.conversation_id;
  }
  if (method === "inbox_status") {
    const parsed=inboxStatusView.safeParse(result);
    return parsed.success&&parsed.data.conversation_id===params.conversation_id;
  }
  if (method === "inbox_show") {
    const parsed=inboxShowView.safeParse(result);
    return parsed.success&&parsed.data.conversation_id===params.conversation_id&&
      parsed.data.delivery_id===params.delivery_id;
  }
  if (method === "inbox_claim") {
    if (result.status === "empty") return result.conversation_id === undefined
      || result.conversation_id === params.conversation_id;
    if (result.conversation_id !== params.conversation_id) return false;
    return result.status === "claimed" && isPositive(result.delivery_id)
      && typeof result.owner === "string" && result.owner.length > 0
      && isPositive(result.epoch) && typeof result.token === "string" && result.token.length > 0
      && isPositive(result.cursor_start) && isSafeInteger(result.cursor_end)
      && result.cursor_end >= result.cursor_start;
  }
  if (method === "events") {
    if (result.conversation_id !== params.conversation_id || result.delivery_id !== params.delivery_id
        || !Array.isArray(result.events) || !isNonnegative(result.next_cursor)
        || typeof result.has_more !== "boolean") return false;
    let previous = params.after;
    for (const row of result.events) {
      if (typeof row !== "object" || row === null || Array.isArray(row)
          || !isPositive((row as Record<string, unknown>).cursor)
          || (previous !== undefined && (row as Record<string, unknown>).cursor !== (previous as number) + 1)
          || ((row as Record<string, unknown>).conversation_id !== undefined
            && (row as Record<string, unknown>).conversation_id !== params.conversation_id)) return false;
      previous = (row as Record<string, unknown>).cursor;
    }
    if(result.events.length===0&&result.has_more)return false;
    return previous === undefined || result.next_cursor === previous;
  }
  if(method==="complete"){
    const parsed=completeReceipt.safeParse(result);
    const expected = params.decision === "skip" ? "skipped"
      : params.decision === "defer" ? "deferred" : params.decision;
    return parsed.success&&parsed.data.delivery_id===params.delivery_id&&
      parsed.data.status===expected;
  }
  return true;
}

/** Only errors proven to occur before a write are definite refusals. */
const definiteRefusals = new Set([
  "auth_failed", "permission_denied", "method_denied", "conversation_out_of_scope",
  "invalid_request", "invalid_params", "invalid_config", "request_too_large",
  "binding_changed", "delivery_out_of_scope", "invalid_request_id", "already_namespaced",
  "invalid_text", "owner_epoch_drift", "request_scope_drift", "text_conflict"
]);

const MAX_INPUT = 128 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const METHODS = Object.keys(schemas) as GatewayMethod[];
/** Do not pass coordinator bearer tokens or Node injection flags to the gateway client. */
const CHILD_ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM"] as const;
const childEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
};

export interface GatewayClientConfig {
  /** Absolute, trusted wx-agent-gateway-client executable (or a trusted fixture). */
  executable: string;
  /** Absolute path to the private client config; never logged or returned. */
  configPath: string;
  /** Host policy. A method omitted here cannot start a process. */
  allowedMethods: readonly GatewayMethod[];
  timeoutMs?: number;
}

export class GatewayInputError extends Error {
  constructor() { super("Invalid wx-cli client configuration or method parameters"); this.name = "GatewayInputError"; }
}

const absolute = (value: string): boolean => isAbsolute(value) && normalize(value) === value;

/** One process per call. Never invokes a shell or retries an uncertain write. */
export class WechatGatewayClient {
  private readonly executable: string;
  private readonly configPath: string;
  private readonly allowed: ReadonlySet<GatewayMethod>;
  private readonly timeoutMs: number;

  constructor(config: GatewayClientConfig) {
    if (!absolute(config.executable) || !absolute(config.configPath)
        || !Array.isArray(config.allowedMethods) || config.allowedMethods.length === 0
        || config.allowedMethods.some(method => !METHODS.includes(method))
        || !Number.isSafeInteger(config.timeoutMs ?? 35_000) || (config.timeoutMs ?? 35_000) <= 0) throw new GatewayInputError();
    this.executable = config.executable;
    this.configPath = config.configPath;
    this.allowed = new Set(config.allowedMethods);
    this.timeoutMs = config.timeoutMs ?? 35_000;
  }

  async call<M extends GatewayMethod>(method: M, params: GatewayParams<M>): Promise<GatewayOutcome> {
    if (!this.allowed.has(method)) throw new GatewayInputError();
    const parsed = schemas[method].safeParse(params);
    if (!parsed.success) throw new GatewayInputError();
    const input = JSON.stringify(parsed.data);
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT) throw new GatewayInputError();
    const businessRequestId = "request_id" in parsed.data && typeof parsed.data.request_id === "string" ? parsed.data.request_id : null;
    const unknown = (reason: "timeout" | "process_error" | "response_unknown"): GatewayOutcome =>
      ({ state: "unknown", method, businessRequestId, correlationId: null, reason });

    return new Promise<GatewayOutcome>(resolve => {
      let settled = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      const child = spawn(this.executable, ["--config", this.configPath, method, "--params-stdin"], {
        shell: false, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
        env: childEnvironment()
      });
      const finish = (outcome: GatewayOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(unknown("timeout")); }, this.timeoutMs);
      child.on("error", () => finish(unknown("process_error")));
      child.stdin.on("error", () => finish(unknown("process_error")));
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) { child.kill("SIGKILL"); finish(unknown("response_unknown")); return; }
        chunks.push(chunk);
      });
      child.on("close", code => {
        if (settled) return;
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { finish(unknown("response_unknown")); return; }
        const envelope = response.safeParse(value);
        if (!envelope.success) { finish(unknown("response_unknown")); return; }
        const item = envelope.data;
        if (item.ok) {
          if (code !== 0) { finish(unknown("response_unknown")); return; }
          // Do not accept a successful envelope for a different conversation, delivery, or outbox key.
          if (item.result.conversation_id !== undefined && item.result.conversation_id !== parsed.data.conversation_id
              || "delivery_id" in parsed.data && item.result.delivery_id !== undefined && item.result.delivery_id !== parsed.data.delivery_id
              || !validInboxResult(method, parsed.data, item.result)
              || !validTransportResult(method, parsed.data, item.result)
              || (method === "send_text" || method === "result")
                && (item.result.conversation_id !== parsed.data.conversation_id
                    || typeof item.result.application_id !== "string"
                    || !applicationId.test(item.result.application_id)
                    || item.result.request_id !== `${item.result.application_id}.${businessRequestId}`)) {
            finish(unknown("response_unknown")); return;
          }
          finish({ state: "ok", method, businessRequestId, correlationId: item.id, result: item.result });
        } else if (!definiteRefusals.has(item.error.code)) {
          finish({ state: "unknown", method, businessRequestId, correlationId: item.id, reason: "response_unknown" });
        } else {
          finish({ state: "rejected", method, businessRequestId, correlationId: item.id, code: item.error.code });
        }
      });
      child.stdin.end(input);
    });
  }
}
