/** Opt-in alpha.6 composite: existing business Run and automatic notice each
 * receive two direct steers through the ordinary HTTP, PostgreSQL and native
 * paths. Run only against a dedicated evoloop_*_test database.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import Fastify from "fastify";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgDirectInputs } from "@evoloop/adapter-postgres/direct-input";
import { CodexAppServerAdapter, RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import { mapWorkspaceItem } from "../../../packages/adapter-codex-app-server/src/workspace-map.ts";
import { SessionMessageService } from "@evoloop/core/session-messages";
import type { RuntimeBinding, RuntimeTurn } from "@evoloop/contracts/runtime";
import { DirectInputService } from "../src/direct-input/service.js";
import { registerDirectInputRoutes } from "../src/direct-input/routes.js";
import { SessionMessagePump } from "../src/session-messages/pump.js";

const url = process.env.TEST_DATABASE_URL;
const executable = process.env.LIVE_CODEX_BIN;
const actorId = process.env.LIVE_DIRECT_ACTOR ?? "candidate-consumer";
const model = process.env.LIVE_DIRECT_MODEL ?? "gpt-6-sol";
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname.slice(1)) || !executable)
  throw new Error("Dedicated evoloop_*_test database and LIVE_CODEX_BIN are required");

const schema = `el_sources_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const projectId = randomUUID(), roleId = randomUUID();
const runSessionId = randomUUID(), noticeSessionId = randomUUID();
const cwd = await realpath(await mkdtemp(join(tmpdir(), "evoloop-direct-sources-")));
const rows = Array.from({ length: 36 }, (_, index) => {
  const group = ["amber", "blue", "copper"][index % 3];
  const amount = (index * 7) % 29 + 2;
  return `C${String(index + 1).padStart(2, "0")},${group},${amount},${index % 7 === 0 ? "hold" : "ready"}`;
});
await writeFile(join(cwd, "cases.csv"), `id,group,amount,status\n${rows.join("\n")}\n`);

const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const store = new PgDirectInputs(pool);
const token = randomUUID();
const app = Fastify();
const native = new CodexAppServerAdapter({
  executable,
  expectedVersion: "codex-cli 0.166.0-alpha.6",
  workspaceExperimental: true,
  requestTimeoutMs: 30000,
  initializationTimeoutMs: 30000,
  verifyBinding: async candidate => {
    const result = await pool.query(`SELECT 1 FROM runtime_session WHERE project_id=$1 AND session_id=$2
      AND role_id=$3 AND cwd=$4 AND native_thread_id=$5 AND native_session_id=$6
      AND authorization_scope=$7 AND state='ready'`,
      [candidate.projectId, candidate.sessionId, candidate.roleId, candidate.cwd,
        candidate.nativeThreadId, candidate.nativeSessionId, candidate.authorizationScope]);
    return result.rowCount === 1;
  },
});
const events: Array<{ sessionId: string; method: string }> = [];

async function createNativeSession(sessionId: string): Promise<RuntimeBinding> {
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,model,state,version,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'isolated-direct-sources','danger-full-access','never',$6,'creating',1,$5,
    'isolated-agent',now(),now())`, [projectId, sessionId, roleId, cwd, randomUUID(), model]);
  const profile = (await pool.query(`SELECT revision_id FROM session_execution_profile
    WHERE project_id=$1 AND session_id=$2`, [projectId, sessionId])).rows[0];
  assert.ok(profile?.revision_id, "stored Session profile revision is required before native creation");
  const binding = await native.create({ actorId: "isolated-agent", sessionId, roleId, projectId, cwd,
    authorizationScope: "isolated-direct-sources", model, sandbox: "danger-full-access",
    approvalPolicy: "never", executionProfileRevisionId: profile.revision_id });
  await pool.query(`UPDATE runtime_session SET state='ready',native_thread_id=$3,native_session_id=$4,
    version=version+1,updated_at=now() WHERE project_id=$1 AND session_id=$2`,
    [projectId, sessionId, binding.nativeThreadId, binding.nativeSessionId]);
  return binding;
}

const grantFor = (sessionId: string, senderActorId = actorId) => ({
  projectId, sessionId, senderActorId, receiverRoleId: roleId, receiverActorId: "isolated-agent",
  cwd, enabled: true, canStart: true, canSteer: true,
});

function publicItems(items: unknown[], turnId: string, binding: RuntimeBinding) {
  return items.flatMap(item => {
    const mapped = mapWorkspaceItem(item, turnId, binding, new Date().toISOString());
    if (!mapped) return [];
    return [{
      kind: mapped.kind, role: "role" in mapped ? mapped.role : null,
      nativeKind: mapped.nativeKind, nativeItemId: mapped.nativeItemId,
      clientId: "clientId" in mapped ? mapped.clientId : null,
      name: "name" in mapped ? mapped.name : null,
      label: "label" in mapped ? mapped.label : null,
      state: mapped.state,
      body: (mapped.kind === "message" || mapped.kind === "plan") && mapped.body.length <= 2000
        ? mapped.body : null,
      detailAvailable: "detailAvailable" in mapped ? mapped.detailAvailable : null,
    }];
  });
}

async function waitTerminal(binding: RuntimeBinding, turnId: string): Promise<RuntimeTurn> {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const turn = (await native.listTurns(binding)).data.find(item => item.id === turnId);
    if (turn && turn.status !== "inProgress") return turn;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`native Turn ${turnId} did not settle within the bound`);
}

async function waitInProgress(binding: RuntimeBinding, turnId: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const turn = (await native.listTurns(binding)).data.find(item => item.id === turnId);
      if (turn?.status === "inProgress") return;
    } catch (error) {
      if (!(error instanceof RuntimeServerError) || error.method !== "thread/turns/list" ||
        ![-32600, -32601].includes(error.code))
        throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`native Turn ${turnId} never became readable as inProgress`);
}

async function post(inputId: string, content: string, expectedTurnId: string | null) {
  const command = { inputId, operationId: randomUUID(), content, expectedTurnId };
  const response = await fetch(`${address}/api/projects/${projectId}/sessions/${endpointSessionId}/direct-inputs`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  return { command, receipt };
}

let address = "", endpointSessionId = "";
let runBinding: RuntimeBinding, noticeBinding: RuntimeBinding;
const pumpErrors: unknown[] = [];
try {
  await migrate(url, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Isolated direct sources',now())",
    [projectId]);
  await native.open();
  native.onEvent(event => {
    if (event.sessionId === runSessionId || event.sessionId === noticeSessionId) {
      if (["turn/started", "turn/completed", "turn/plan/updated", "item/started", "item/completed"].includes(event.method))
        events.push({ sessionId: event.sessionId, method: event.method });
    }
  });
  runBinding = await createNativeSession(runSessionId);
  noticeBinding = await createNativeSession(noticeSessionId);

  const service = new DirectInputService({
    store, runtime: () => native, canWrite: () => true,
    admission: async (principal, project, sessionId) => {
      if (principal.actorId !== actorId || project !== projectId)
        throw new Error("isolated actor mismatch");
      return { grant: grantFor(sessionId), binding: sessionId === runSessionId ? runBinding : noticeBinding };
    },
    bindingFor: async (_project, sessionId) => sessionId === runSessionId ? runBinding : noticeBinding,
  });
  const messageService = new SessionMessageService({
    uow: new PostgresUnitOfWork(pool),
    clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID },
    grantFor: async (message, session) => grantFor(session.id, message.senderActorId),
  });
  const pump = new SessionMessagePump({
    service: messageService, runtime: () => native, projects: async () => [projectId],
    canWrite: () => true, canStart: async () => true, pollIntervalMs: 1000,
    onError: error => pumpErrors.push(error),
  });
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => {
    if (request.headers.authorization === `Bearer ${token}`)
      request.principal = { actorId, projectIds: [projectId], permissions: ["read", "write"] } as never;
  });
  app.setErrorHandler((error, _request, reply) => reply.code(
    error instanceof Error && error.message === "isolated actor mismatch" ? 403 : 409,
  ).send({ error: error instanceof Error ? error.message : "unknown" }));
  registerDirectInputRoutes(app, service);
  address = await app.listen({ host: "127.0.0.1", port: Number(process.env.LIVE_DIRECT_PORT ?? 0) });

  // Existing business Run: the native Turn starts first; the PG row remains the
  // sole primary source and its immutable TaskRevision/inputHash must not move.
  const runTurnOperation = randomUUID();
  const runQualification = await native.qualifyConversationThread(runBinding);
  assert.equal(runQualification.available, true, runQualification.reason);
  const runTurn = await native.startConversationTurn(runBinding,
    `Read cases.csv in this private directory. Write run-report.md with the count and sum by group, ` +
    `and list every hold ID. Use command tools and verify every figure against the CSV before the final reply.`,
    runTurnOperation);
  const taskId = randomUUID(), revisionId = randomUUID(), basisId = randomUUID();
  const documentId = randomUUID(), documentRevisionId = randomUUID(), runId = randomUUID();
  const inputHash = createHash("sha256").update("fixed business Run input").digest("hex");
  const fixture = await pool.connect();
  try {
    await fixture.query("BEGIN");
    await fixture.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,
      adopted_revision_id,kind,status) VALUES($1,$2,'Task',1,$3,$3,'task','published')`,
      [projectId, documentId, documentRevisionId]);
    await fixture.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
      author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'Body','markdown',$4,'agent',now(),'fixture','text/markdown','task.md','[]'::jsonb)`,
      [projectId, documentId, documentRevisionId, inputHash]);
    await fixture.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,
      reason,created_at) VALUES($1,$2,$3,$4,'agent','adopt',now())`,
      [projectId, randomUUID(), documentId, documentRevisionId]);
    await fixture.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,
      state,kind,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Isolated run source','check',$5,'in_progress',NULL,$6,$4)`,
      [projectId, taskId, revisionId, documentRevisionId, roleId, documentId]);
    await fixture.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Isolated run source','check',$7,'in_progress',$4,'agent','fixture',now(),NULL,$5,$6)`,
      [projectId, taskId, revisionId, basisId, documentId, documentRevisionId, roleId]);
    await fixture.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
      VALUES($1,$2,$3,$4,false)`, [projectId, taskId, revisionId, basisId]);
    await fixture.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,
      document_revision_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [projectId, taskId, revisionId, basisId, documentId, documentRevisionId]);
    await fixture.query("UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND basis_set_id=$3",
      [projectId, taskId, basisId]);
    await fixture.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
      operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'fixed business Run input',$8,'running',1,$9,'agent',now(),now())`,
      [projectId, runId, taskId, revisionId, basisId, runSessionId, runTurnOperation, inputHash, runTurn.id]);
    await fixture.query("COMMIT");
  } catch (error) {
    await fixture.query("ROLLBACK");
    throw error;
  } finally {
    fixture.release();
  }

  endpointSessionId = runSessionId;
  await waitInProgress(runBinding, runTurn.id);
  const runFirstId = randomUUID();
  const runFirst = await post(runFirstId, "Also include the maximum ready amount, listing all tied IDs.", runTurn.id);
  const runSecondId = randomUUID();
  const runSecond = await post(runSecondId, "Add a separate sentence giving the total count of hold rows and confirm run-report.md.",
    runTurn.id);
  for (const { receipt } of [runFirst, runSecond]) {
    assert.equal(receipt.state, "accepted");
    assert.equal(receipt.source.kind, "run");
    assert.equal(receipt.source.id, runId);
    assert.equal(receipt.actualTurnId, runTurn.id);
  }
  const runBeforeTerminal = (await pool.query(`SELECT task_revision_id,input_hash,state FROM runtime_run
    WHERE project_id=$1 AND run_id=$2`, [projectId, runId])).rows[0];
  assert.equal(runBeforeTerminal.task_revision_id, revisionId);
  assert.equal(runBeforeTerminal.input_hash, inputHash);
  assert.equal(runBeforeTerminal.state, "running");
  const runTerminal = await waitTerminal(runBinding, runTurn.id);
  assert.equal(runTerminal.status, "completed");
  const runItems = (await native.listItems(runBinding, runTurn.id)).data;
  const runPublic = publicItems(runItems, runTurn.id, runBinding);
  for (const inputId of [runTurnOperation, runFirstId, runSecondId]) {
    assert.ok(runPublic.some(item => item.clientId === inputId),
      `business Run input ${inputId} must bind to one exact native Item`);
  }
  assert.ok(runPublic.some(item => item.kind === "message" && item.role === "assistant"));
  assert.ok(runPublic.some(item => item.kind === "tool"), "business Run public projection must retain its tool activity");
  assert.equal(runPublic.some(item => item.kind === "notice" && item.nativeKind === "reasoning"), false);
  assert.match(await readFile(join(cwd, "run-report.md"), "utf8"), /amber/i);
  await pool.query(`UPDATE runtime_run SET state='completed',version=version+1,updated_at=now()
    WHERE project_id=$1 AND run_id=$2 AND state='running'`, [projectId, runId]);

  // Automatic notice: an owned queued message is started by the ordinary pump,
  // then two authorized user supplements attach to that same native Turn.
  const noticeMessageId = randomUUID(), noticeOperationId = randomUUID(), noticeSender = "leader-notice";
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,$5,$6,'queued',1,now(),now())`,
    [projectId, noticeMessageId, noticeOperationId, noticeSessionId, noticeSender,
      `Read cases.csv in this private directory. Write notice-report.md with the count and sum by group, ` +
      `and list every hold ID. Use command tools and verify every figure against the CSV before the final reply.`]);
  await pump.tick();
  assert.deepEqual(pumpErrors, []);
  const noticeProcessing = (await pool.query(`SELECT processing_id,operation_id,state,native_turn_id
    FROM session_message_processing WHERE project_id=$1 AND message_id=$2`,
    [projectId, noticeMessageId])).rows[0];
  assert.equal(noticeProcessing?.state, "running");
  assert.ok(noticeProcessing?.native_turn_id);
  endpointSessionId = noticeSessionId;
  await waitInProgress(noticeBinding, noticeProcessing.native_turn_id);
  const noticeFirstId = randomUUID();
  const noticeFirst = await post(noticeFirstId,
    "Also include the maximum ready amount, listing all tied IDs.", noticeProcessing.native_turn_id);
  const noticeSecondId = randomUUID();
  const noticeSecond = await post(noticeSecondId,
    "Add a separate sentence giving the total count of hold rows and confirm notice-report.md.",
    noticeProcessing.native_turn_id);
  for (const { receipt } of [noticeFirst, noticeSecond]) {
    assert.equal(receipt.state, "accepted");
    assert.equal(receipt.source.kind, "message");
    assert.equal(receipt.source.id, noticeMessageId);
    assert.equal(receipt.source.processingId, noticeProcessing.processing_id);
    assert.equal(receipt.actualTurnId, noticeProcessing.native_turn_id);
  }
  const noticeTerminal = await waitTerminal(noticeBinding, noticeProcessing.native_turn_id);
  assert.equal(noticeTerminal.status, "completed");
  await pump.tick();
  assert.deepEqual(pumpErrors, []);
  const noticeSettled = (await pool.query(`SELECT m.state AS message_state,p.state AS processing_state,
    p.response FROM session_message m JOIN session_message_processing p
    ON p.project_id=m.project_id AND p.message_id=m.message_id
    WHERE m.project_id=$1 AND m.message_id=$2`, [projectId, noticeMessageId])).rows[0];
  assert.ok(["replied", "completed_without_reply"].includes(noticeSettled?.message_state));
  assert.equal(noticeSettled?.processing_state, "completed");
  assert.ok(noticeSettled?.response);
  const noticeItems = (await native.listItems(noticeBinding, noticeProcessing.native_turn_id)).data;
  const noticePublic = publicItems(noticeItems, noticeProcessing.native_turn_id, noticeBinding);
  for (const inputId of [noticeProcessing.operation_id, noticeFirstId, noticeSecondId]) {
    assert.ok(noticePublic.some(item => item.clientId === inputId),
      `notice input ${inputId} must bind to one exact native Item`);
  }
  assert.ok(noticePublic.some(item => item.kind === "message" && item.role === "assistant"));
  assert.ok(noticePublic.some(item => item.kind === "tool"), "notice public projection must retain its tool activity");
  assert.match(await readFile(join(cwd, "notice-report.md"), "utf8"), /amber/i);

  const result = {
    kind: "isolated-http-pg-alpha6-source-selftest",
    schema, cwd, address, projectId, model, actorId,
    run: {
      sessionId: runSessionId, threadId: runBinding.nativeThreadId, turnId: runTurn.id,
      taskRevisionId: revisionId, inputHash, sourceId: runId,
      inputIds: [runTurnOperation, runFirstId, runSecondId], public: runPublic,
      reportPath: join(cwd, "run-report.md"),
    },
    notice: {
      sessionId: noticeSessionId, threadId: noticeBinding.nativeThreadId,
      messageId: noticeMessageId, processingId: noticeProcessing.processing_id,
      turnId: noticeProcessing.native_turn_id,
      inputIds: [noticeProcessing.operation_id, noticeFirstId, noticeSecondId], public: noticePublic,
      reportPath: join(cwd, "notice-report.md"), settlement: noticeSettled,
    },
    events,
    summaryEvidence: {
      planEvents: events.filter(event => event.method === "turn/plan/updated").length,
      agentMessages: [...runPublic, ...noticePublic].filter(item => item.kind === "message" && item.role === "assistant").length,
      tools: [...runPublic, ...noticePublic].filter(item => item.kind === "tool").length,
    },
  };
  const resultPath = process.env.LIVE_DIRECT_SOURCES_RESULT ?? join(cwd, "sources-result.json");
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ resultPath,
    resultSha256: createHash("sha256").update(JSON.stringify(result, null, 2)).digest("hex"),
    address, projectId, model, runTurnId: runTurn.id, noticeTurnId: noticeProcessing.native_turn_id,
    summaryEvidence: result.summaryEvidence }));
} finally {
  await app.close();
  await native.close();
  await pool.end();
}
