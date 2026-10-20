import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { commandSchema, idSchema } from "@evoloop/contracts";
import { ApiClient, CliApiError } from "./client.js";
import { exportOriginal, readOriginal, readTaskContext, MaterialError } from "./materials.js";
import { ReceiptError, ReceiptStore, dispatchMutation, reconcileReceipt, record, type VerifiedActor } from "./receipts.js";
import { prepareRequest, requestTypes, requestSchema, RequestInputError } from "./requests.js";

type Environment = Record<string, string | undefined>;
interface IO { stdout(text: string): void; stderr(text: string): void }
class UsageError extends Error { readonly code = "INVALID_INPUT"; }
interface Args { words: string[]; options: Map<string, string | true> }
const values = new Set(["project", "revision", "limit", "cursor", "out", "file", "id", "receipt"]);
const switches = ["help", "history", "graph", "events", "revisions", "result", "occurrences", "reviews", "handoffs", "bindings"];
function uuid(value: string | undefined, label: string): string {
  if (!idSchema.safeParse(value).success) throw new UsageError(`${label} must be a UUID.`);
  return value!;
}
function parse(args: string[]): Args {
  const words: string[] = [], options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    if (!argument.startsWith("--")) { if (argument.startsWith("-")) throw new UsageError(`Unknown option ${argument}.`); words.push(argument); continue; }
    const key = argument.slice(2);
    if (options.has(key)) throw new UsageError(`Duplicate --${key}.`);
    if (switches.includes(key)) options.set(key, true);
    else if (values.has(key)) {
      const next = args[++i];
      if (!next || next.startsWith("--")) throw new UsageError(`--${key} requires a value.`);
      options.set(key, next);
    } else throw new UsageError(`Unknown option --${key}.`);
  }
  return { words, options };
}
function option(args: Args, key: string): string | undefined { const value = args.options.get(key); return typeof value === "string" ? value : undefined; }
function check(args: Args, count: number, allowed: string[] = []): void {
  if (args.words.length !== count) throw new UsageError("Unexpected or missing arguments; use help.");
  for (const key of args.options.keys()) if (!allowed.includes(key)) throw new UsageError(`--${key} does not apply to this command.`);
}
function mode(args: Args, names: string[]): string | undefined {
  const selected = names.filter(key => args.options.has(key));
  if (selected.length > 1) throw new UsageError(`Choose one of ${names.map(key => `--${key}`).join(", ")}.`);
  return selected[0];
}
const readModes = ["events", "history", "revisions", "result", "occurrences", "reviews", "handoffs", "bindings"];
const listPaths: Record<string, string> = { tasks: "tasks", documents: "documents", goals: "goals", stages: "stages", discussions: "discussions", roles: "roles",
  schedules: "schedules", knowledge: "knowledge/pages", candidates: "knowledge/candidates", runs: "runtime/runs", sessions: "runtime/sessions", impacts: "impacts" };
const reads: Record<string, { path: string; modes: string[]; list?: boolean }> = {
  goal: { path: "goals", modes: ["revisions"] }, stage: { path: "stages", modes: ["revisions", "reviews"] },
  discussion: { path: "discussions", modes: ["events"] }, role: { path: "roles", modes: ["revisions", "reviews", "handoffs", "bindings"], list: true },
  schedule: { path: "schedules", modes: ["revisions", "occurrences"], list: true }, run: { path: "runtime/runs", modes: ["events", "result"], list: true },
  session: { path: "runtime/sessions", modes: ["events", "history"], list: true }, git: { path: "references/git", modes: [] }, references: { path: "references/tasks", modes: [] },
};
const help = {
  name: "evoLoop Agent CLI", output: "JSON stdout, diagnostic JSON stderr; no automatic POST retries",
  commands: ["id", "session", "project UUID", `list ${Object.keys(listPaths).join("|")} --project UUID [--limit 1..100] [--cursor CURSOR]`,
    "task UUID --project UUID [--revision UUID | --history]", "context TASK_UUID --project UUID [--revision UUID]",
    "document UUID --project UUID [--revision UUID]", "original DOCUMENT_UUID --project UUID --revision UUID [--out NEW_DIRECTORY]",
    "knowledge UUID --project UUID [--revision UUID | --history | --graph]", "candidate UUID --project UUID", "operation UUID --project UUID",
    `read ${Object.keys(reads).join("|")} UUID --project UUID [${readModes.map(name => `--${name}`).join(" | ")}]`,
    "command types", "command schema TYPE", "command run JSON_FILE", "command JSON_FILE (legacy)", "request types", "request schema NAME",
    "request NAME --project UUID --file JSON_FILE [--id UUID] [--receipt UUID for endpoints without server operation IDs]",
    "receipts list", "receipts show UUID", "receipts reconcile UUID", "get /api/... (legacy read-only)"],
  readModes: reads,
  environment: { EVOLOOP_API_URL: "coordinator HTTP(S) origin, default http://127.0.0.1:4318", EVOLOOP_TOKEN: "private bearer credential",
    EVOLOOP_PROJECT: "optional default project UUID", EVOLOOP_STATE_DIR: "private local receipt directory", EVOLOOP_TIMEOUT_MS: "request+body deadline, default 15000; max 300000" },
  exitCodes: { "0": "confirmed response", "1": "service rejection or unavailable read", "2": "invalid local input", "3": "mutation result unknown; reconcile original receipt", "4": "partial fixed context" },
  invariants: ["Missing operations do not prove noncommit", "Fixed originals are not replaced by summaries/newer revisions", "CLI and human workbench share service authorization and business rules",
    "Run completion, delivery, actual use and Task closure are distinct"],
};

async function dispatch(args: Args, env: Environment, io: IO): Promise<unknown> {
  const action = args.words[0];
  if (!action || action === "help" || args.options.has("help")) return help;
  if (action === "id") { check(args, 1); return { id: randomUUID() }; }
  const project = () => uuid(option(args, "project") ?? env.EVOLOOP_PROJECT, "Project");
  const revision = () => option(args, "revision") ? uuid(option(args, "revision"), "Revision") : undefined;
  const store = new ReceiptStore(env.EVOLOOP_STATE_DIR);
  if (action === "command" && args.words[1] === "types") { check(args, 2); return { types: commandSchema.options.map(schema => schema.shape.type.value) }; }
  if (action === "command" && args.words[1] === "schema") {
    check(args, 3);
    const schema = commandSchema.options.find(schema => schema.shape.type.value === args.words[2]);
    if (!schema) throw new UsageError("Unknown command type; use command types.");
    return schema.toJSONSchema();
  }
  if (action === "request" && args.words[1] === "types") { check(args, 2); return { requests: requestTypes() }; }
  if (action === "request" && args.words[1] === "schema") { check(args, 3); return requestSchema(args.words[2]!); }
  if (action === "receipts" && args.words[1] !== "reconcile") {
    if (args.words[1] === "list") { check(args, 2); return { items: await store.list() }; }
    if (args.words[1] === "show") { check(args, 3); return store.get(uuid(args.words[2], "Receipt")); }
    throw new UsageError("Use receipts list, show UUID, or reconcile UUID.");
  }
  if (!env.EVOLOOP_TOKEN) throw new UsageError("Set EVOLOOP_TOKEN using a private environment; do not pass it as a command argument.");
  const timeoutMs = Number(env.EVOLOOP_TIMEOUT_MS ?? 15000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new UsageError("EVOLOOP_TIMEOUT_MS must be 1..300000.");
  const apiUrl = env.EVOLOOP_API_URL || "http://127.0.0.1:4318", token = env.EVOLOOP_TOKEN;
  let client: ApiClient;
  try { client = new ApiClient({ apiUrl, token, timeoutMs }); }
  catch { throw new UsageError("EVOLOOP_API_URL must be an HTTP(S) origin without credentials, path, query or fragment."); }
  const origin = new URL(apiUrl).origin;
  const verifiedActor = async (): Promise<VerifiedActor> => {
    const session = record(await client.get("/api/session")), principal = record(session?.principal);
    if (!principal || typeof principal.actorId !== "string" || !Array.isArray(principal.projectIds) || principal.projectIds.some(value => typeof value !== "string"))
      throw new ReceiptError("INVALID_SESSION", "Cannot bind intent to a server-verified identity.");
    return { actorId: principal.actorId, projectIds: principal.projectIds as string[] };
  };
  if (action === "session") { check(args, 1); return client.get("/api/session"); }
  if (action === "project") { check(args, 2); return client.get(`/api/projects/${uuid(args.words[1], "Project")}`); }
  if (action === "get") { check(args, 2); return client.get(args.words[1]!); }
  if (action === "command") {
    const file = args.words[1] === "run" ? args.words[2] : args.words[1];
    check(args, args.words[1] === "run" ? 3 : 2);
    if (!file) throw new UsageError("command run requires a JSON file.");
    const command = commandSchema.parse(JSON.parse(await readFile(file, "utf8")));
    return dispatchMutation(client, store, origin, token, { id: command.operationId, operationId: command.operationId,
      projectId: command.projectId, kind: command.type, path: "/api/commands", body: command, confirmation: "command",
      recovery: { kind: "core", path: `/api/projects/${command.projectId}/operations/${command.operationId}` } }, value => io.stderr(JSON.stringify(value) + "\n"), await verifiedActor());
  }
  if (action === "request") {
    check(args, 2, ["project", "file", "id", "receipt"]);
    const file = option(args, "file"); if (!file) throw new UsageError("request requires --file JSON_FILE; see request types.");
    const intent = prepareRequest(args.words[1]!, project(), JSON.parse(await readFile(file, "utf8")), option(args, "id"), option(args, "receipt"));
    return dispatchMutation(client, store, origin, token, intent, value => io.stderr(JSON.stringify(value) + "\n"), await verifiedActor());
  }
  if (action === "receipts") {
    check(args, 3);
    if (args.words[1] !== "reconcile") throw new UsageError("Use receipts reconcile UUID.");
    const result = await reconcileReceipt(client, store, origin, token, uuid(args.words[2], "Receipt"), await verifiedActor());
    if (result.state === "rejected") throw new ReceiptError("OPERATION_REJECTED", "The saved intent was rejected.", result.result ?? result.lastError);
    return result;
  }
  const projectId = project(), prefix = `/api/projects/${projectId}`;
  if (action === "list") {
    check(args, 2, ["project", "limit", "cursor"]);
    const entity = args.words[1]!, suffix = listPaths[entity]; if (!suffix) throw new UsageError("Unknown list; use help.");
    const query = new URLSearchParams();
    if (args.options.has("limit") || args.options.has("cursor")) {
      if (!["tasks", "documents", "goals", "discussions", "roles", "knowledge", "candidates"].includes(entity)) throw new UsageError("This endpoint is not paginated; omit --limit/--cursor.");
      const limit = Number(option(args, "limit") ?? 50); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new UsageError("--limit must be 1..100.");
      query.set("limit", String(limit)); const cursor = option(args, "cursor");
      if (cursor) query.set("cursor", ["knowledge", "candidates"].includes(entity) ? cursor : uuid(cursor, "Cursor"));
    }
    return client.get(`${prefix}/${suffix}${query.size ? `?${query}` : ""}`);
  }
  if (action === "task" || action === "document") {
    check(args, 2, action === "task" ? ["project", "revision", "history"] : ["project", "revision"]);
    mode(args, ["revision", "history"]); const rev = revision();
    return client.get(`${prefix}/${action}s/${uuid(args.words[1], action)}${rev ? `/revisions/${rev}` : args.options.has("history") ? "/revisions" : ""}`);
  }
  if (action === "context") { check(args, 2, ["project", "revision"]); return readTaskContext(client, projectId, uuid(args.words[1], "Task"), revision()); }
  if (action === "original") {
    check(args, 2, ["project", "revision", "out"]);
    const original = await readOriginal(client, projectId, uuid(args.words[1], "Document"), uuid(option(args, "revision"), "Fixed document revision"));
    const destination = option(args, "out");
    return destination ? { status: "exported", directory: await exportOriginal(original, destination), revision: original.revision } : original;
  }
  if (action === "knowledge") {
    check(args, 2, ["project", "revision", "history", "graph"]); const selected = mode(args, ["revision", "history", "graph"]);
    const suffix = selected === "revision" ? `?revision=${revision()}` : selected ? `/${selected}` : "";
    return client.get(`${prefix}/knowledge/pages/${uuid(args.words[1], "Knowledge")}${suffix}`);
  }
  if (action === "candidate" || action === "operation") { check(args, 2, ["project"]); return client.get(`${prefix}/${action === "candidate" ? "knowledge/candidates" : "operations"}/${uuid(args.words[1], action)}`); }
  if (action === "read") {
    check(args, 3, ["project", ...readModes]); const kind = args.words[1]!, objectId = uuid(args.words[2], "Object"), selected = mode(args, readModes);
    const definition = reads[kind]; if (!definition || selected && !definition.modes.includes(selected)) throw new UsageError("Unsupported object or read mode; use help.");
    if (definition.list && !selected) {
      const result = await client.get(`${prefix}/${definition.path}`), entries = Array.isArray(result) ? result : record(result)?.items;
      const found = Array.isArray(entries) ? entries.find(value => record(value)?.id === objectId) : undefined;
      if (!found) throw new ReceiptError("OBJECT_NOT_FOUND", "Object was absent from this bounded authorized list; global absence is not proven.");
      return found;
    }
    return client.get(`${prefix}/${definition.path}/${objectId}${selected ? `/${selected}` : ""}`);
  }
  throw new UsageError("Unknown command; use help.");
}

export async function runCli(args: string[], env: Environment = process.env, io: IO = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }): Promise<number> {
  try { const result = await dispatch(parse(args), env, io); io.stdout(JSON.stringify(result) + "\n"); return record(result)?.status === "partial" ? 4 : 0; }
  catch (error) {
    const invalid = error instanceof UsageError || error instanceof RequestInputError || record(error)?.name === "ZodError" || error instanceof SyntaxError || error instanceof TypeError ||
      error instanceof CliApiError && error.status === 0 && !error.unconfirmed && error.code.startsWith("INVALID_");
    const code = invalid ? "INVALID_INPUT" : error instanceof CliApiError || error instanceof ReceiptError || error instanceof MaterialError ? error.code : "LOCAL_IO_ERROR";
    const payload = error instanceof CliApiError ? { code, status: error.status, message: error.message, data: error.data }
      : error instanceof ReceiptError ? { code, message: error.message, data: error.data }
      : error instanceof MaterialError ? { code, message: error.message }
      : { code, message: invalid ? error instanceof UsageError || error instanceof RequestInputError ? error.message : "Input does not match CLI/schema; use help or command schema TYPE."
        : record(error)?.code === "ENOENT" ? "The input file or export parent directory is missing; preserve the requested path and create the parent before exporting."
        : "Local operation failed; preserve input and inspect the requested file/state path." };
    io.stderr(JSON.stringify({ error: payload }) + "\n");
    return invalid ? 2 : code === "RESULT_UNCONFIRMED" ? 3 : 1;
  }
}
