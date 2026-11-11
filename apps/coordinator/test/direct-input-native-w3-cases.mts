/** Opt-in real-binary evidence for W3 rework: wrong-Turn rejection and a review Turn that cannot be steered.
 * Requires a dedicated evoloop_*_test database and LIVE_CODEX_BIN. It starts real native Turns, so it is not CI.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "@evoloop/adapter-postgres";
import { PgDirectInputs } from "@evoloop/adapter-postgres/direct-input";
import { CodexAppServerAdapter, RuntimeProtocolError, RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import { DirectInputService } from "../src/direct-input/service.js";

const url = process.env.TEST_DATABASE_URL;
const executable = process.env.LIVE_CODEX_BIN;
const actorId = process.env.LIVE_DIRECT_ACTOR ?? "w3-evidence-actor";
const model = process.env.LIVE_DIRECT_MODEL ?? "deepseek/deepseek-flash";
const expectedVersion = process.env.LIVE_CODEX_VERSION ?? "codex-cli 0.167.0-alpha.3.2";
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname.slice(1)) || !executable)
  throw new Error("Dedicated evoloop_*_test database and LIVE_CODEX_BIN are required");

const schema = `el_w3_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const projectId = randomUUID(), sessionId = randomUUID(), roleId = randomUUID();
const cwd = await realpath(await mkdtemp(join(tmpdir(), "evoloop-w3-native-")));
await writeFile(join(cwd, "note.txt"), "review evidence\n");
await writeFile(join(cwd, "big.txt"), Array.from({ length: 4000 },
  (_, index) => `line ${index + 1}: review token ${index % 17} sample`).join("\n"));
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const native = new CodexAppServerAdapter({ executable, expectedVersion, requestTimeoutMs: 60000,
  initializationTimeoutMs: 30000, verifyBinding: async () => true });
const result: Record<string, unknown> = { kind: "w3-native-cases", realBinary: executable, expectedVersion, model,
  schema, cwd, cases: {} as Record<string, unknown> };

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function terminalTurn(binding: Awaited<ReturnType<CodexAppServerAdapter["create"]>>, turnId: string) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const turn = (await native.listTurns(binding)).data.find(value => value.id === turnId);
    if (turn && turn.status !== "inProgress") return turn;
    await wait(500);
  }
  throw new Error(`native Turn ${turnId} did not settle`);
}

let binding: Awaited<ReturnType<CodexAppServerAdapter["create"]>> | null = null;
try {
  await migrate(url, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'W3 native cases',now())", [projectId]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,model,state,version,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'w3-native-evidence','danger-full-access','never',$6,'creating',1,$5,
    'w3-native-agent',now(),now())`, [projectId, sessionId, roleId, cwd, randomUUID(), model]);
  const profile = (await pool.query(`SELECT revision_id FROM session_execution_profile
    WHERE project_id=$1 AND session_id=$2`, [projectId, sessionId])).rows[0];
  assert.ok(profile?.revision_id, "stored Session execution profile is required before native creation");
  await native.open();
  binding = await native.create({ actorId: "w3-native-agent", sessionId, roleId, projectId, cwd,
    authorizationScope: "w3-native-evidence", model, sandbox: "danger-full-access", approvalPolicy: "never",
    executionProfileRevisionId: profile.revision_id });
  await pool.query(`UPDATE runtime_session SET state='ready',native_thread_id=$3,native_session_id=$4,
    version=version+1,updated_at=now() WHERE project_id=$1 AND session_id=$2`,
    [projectId, sessionId, binding.nativeThreadId, binding.nativeSessionId]);

  const admission = await native.qualifyConversationThread(binding);
  assert.equal(admission.available, true, admission.reason);
  const normalTurn = await native.startConversationTurn(binding,
    "Run the shell command `sleep 20` exactly once, wait for it to finish, then reply with exactly: ready. Do not modify files.",
    randomUUID());
  let normalActive: { id: string; status: string } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    normalActive = (await native.listTurns(binding)).data.find(turn => turn.id === normalTurn.id);
    if (normalActive?.status === "inProgress") break;
    await wait(50);
  }
  assert.equal(normalActive?.status, "inProgress", "the normal Turn must be active for the wrong-ID probe");

  const wrongTurnId = randomUUID(), wrongInputId = randomUUID();
  let wrong: unknown;
  try { await native.steerTurn(binding, wrongTurnId, "wrong turn probe", wrongInputId); }
  catch (error) { wrong = error; }
  assert.ok(wrong instanceof RuntimeServerError && wrong.code === -32600 && wrong.steerRejection === null,
    "the real native runtime rejects a wrong expected Turn ID");
  await native.interruptTurn(binding, normalTurn.id).catch(() => undefined);
  await terminalTurn(binding, normalTurn.id);
  const normalItems = (await native.listItems(binding, normalTurn.id)).data as Array<Record<string, unknown>>;
  assert.equal(normalItems.some(item => item.clientId === wrongInputId), false,
    "the refused wrong-Turn probe has no native Item");
  (result.cases as Record<string, unknown>).wrongTurn = {
    expectedTurnId: wrongTurnId, actualTurnId: normalTurn.id,
    errorClass: wrong instanceof Error ? wrong.name : "unknown", error: wrong instanceof Error ? wrong.message : String(wrong),
    code: wrong instanceof RuntimeServerError ? wrong.code : null,
    category: wrong instanceof RuntimeServerError ? wrong.category : null,
    steerRejection: wrong instanceof RuntimeServerError ? wrong.steerRejection : null,
    nativeItemCreated: false,
  };

  const raw = native as unknown as { request(method: string, params: unknown): Promise<unknown> };
  const reviewInputId = randomUUID();
  const reviewStarted = Date.now();
  const review = await raw.request("review/start", { threadId: binding.nativeThreadId,
    delivery: "inline",
    target: { type: "custom", instructions: "Read big.txt completely and review all 4000 lines. Report the first and last line of each 100-line block in detail. Do not modify files." } });
  const reviewBody = review as { threadId?: string; reviewThreadId?: string; turn?: { id?: string; status?: string } };
  const reviewTurnId = reviewBody.turn?.id;
  assert.ok(reviewTurnId, "review/start must return a Turn");
  assert.equal(reviewBody.turn?.status, "inProgress");
  assert.ok(reviewBody.reviewThreadId, "review/start must return the review Thread");
  const reviewRead = (await raw.request("thread/read", { threadId: reviewBody.reviewThreadId, includeTurns: false })) as
    { thread?: { id?: string; sessionId?: string; cwd?: string; status?: { type?: string } } };
  assert.equal(reviewRead.thread?.id, reviewBody.reviewThreadId);
  const reviewBinding = { ...binding, nativeThreadId: reviewBody.reviewThreadId,
    nativeSessionId: reviewRead.thread?.sessionId ?? binding.nativeSessionId };
  await native.registerBinding(reviewBinding);
  let reviewLatest: { id: string; status: string } | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    reviewLatest = (await native.listTurns(reviewBinding)).data.find(turn => turn.status === "inProgress");
    if (reviewLatest) break;
    await wait(25);
  }
  assert.ok(reviewLatest, "the review Thread must expose its active Turn");
  const reviewActiveTurnId = reviewLatest!.id;
  const reviewSteerTurnId = reviewTurnId;
  const reviewError = await native.steerTurn(reviewBinding, reviewSteerTurnId, "review steer probe", reviewInputId)
    .then(() => null, error => error);
  const reviewSteerLatencyMs = Date.now() - reviewStarted;
  if (!(reviewError instanceof RuntimeServerError && reviewError.steerRejection === "non_steerable_turn"))
    console.error(JSON.stringify({ reviewError: reviewError instanceof Error ? {
      name: reviewError.name, message: reviewError.message,
      category: reviewError instanceof RuntimeServerError ? reviewError.category : null,
      steerRejection: reviewError instanceof RuntimeServerError ? reviewError.steerRejection : null,
      code: reviewError instanceof RuntimeServerError ? reviewError.code : null,
    } : String(reviewError),
    reviewBody, reviewLatest, reviewTurns: (await native.listTurns(reviewBinding)).data, reviewSteerLatencyMs,
    reviewTurn: (await native.listTurns(reviewBinding)).data.find(value => value.id === reviewSteerTurnId) ?? null }, null, 2));
  assert.ok(reviewError instanceof RuntimeServerError && reviewError.steerRejection === "non_steerable_turn",
    "the real 0.167 review Turn must be classified as non-steerable");
  (result.cases as Record<string, unknown>).reviewTurn = {
    reviewTurnId: reviewSteerTurnId, reviewThreadId: reviewBody.reviewThreadId, reviewTurnStatus: reviewBody.turn?.status,
    errorClass: reviewError.name, category: reviewError.category, steerRejection: reviewError.steerRejection,
    code: reviewError.code,
  };

  const primaryMessageId = randomUUID(), primaryProcessingId = randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'sender','Review primary','processing',1,now(),now())`,
    [projectId, primaryMessageId, randomUUID(), sessionId]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'w3-native-agent','running',$6,$7,1,now(),now())`,
    [projectId, primaryProcessingId, primaryMessageId, sessionId, randomUUID(), reviewSteerTurnId, "a".repeat(64)]);
  const grant = { projectId, sessionId, senderActorId: actorId, receiverRoleId: roleId,
    receiverActorId: "w3-native-agent", cwd, maxTurns: 1, enabled: true, canStart: true, canSteer: true };
  const service = new DirectInputService({ store: new PgDirectInputs(pool), runtime: () => native, canWrite: () => true,
    admission: async principal => {
      if (principal.actorId !== actorId) throw new Error("isolated actor mismatch");
      return { grant, binding: reviewBinding };
    }, bindingFor: async () => reviewBinding });
  const command = { inputId: randomUUID(), operationId: randomUUID(),
    content: "Queued from a rejected review steer", expectedTurnId: reviewSteerTurnId };
  const receipt = await service.submit({ actorId, projectIds: [projectId], permissions: ["read", "write"] },
    projectId, sessionId, command);
  assert.equal(receipt.state, "rejected");
  const queued = (await pool.query(`SELECT message_id,operation_id,content,state FROM session_message
    WHERE project_id=$1 AND message_id=$2`, [projectId, command.inputId])).rows;
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.state, "queued");
  assert.equal(queued[0]?.content, command.content);
  (result.cases as Record<string, unknown>).reviewQueue = { receiptState: receipt.state,
    queuedMessageId: command.inputId, queuedState: queued[0]?.state, contentMatches: queued[0]?.content === command.content };

  await native.interruptTurn(reviewBinding, reviewActiveTurnId).catch(() => undefined);
  const output = process.env.LIVE_DIRECT_RESULT ?? join(cwd, "w3-native-result.json");
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ resultPath: output, cases: result.cases }, null, 2));
} finally {
  await native.close();
  await pool.end();
}
