import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { commandSchema, idSchema } from "@evoloop/contracts";
import { orchestrationCommandSchema } from "@evoloop/contracts/orchestration";
import { ApiClient, CliApiError } from "./client.js";
import { exportOriginal, readOriginal, readTaskContext, MaterialError } from "./materials.js";
import { ReceiptError, ReceiptStore, dispatchMutation, reconcileReceipt, retryReceipt, record, type VerifiedActor } from "./receipts.js";
import { prepareRequest, requestTypes, requestSchema, RequestInputError } from "./requests.js";
import { sessionWorkPath } from "./session-work.js";
import { briefAcceptanceOverview, briefIndex, briefRelays, briefTaskWithRelays } from "./brief.js";
import { sessionStatus } from "./session-status.js";
import { allocationRelationsPath } from "./allocation-relations.js";
import { fixedHash, materialAsset, materialBody, materialCatalog, materialHandoff, materialRunInput } from "./lightweight-materials.js";
import { prepareSession } from "./session-preparation.js";

type Environment = Record<string, string | undefined>;
interface IO { stdout(text: string): void; stderr(text: string): void }
class UsageError extends Error { readonly code = "INVALID_INPUT"; }
interface Args { words: string[]; options: Map<string, string | true> }
const values = new Set(["project", "revision", "limit", "cursor", "turn-cursor", "messages-cursor", "source", "turn-id", "after", "wait-ms", "out", "file", "id", "receipt", "attempt", "task", "state", "phase", "signal", "waiting-on-kind", "waiting-on-id", "stage", "knowledge", "loop", "search", "membership", "importance", "role", "session", "discussion", "message", "kind", "hash", "asset-hash", "model", "effort", "color", "mark", "reason", "evidence-ref", "operation", "provider", "project-skills", "personal", "builtin", "add", "remove"]);
const switches = ["help", "history", "graph", "events", "revisions", "result", "trace", "occurrences", "reviews", "handoffs", "bindings", "route", "hosts", "attempts", "recovery", "inputs", "observation", "documents", "closed", "brief"];
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
const readModes = ["events", "history", "revisions", "result", "trace", "occurrences", "reviews", "handoffs", "bindings", "route", "hosts", "attempts", "recovery", "inputs", "observation"];
const listPaths: Record<string, string> = { tasks: "tasks", documents: "documents", goals: "goals", stages: "stages", discussions: "discussions", roles: "roles", domains: "domains", "role-templates": "role-templates",
  schedules: "schedules", "resident-queues": "resident-queues", evaluations: "evaluations", knowledge: "knowledge/pages", candidates: "knowledge/candidates", runs: "runtime/runs", sessions: "runtime/sessions", impacts: "impacts" };
const orchestrationLists: Record<string, string> = { loops: "loops", inbox: "inbox", dispatches: "dispatches" };
const reads: Record<string, { path: string; modes: string[]; list?: boolean }> = {
  goal: { path: "goals", modes: ["revisions"] }, stage: { path: "stages", modes: ["revisions", "reviews"] },
  discussion: { path: "discussions", modes: ["events"] }, role: { path: "roles", modes: ["revisions", "reviews", "handoffs", "bindings", "hosts"], list: true },
  "resident-queue": { path: "resident-queues", modes: ["attempts"] },
  domain: { path: "domains", modes: ["revisions", "route"] }, host: { path: "hosts", modes: ["revisions"] },
  schedule: { path: "schedules", modes: ["revisions", "occurrences"], list: true }, run: { path: "runtime/runs", modes: ["events", "result", "trace"] },
  session: { path: "runtime/sessions", modes: ["events", "history", "recovery", "inputs", "observation"], list: true },
  "native-input": { path: "session-inputs", modes: [] }, git: { path: "references/git", modes: [] }, references: { path: "references/tasks", modes: [] },
};
const orchestrationReads: Record<string, { path: string; modes: string[] }> = {
  loop: { path: "loops", modes: ["events"] }, inbox: { path: "inbox", modes: [] },
  dispatch: { path: "dispatches", modes: [] }, submission: { path: "submissions", modes: [] },
  policy: { path: "policies", modes: [] }, binding: { path: "bindings", modes: [] },
  study: { path: "study-declarations", modes: [] },
};
const allCommandSchemas = [...commandSchema.options, ...orchestrationCommandSchema.options];
const help = {
  name: "evoLoop Agent CLI", output: "JSON stdout, diagnostic JSON stderr; no automatic POST retries",
  commands: ["id", "session", "project UUID", `list ${[...Object.keys(listPaths), ...Object.keys(orchestrationLists)].join("|")} --project UUID [--loop UUID for inbox/dispatches] [--limit 1..100] [--cursor CURSOR]`,
    "list discussions --project UUID [--kind allocation|direction|task_collaboration] [--limit 1..100 --cursor UUID] (read only)",
    "allocations --project UUID (--role UUID | --session owned:UUID|external:UUID | --discussion UUID) [--limit 1..50 --cursor OPAQUE] (read only; does not assign a Task or Session)",
    "work list --project UUID [--limit 1..50 --cursor CURSOR --search TEXT --membership current|historical|unclassified|all]",
    "work snapshot|history|messages OWNED_OR_EXTERNAL_KEY --project UUID [--limit 1..50 --cursor CURSOR for history/messages]",
    "work status OWNED_OR_EXTERNAL_KEY --project UUID [--message UUID] (read only; separate PG, runtime connection, native Turn and message facts)",
    "work manual-stop-preview MESSAGE_UUID --project UUID (reviewer read of exact original native Turn and Items; no state change)",
    "work timeline KEY --project UUID [--source both|native|messages --limit 1..50 --cursor NATIVE_CURSOR --messages-cursor MESSAGES_CURSOR]",
    "work item KEY ITEM_ID --project UUID --turn-id TURN_ID (selected public message or authorized tool detail)",
    "work updates KEY --project UUID [--after LIVE_CURSOR] [--wait-ms 0..10000] (default 0; follow resetRequired)",
    "work changes [OWNED_OR_EXTERNAL_KEY] --project UUID --cursor CURSOR [--limit 1..100]",
    "work leader --project UUID [--documents] [--closed] [--brief] [--limit 1..100 --cursor CURSOR] (--brief: tasks view only; arranging fields per Task, about a tenth of the bytes)",
    "work task TASK_UUID --project UUID [--brief] (one Task's current stage, timing and responsibility; --brief adds its current acceptance arrangements and drops the timing history)",
    "work acceptance --project UUID [--brief] [--limit 1..100 --cursor CURSOR] (Leader stage and persisted Session capacity)",
    "work acceptance TASK_UUID --project UUID [--brief] (exact acceptance arrangements and dispatch outcomes; --brief drops the long prose)",
    "work acceptance mine --project UUID (human recipient's acceptance inbox)",
    "work acceptance read RELAY_UUID --project UUID --task TASK_UUID --file BODY.json (named human records reading an arrangement)",
    "work acceptance observe RELAY_UUID --project UUID --task TASK_UUID --file BODY.json (recipient links their existing observation)",
    "work retirement SESSION_UUID --project UUID (temporary Session blockers, decision and archive readback)",
    "request acceptance.assign --project UUID --id TASK_UUID --file BODY.json (persist one exact Delivery/recipient handoff)",
    "request session.retirement.approve --project UUID --id SESSION_UUID --file BODY.json (approve a temporary instance's exact close operation)",
    "work connectors --project UUID [--limit 1..50 --cursor UUID]; work connector BINDING_UUID --project UUID; work connector-deliveries BINDING_UUID --project UUID [--limit 1..50]; work connector-delivery BINDING_UUID DELIVERY_ID --project UUID; work connector-operation OPERATION_UUID --project UUID (saved route, deliveries and original write receipt)",
    "work attention --project UUID [--task TASK_UUID --state open|resolved --phase PHASE --signal SIGNAL --waiting-on-kind KIND --waiting-on-id ID --limit 1..100 --cursor CURSOR]",
    "work attention task TASK_UUID --project UUID (follow-up and Task attention history)",
    "work attention item ITEM_UUID --project UUID (one attention item and its events)",
    "work attention thresholds --project UUID [--stage STAGE_UUID --phase PHASE]",
    "work leader changes --project UUID [--cursor CURSOR --limit 1..100] (monotonic Task/Document change feed)",
    "work leader notices --project UUID [--task TASK_UUID --cursor CURSOR --limit 1..100] (durable result notices and dispatch status)",
    "request leader.notice.recover --project UUID --id BLOCKED_NOTICE_UUID --file BODY.json --receipt LOCAL_UUID (explicit new intent after confirmed post rejection; read original notice before any retry)",
    "session prepare --file PRIVATE_JSON (prepare or reuse one authorized owned Session; never assigns a Task)",
    "session profile show SESSION_UUID --project UUID (configured target, last confirmed profile and recovery state)",
    "session profile set SESSION_UUID --project UUID [--model SLUG] --effort LEVEL --reason TEXT --evidence-ref REF [--operation UUID] (save next-Turn target)",
    "session identity show owned:UUID|external:UUID --project UUID",
    "session identity set owned:UUID|external:UUID --project UUID --color TOKEN --mark TOKEN --reason TEXT [--operation UUID] (read current version, save and read back)",
    "models --project UUID (read authorized, currently available App Server models before session prepare)",
    "role runtime show ROLE_UUID --project UUID (bound runtime and the skills the Role has now, read live)",
    "role runtime set ROLE_UUID --project UUID [--provider codex|claude] [--project-skills on|off] [--personal on|off] [--builtin on|off] [--add NAMES|none] [--remove NAMES|none] --reason TEXT [--operation UUID] (binds the runtime once; afterwards only skills change; reads back)",
    "work message MESSAGE_UUID --project UUID; work profile KEY|assignment TASK_UUID --project UUID [--history --limit 1..50 --cursor VERSION]",
    "task UUID --project UUID [--revision UUID | --history]", "context TASK_UUID --project UUID [--revision UUID] (current todo includes observed planning pointers; use original for exact source bytes)",
    "materials TASK_UUID --project UUID --revision UUID (bounded fixed Task and sealed basis catalog)",
    "handoff RUN_UUID --project UUID --hash SHA256 (verified v2 goal, full acceptance, changes and fixed material catalog)",
    "run-input RUN_UUID --project UUID --hash SHA256 [--cursor BYTE --limit 1..8192 | --out NEW_FILE] (exact reserved Run instruction, including queue answers)",
    "body DOCUMENT_UUID --project UUID --revision UUID --hash SHA256 [--cursor BYTE --limit 1..8192] (fixed UTF-8 page)",
    "asset DOCUMENT_UUID --project UUID --revision UUID --hash DOCUMENT_SHA256 --id BLOB_UUID --asset-hash SHA256 [--out NEW_FILE] (one fixed resource)",
    "document UUID --project UUID [--revision UUID]", "original DOCUMENT_UUID --project UUID --revision UUID [--out NEW_DIRECTORY]",
    "evaluation UUID --project UUID [--revision UUID]", "evaluation-source TASK_UUID --project UUID",
    "evaluation-packet EVALUATION_UUID --project UUID --revision UUID --attempt UUID",
    "knowledge UUID --project UUID [--revision UUID | --history | --graph]", "candidate UUID --project UUID", "operation UUID --project UUID",
    `read ${[...Object.keys(reads), ...Object.keys(orchestrationReads)].join("|")} UUID --project UUID [${readModes.map(name => `--${name}`).join(" | ")}] [--cursor ITEM_CURSOR --turn-cursor TURN_CURSOR for run --trace]`,
    "command types", "command schema TYPE", "command run JSON_FILE", "command JSON_FILE (legacy)", "request types", "request schema NAME",
    "request schema reference.task-decide (reviewed Run: kind=run, referenceId=Run ID, revision=source TaskRevision ID, contentHash=Run inputHash; read run ID --trace for native evidence)",
    "request NAME --project UUID --file JSON_FILE [--id UUID] [--receipt UUID for endpoints without server operation IDs]",
    "receipts list", "receipts show UUID", "receipts reconcile UUID", "receipts retry UUID (explicit same-ID transactional command replay after readback; never seal/external dispatch)", "get /api/... (legacy read-only)"],
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
  if (action === "command" && args.words[1] === "types") { check(args, 2); return { types: allCommandSchemas.map(schema => schema.shape.type.value) }; }
  if (action === "command" && args.words[1] === "schema") {
    check(args, 3);
    const schema = allCommandSchemas.find(schema => schema.shape.type.value === args.words[2]);
    if (!schema) throw new UsageError("Unknown command type; use command types.");
    return schema.toJSONSchema();
  }
  if (action === "request" && args.words[1] === "types") { check(args, 2); return { requests: requestTypes() }; }
  if (action === "request" && args.words[1] === "schema") { check(args, 3); return requestSchema(args.words[2]!); }
  if (action === "receipts" && !["reconcile", "retry"].includes(args.words[1] ?? "")) {
    if (args.words[1] === "list") { check(args, 2); return { items: await store.list() }; }
    if (args.words[1] === "show") { check(args, 3); return store.get(uuid(args.words[2], "Receipt")); }
    throw new UsageError("Use receipts list, show UUID, reconcile UUID, or retry UUID.");
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
  if(action==="session"&&args.words[1]==="prepare"){
    check(args,2,["file"]);
    const file=option(args,"file");if(!file)throw new UsageError("session prepare requires --file PRIVATE_JSON");
    return prepareSession(JSON.parse(await readFile(file,"utf8")),client,store,origin,token,
      await verifiedActor(),value=>io.stderr(JSON.stringify(value)+"\n"));
  }
  if(action==="session"&&args.words[1]==="profile"){
    const mode=args.words[2],sessionId=uuid(args.words[3],"Session"),projectId=project();
    if(mode==='show'){
      check(args,4,["project"]);
      const sessions=await client.get(`/api/projects/${projectId}/runtime/sessions`);
      const current=Array.isArray(sessions)?sessions.find(value=>record(value)?.id===sessionId):null;
      if(!current)throw new UsageError('Managed Session is unavailable in this project.');
      const recovery=await client.get(`/api/projects/${projectId}/runtime/sessions/${sessionId}/recovery`);
      return {session:current,recovery};
    }
    if(mode==='set'){
      check(args,4,["project","model","effort","reason","evidence-ref","operation"]);
      const reasoningEffort=option(args,"effort"),reason=option(args,"reason"),evidenceRef=option(args,"evidence-ref");
      if(!reasoningEffort||!reason||!evidenceRef)
        throw new UsageError('profile set requires --effort, --reason and --evidence-ref (--model defaults to the Session\'s current model).');
      const sessions=await client.get(`/api/projects/${projectId}/runtime/sessions`);
      const current=Array.isArray(sessions)?record(sessions.find(value=>record(value)?.id===sessionId)):null;
      const profile=record(current?.executionProfile);
      const revision=record(profile?.revision);
      if(!current||!revision||typeof current.version!=='number'||typeof revision.revisionId!=='string')
        throw new UsageError('Current managed Session profile is unavailable; use session profile show.');
      const model=option(args,"model")??(typeof revision.model==='string'?revision.model:undefined);
      if(!model)throw new UsageError('The Session has no recorded model; pass --model.');
      const operationId=option(args,"operation")?uuid(option(args,"operation"),"Operation"):randomUUID();
      const command=commandSchema.parse({type:'runtime.session.executionProfile.revise',projectId,sessionId,
        operationId,expectedVersion:current.version,expectedExecutionProfileRevisionId:revision.revisionId,
        model,reasoningEffort,reason,evidenceRef});
      return dispatchMutation(client,store,origin,token,{id:operationId,operationId,projectId,
        kind:command.type,path:'/api/commands',body:command,confirmation:'command',
        recovery:{kind:'core',path:`/api/projects/${projectId}/operations/${operationId}`}},
        value=>io.stderr(JSON.stringify(value)+'\n'),await verifiedActor());
    }
    throw new UsageError('Use session profile show or session profile set.');
  }
  if(action==="session"&&args.words[1]==="identity"){
    const mode=args.words[2],sessionKey=args.words[3],projectId=project();
    if(!sessionKey||! /^(owned|external):[0-9a-fA-F-]{36}$/.test(sessionKey))
      throw new UsageError('Use an exact owned:UUID or external:UUID Session key.');
    const [kind,rawId]=sessionKey.split(':');
    if(kind==='owned')uuid(rawId,'Session');else uuid(rawId,'HostLink');
    if(mode==='show'){
      check(args,4,['project']);
      const snapshot=record(await client.get(`/api/projects/${projectId}/session-work/${encodeURIComponent(sessionKey)}`));
      return record(snapshot?.session)?.identity??null;
    }
    if(mode==='set'){
      check(args,4,['project','color','mark','reason','operation']);
      const color=option(args,'color'),mark=option(args,'mark'),reason=option(args,'reason');
      if(!color||!mark||!reason)throw new UsageError('identity set requires --color, --mark and --reason.');
      const snapshot=record(await client.get(`/api/projects/${projectId}/session-work/${encodeURIComponent(sessionKey)}`));
      const identity=record(record(snapshot?.session)?.identity);
      if(!identity||typeof identity.version!=='number')throw new UsageError('Persisted Session identity is unavailable.');
      const target=record(identity.target);
      if(!target || target.kind!==kind || (kind==='owned' && typeof target.sessionId!=='string') ||
        (kind==='external' && typeof target.linkId!=='string'))
        throw new UsageError('Persisted Session identity target is unavailable.');
      const operationId=option(args,'operation')?uuid(option(args,'operation'),'Operation'):randomUUID();
      const command=commandSchema.parse({type:'session.identity.set',projectId,operationId,target,
        expectedVersion:identity.version,color,mark,reason});
      const result=await dispatchMutation(client,store,origin,token,{id:operationId,operationId,projectId,
        kind:command.type,path:'/api/commands',body:command,confirmation:'command',
        recovery:{kind:'core',path:`/api/projects/${projectId}/operations/${operationId}`}},
        value=>io.stderr(JSON.stringify(value)+'\n'),await verifiedActor());
      return {result,identity:record(record(await client.get(`/api/projects/${projectId}/session-work/${encodeURIComponent(sessionKey)}`))?.session)?.identity??null};
    }
    throw new UsageError('Use session identity show or set.');
  }
  if(action==="role"&&args.words[1]==="runtime"){
    const mode=args.words[2],roleId=uuid(args.words[3],"Role"),projectId=project();
    const path=`/api/projects/${projectId}/roles/${roleId}/runtime`;
    if(mode==="show"){check(args,4,["project"]);return client.get(path);}
    if(mode==="set"){
      check(args,4,["project","provider","project-skills","personal","builtin","add","remove","reason","operation"]);
      const reason=option(args,"reason");
      if(!reason)throw new UsageError("role runtime set requires --reason.");
      const view=record(await client.get(path));
      const selection=record(view?.selection),binding=record(view?.binding);
      if(!view||!selection||typeof view.provider!=="string")throw new UsageError("Current Role runtime is unavailable; use role runtime show.");
      const toggle=(key:string,current:unknown)=>{
        const value=option(args,key);
        if(value===undefined)return current;
        if(value!=="on"&&value!=="off")throw new UsageError(`--${key} takes on or off.`);
        return value==="on";
      };
      const names=(key:string,current:unknown)=>{
        const value=option(args,key);
        if(value===undefined)return current;
        return value==="none"?[]:value.split(",").map(item=>item.trim()).filter(Boolean);
      };
      const operationId=option(args,"operation")?uuid(option(args,"operation"),"Operation"):randomUUID();
      const command=commandSchema.parse({type:"role.runtime.set",projectId,roleId,operationId,
        expectedRevision:typeof binding?.revision==="number"?binding.revision:0,
        provider:option(args,"provider")??view.provider,
        skills:{project:toggle("project-skills",selection.project),personal:toggle("personal",selection.personal),
          builtin:toggle("builtin",selection.builtin),add:names("add",selection.add),remove:names("remove",selection.remove)},reason});
      const result=await dispatchMutation(client,store,origin,token,{id:operationId,operationId,projectId,
        kind:command.type,path:"/api/commands",body:command,confirmation:"command",
        recovery:{kind:"core",path:`/api/projects/${projectId}/operations/${operationId}`}},
        value=>io.stderr(JSON.stringify(value)+"\n"),await verifiedActor());
      return {result,runtime:await client.get(path)};
    }
    throw new UsageError("Use role runtime show or role runtime set.");
  }
  if (action === "session") { check(args, 1); return client.get("/api/session"); }
  if (action === "models") { check(args, 1, ["project"]); return client.get(`/api/projects/${project()}/runtime/models`); }
  if (action === "project") { check(args, 2); return client.get(`/api/projects/${uuid(args.words[1], "Project")}`); }
  if (action === "get") { check(args, 2); return client.get(args.words[1]!); }
  if (action === "command") {
    const file = args.words[1] === "run" ? args.words[2] : args.words[1];
    check(args, args.words[1] === "run" ? 3 : 2);
    if (!file) throw new UsageError("command run requires a JSON file.");
    const source = JSON.parse(await readFile(file, "utf8"));
    const business = commandSchema.safeParse(source), orchestration = business.success ? null : orchestrationCommandSchema.safeParse(source);
    if (!business.success && !orchestration?.success) {
      // Name the failing fields and the schema's own message (it carries accepted formats and examples) rather than only pointing at the schema.
      const type = record(source)?.type;
      const known = typeof type === "string" && commandSchema.options.some(option => option.shape.type.value === type);
      const issues = (known ? business.error : orchestration!.error).issues.slice(0, 3)
        .map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      throw new UsageError(`Input does not match a business or orchestration command schema; use command schema TYPE. ${issues}`);
    }
    const command = business.success ? business.data : orchestration?.success ? orchestration.data : null;
    if (!command) throw new UsageError("Input does not match a command schema.");
    const orchestrationRoute = !business.success;
    return dispatchMutation(client, store, origin, token, { id: command.operationId, operationId: command.operationId,
      projectId: command.projectId, kind: command.type, path: orchestrationRoute ? "/api/orchestration/commands" : "/api/commands", body: command, confirmation: "command",
      recovery: { kind: orchestrationRoute ? "orchestration" : "core", path: `/api/projects/${command.projectId}/${orchestrationRoute ? "orchestration/" : ""}operations/${command.operationId}` } }, value => io.stderr(JSON.stringify(value) + "\n"), await verifiedActor());
  }
  if (action === "request") {
    check(args, 2, ["project", "file", "id", "receipt"]);
    const file = option(args, "file"); if (!file) throw new UsageError("request requires --file JSON_FILE; see request types.");
    const intent = prepareRequest(args.words[1]!, project(), JSON.parse(await readFile(file, "utf8")), option(args, "id"), option(args, "receipt"));
    return dispatchMutation(client, store, origin, token, intent, value => io.stderr(JSON.stringify(value) + "\n"), await verifiedActor());
  }
  if (action === "receipts") {
    check(args, 3);
    if (!["reconcile", "retry"].includes(args.words[1] ?? "")) throw new UsageError("Use receipts reconcile UUID or retry UUID.");
    const id = uuid(args.words[2], "Receipt"), actor = await verifiedActor();
    const result = args.words[1] === "retry"
      ? await retryReceipt(client, store, origin, token, id, value => io.stderr(JSON.stringify(value) + "\n"), actor)
      : await reconcileReceipt(client, store, origin, token, id, actor);
    if (result.state === "rejected") throw new ReceiptError("OPERATION_REJECTED", "The saved intent was rejected.", result.result ?? result.lastError);
    return result;
  }
  const projectId = project(), prefix = `/api/projects/${projectId}`;
  if (action === "work") {
    if (args.words[1] === "acceptance") {
      if (args.words[2] === "read" || args.words[2] === "observe") {
        check(args,4,["project","task","file"]);
        const file=option(args,"file");if(!file)throw new UsageError("Acceptance read/observe requires --file BODY.json.");
        const raw=JSON.parse(await readFile(file,"utf8")) as Record<string,unknown>;
        raw.relayId=uuid(args.words[3],"Acceptance arrangement");
        const task=option(args,"task")??(typeof raw.taskId==="string"?raw.taskId:undefined);
        if(!task)throw new UsageError("Acceptance read/observe requires --task TASK_UUID.");
        raw.taskId=uuid(task,"Task");
        const intent=prepareRequest(`acceptance.${args.words[2]}`,project(),raw,args.words[3]);
        return dispatchMutation(client,store,origin,token,intent,value=>io.stderr(JSON.stringify(value)+"\n"),await verifiedActor());
      }
      check(args,args.words[2]?3:2,["project","limit","cursor","brief"]);
      const brief=args.options.has("brief");
      if(args.words[2] === "mine"){
        if(brief)throw new UsageError("--brief does not apply to work acceptance mine; it is already a short list.");
        return client.get(`${prefix}/acceptance-relay/mine`);
      }
      if(args.words[2]){
        const relays=await client.get(`${prefix}/tasks/${uuid(args.words[2],"Task")}/acceptance-relay`);
        return brief?briefRelays(relays as Record<string,any>):relays;
      }
      const limit=option(args,"limit")??"50",cursor=option(args,"cursor");
      const overview=await client.get(`${prefix}/acceptance-relay/overview?limit=${encodeURIComponent(limit)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
      return brief?briefAcceptanceOverview(overview as Record<string,any>):overview;
    }
    if (args.words[1] === "retirement") {
      check(args,3,["project"]);
      return client.get(`${prefix}/runtime/sessions/${uuid(args.words[2],"Session")}/retirement`);
    }
    if (args.words[1] === "manual-stop-preview") {
      check(args, 3, ["project"]);
      return client.get(`${prefix}/session-messages/${uuid(args.words[2], "Message")}/manual-stop-preview`);
    }
    if (args.words[1] === "status") {
      check(args, 3, ["project", "message"]);
      const snapshotPath = sessionWorkPath(["snapshot", args.words[2]!], new Map([["project", projectId]]));
      const messageId = option(args, "message") ? uuid(option(args, "message"), "Message") : undefined;
      const snapshot = await client.get(`${prefix}${snapshotPath}`);
      const [detail, runtimeRead] = await Promise.all([
        messageId ? client.get(`${prefix}/session-messages/${messageId}`) : Promise.resolve(undefined),
        client.get(`${prefix}/runtime`).then(value => ({ state: "ok" as const, value }),
          () => ({ state: "failed" as const })),
      ]);
      try { return sessionStatus(snapshot, detail, messageId, runtimeRead); }
      catch (error) { throw new ReceiptError("INVALID_STATUS_SOURCE", error instanceof Error ? error.message : "Cannot verify status sources."); }
    }
    let path: string;
    try { path = sessionWorkPath(args.words.slice(1), args.options); }
    catch (error) { throw new UsageError(error instanceof Error ? error.message : "Invalid Session work read parameters."); }
    const read = await client.get(`${prefix}${path}`);
    if (!args.options.has("brief")) return read;
    if (args.words[1] === "leader") return briefIndex(read as Record<string, any>);
    // work task: the Task, plus the arrangements that are current for it (a second small read; its failure leaves the Task brief intact).
    const relays = await client.get(`${prefix}/tasks/${args.words[2]}/acceptance-relay`).catch(() => null);
    return briefTaskWithRelays(read as Record<string, any>, relays as Record<string, any> | null);
  }
  if (action === "allocations") {
    check(args, 1, ["project", "role", "session", "discussion", "limit", "cursor"]);
    try { return client.get(`${prefix}${allocationRelationsPath(args.options)}`); }
    catch (error) { throw new UsageError(error instanceof Error ? error.message : "Invalid allocation relation filter."); }
  }
  if (action === "list") {
    check(args, 2, ["project", "limit", "cursor", "task", "knowledge", "loop", "kind"]);
    const entity = args.words[1]!, orchestrationList = orchestrationLists[entity], suffix = listPaths[entity];
    if (args.options.has("kind") && entity !== "discussions") throw new UsageError("--kind applies only to list discussions.");
    if (orchestrationList) {
      if (args.options.has("task") || args.options.has("knowledge") || args.options.has("limit") || args.options.has("cursor"))
        throw new UsageError("Orchestration list accepts only --project and --loop for inbox/dispatches.");
      const loop = option(args, "loop");
      if (entity === "loops" && loop || entity !== "loops" && !loop) throw new UsageError("Use --loop UUID for inbox/dispatches only.");
      return client.get(`${prefix}/orchestration/loops${loop ? `/${uuid(loop, "Loop")}/${orchestrationList}` : ""}`);
    }
    if (!suffix || args.options.has("loop")) throw new UsageError("Unknown list or unsupported --loop; use help.");
    const query = new URLSearchParams();
    if (args.options.has("kind")) {
      const kind = option(args, "kind");
      if (!kind || !["allocation", "direction", "task_collaboration"].includes(kind))
        throw new UsageError("--kind must be allocation, direction, or task_collaboration.");
      query.set("kind", kind);
    }
    if (args.options.has("limit") || args.options.has("cursor")) {
      if (!["tasks", "documents", "goals", "discussions", "roles", "evaluations", "knowledge", "candidates"].includes(entity)) throw new UsageError("This endpoint is not paginated; omit --limit/--cursor.");
      const limit = Number(option(args, "limit") ?? 50); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new UsageError("--limit must be 1..100.");
      query.set("limit", String(limit)); const cursor = option(args, "cursor");
      if (cursor) query.set("cursor", ["knowledge", "candidates"].includes(entity) ? cursor : uuid(cursor, "Cursor"));
    }
    if (args.options.has("task") || args.options.has("knowledge")) {
      if (entity !== "evaluations") throw new UsageError("--task/--knowledge filters apply only to evaluations.");
      if (args.options.has("task")) query.set("taskId", uuid(option(args, "task"), "Task"));
      if (args.options.has("knowledge")) query.set("knowledgePageId", uuid(option(args, "knowledge"), "Knowledge page"));
    }
    return client.get(`${prefix}/${suffix}${query.size ? `?${query}` : ""}`);
  }
  if (action === "evaluation") {
    check(args, 2, ["project", "revision"]); const rev = revision();
    return client.get(`${prefix}/evaluations/${uuid(args.words[1], "Evaluation")}${rev ? `?revision=${rev}` : ""}`);
  }
  if (action === "evaluation-source") {
    check(args, 2, ["project"]);
    return client.get(`${prefix}/evaluations/source-task/${uuid(args.words[1], "Source Task")}`);
  }
  if (action === "evaluation-packet") {
    check(args, 2, ["project", "revision", "attempt"]);
    return client.get(`${prefix}/evaluations/${uuid(args.words[1], "Evaluation")}/attempts/${uuid(option(args, "attempt"), "Attempt")}/packet?revision=${uuid(option(args, "revision"), "Evaluation revision")}`);
  }
  if (action === "task" || action === "document") {
    check(args, 2, action === "task" ? ["project", "revision", "history"] : ["project", "revision"]);
    mode(args, ["revision", "history"]); const rev = revision();
    return client.get(`${prefix}/${action}s/${uuid(args.words[1], action)}${rev ? `/revisions/${rev}` : args.options.has("history") ? "/revisions" : ""}`);
  }
  if (action === "context") { check(args, 2, ["project", "revision"]); return readTaskContext(client, projectId, uuid(args.words[1], "Task"), revision()); }
  if (action === "materials") {
    check(args, 2, ["project", "revision"]);
    return materialCatalog(client, projectId, uuid(args.words[1], "Task"), uuid(option(args, "revision"), "Fixed Task revision"));
  }
  if (action === "handoff") {
    check(args, 2, ["project", "hash"]);
    return materialHandoff(client, projectId, uuid(args.words[1], "Run"), fixedHash(option(args, "hash"), "Run input hash"));
  }
  if (action === "run-input") {
    check(args, 2, ["project", "hash", "cursor", "limit", "out"]);
    const cursor = Number(option(args, "cursor") ?? "0"), limit = Number(option(args, "limit") ?? "4096");
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8192 ||
        option(args, "out") && (option(args, "cursor") || option(args, "limit")))
      throw new UsageError("Run input uses a nonnegative byte cursor and 1..8192 limit; --out reads the whole fixed input.");
    return materialRunInput(client, projectId, uuid(args.words[1], "Run"),
      fixedHash(option(args, "hash"), "Run input hash"), cursor, limit, option(args, "out"));
  }
  if (action === "body") {
    check(args, 2, ["project", "revision", "hash", "cursor", "limit"]);
    const cursor = Number(option(args, "cursor") ?? "0"), limit = Number(option(args, "limit") ?? "4096");
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8192)
      throw new UsageError("Body --cursor must be a nonnegative byte offset and --limit must be 1..8192.");
    return materialBody(client, projectId, uuid(args.words[1], "Document"),
      uuid(option(args, "revision"), "Fixed document revision"), fixedHash(option(args, "hash"), "Document hash"), cursor, limit);
  }
  if (action === "asset") {
    check(args, 2, ["project", "revision", "hash", "id", "asset-hash", "out"]);
    return materialAsset(client, projectId, uuid(args.words[1], "Document"),
      uuid(option(args, "revision"), "Fixed document revision"), uuid(option(args, "id"), "Asset blob"),
      fixedHash(option(args, "hash"), "Document hash"), fixedHash(option(args, "asset-hash"), "Asset hash"), option(args, "out"));
  }
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
    check(args, 3, ["project", "cursor", "turn-cursor", ...readModes]); const kind = args.words[1]!, objectId = uuid(args.words[2], "Object"), selected = mode(args, readModes);
    if ((option(args, "cursor") || option(args, "turn-cursor")) && !(kind === "run" && selected === "trace")) throw new UsageError("--cursor and --turn-cursor apply only to read run --trace.");
    const orchestration = orchestrationReads[kind];
    if (orchestration) {
      if (selected && !orchestration.modes.includes(selected)) throw new UsageError("Unsupported orchestration read mode.");
      return client.get(`${prefix}/orchestration/${orchestration.path}/${objectId}${selected ? `/${selected}` : ""}`);
    }
    const definition = reads[kind]; if (!definition || selected && !definition.modes.includes(selected)) throw new UsageError("Unsupported object or read mode; use help.");
    if (definition.list && !selected) {
      const result = await client.get(`${prefix}/${definition.path}`), entries = Array.isArray(result) ? result : record(result)?.items;
      const found = Array.isArray(entries) ? entries.find(value => record(value)?.id === objectId) : undefined;
      if (!found) throw new ReceiptError("OBJECT_NOT_FOUND", "Object was absent from this bounded authorized list; global absence is not proven.");
      return found;
    }
    const query = new URLSearchParams();
    if (option(args, "cursor")) query.set("cursor", option(args, "cursor")!);
    if (option(args, "turn-cursor")) query.set("turnCursor", option(args, "turn-cursor")!);
    return client.get(`${prefix}/${definition.path}/${objectId}${selected ? `/${selected}` : ""}${query.size ? `?${query}` : ""}`);
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
