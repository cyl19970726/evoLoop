import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const exec = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const run = async (name, args) => (await exec(name, args, {
  timeout: 5000, maxBuffer: 512 * 1024, env: { ...process.env, LC_ALL: 'C' },
})).stdout;

export function uniqueListener(output) {
  const pids = [...new Set([...output.matchAll(/^p(\d+)\s*$/gm)].map(match => Number(match[1])))];
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] < 1) fail('LISTENER_NOT_UNIQUE');
  return pids[0];
}

export function directChildren(output, parentPid) {
  const children = [];
  for (const line of output.split(/\r?\n/)) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (row && Number(row[2]) === parentPid) children.push({ pid: Number(row[1]), comm: row[3] });
  }
  return children;
}

async function processIdentity(pid, probe) {
  const pair = (await probe('ps', ['-p', String(pid), '-o', 'pid=', '-o', 'ppid='])).trim().split(/\s+/);
  const startIdentity = (await probe('ps', ['-p', String(pid), '-o', 'lstart='])).trim().replace(/\s+/g, ' ');
  const state = (await probe('ps', ['-p', String(pid), '-o', 'stat='])).trim();
  const comm = (await probe('ps', ['-p', String(pid), '-o', 'comm='])).trim();
  if (pair.length !== 2 || Number(pair[0]) !== pid || !Number.isSafeInteger(Number(pair[1])) ||
    !startIdentity || startIdentity.length > 240 || !Number.isFinite(Date.parse(startIdentity)) ||
    !state || state.startsWith('Z') || !comm) fail('PROCESS_IDENTITY_UNVERIFIED');
  return { pid, ppid: Number(pair[1]), startIdentity, comm: basename(comm) };
}

/** No PID input is accepted: the listener and its unique direct app-server child are OS discoveries. */
export async function discoverOriginalOwner(port, probe = run) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('LISTEN_PORT_INVALID');
  const coordinatorPid = uniqueListener(await probe('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']));
  if (coordinatorPid === process.pid) fail('CAPTURE_PROCESS_IS_LISTENER');
  const children = directChildren(await probe('ps', ['-axo', 'pid=,ppid=,comm=']), coordinatorPid);
  const natives = [];
  for (const child of children) {
    if (basename(child.comm) !== 'codex') continue;
    const command = await probe('ps', ['-p', String(child.pid), '-o', 'command=']);
    if (/\bapp-server\b/.test(command) && /--stdio\b/.test(command)) natives.push(child.pid);
  }
  if (natives.length !== 1) fail('NATIVE_CHILD_NOT_UNIQUE_OR_NOT_DIRECT');
  const [coordinator, native] = await Promise.all([
    processIdentity(coordinatorPid, probe), processIdentity(natives[0], probe),
  ]);
  if (native.ppid !== coordinator.pid || native.pid === coordinator.pid || native.comm !== 'codex')
    fail('NATIVE_CHILD_ANCESTRY_UNVERIFIED');
  return { coordinator, native, listenPort: port };
}

function sameOwner(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function requiredOptions(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || values.has(argv[i])) fail('ARGUMENTS_INVALID');
    values.set(argv[i], argv[i + 1]);
  }
  const allowed = ['--listen-port', '--project', '--session', '--message', '--processing', '--turn', '--out'];
  if (values.size !== allowed.length || [...values.keys()].some(key => !allowed.includes(key))) fail('ARGUMENTS_INVALID');
  for (const key of ['--project', '--session', '--message', '--processing'])
    if (!id.test(values.get(key) ?? '')) fail('IDENTITY_INVALID');
  const port = Number(values.get('--listen-port'));
  const turn = values.get('--turn');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !turn || turn.length > 256) fail('IDENTITY_INVALID');
  return { port, projectId: values.get('--project'), sessionId: values.get('--session'),
    messageId: values.get('--message'), processingId: values.get('--processing'), nativeTurnId: turn,
    out: values.get('--out') };
}

async function privateOutput(path) {
  if (!isAbsolute(path)) fail('PRIVATE_OUTPUT_REQUIRED');
  const parent = await realpath(dirname(path));
  const repo = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const info = await stat(parent);
  if (parent === repo || parent.startsWith(repo + sep) || !info.isDirectory() ||
    info.uid !== process.getuid() || (info.mode & 0o077) !== 0) fail('PRIVATE_OUTPUT_REQUIRED');
  return path;
}

function databaseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail('LOCAL_DATABASE_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.port || parsed.search || parsed.hash)
    fail('LOCAL_DATABASE_REQUIRED');
  return value;
}

/** The old service confirms the Root actor using its existing session endpoint. */
export async function authenticatedRoot(projectId, port, fetcher = fetch) {
  const token = process.env.PREFLIGHT_ROOT_TOKEN;
  const expected = process.env.PREFLIGHT_ROOT_ACTOR_ID;
  if (!token || !expected) fail('ROOT_IDENTITY_REQUIRED');
  let reply, value;
  try {
    reply = await fetcher(`http://127.0.0.1:${port}/api/session`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!reply.ok) fail('ROOT_IDENTITY_UNVERIFIED');
    value = await reply.json();
  } catch { fail('ROOT_IDENTITY_UNVERIFIED'); }
  const principal = value?.principal;
  if (principal?.actorId !== expected || !principal?.projectIds?.includes(projectId) ||
    !principal?.permissions?.includes('review')) fail('ROOT_IDENTITY_UNVERIFIED');
  return expected;
}

/** The listening PID must own a TCP socket whose client port holds this database's coordinator lock. */
export async function proveDatabaseLease(client, coordinatorPid, probe = run) {
  const locks = (await client.query(`SELECT host(a.client_addr) AS client_addr,a.client_port,
      host(inet_server_addr()) AS server_addr,inet_server_port() AS server_port
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.classid=0::oid AND l.objid=731209842::oid
      AND l.objsubid=1 AND l.mode='ExclusiveLock' AND l.granted`)).rows;
  if (locks.length !== 1 || !['127.0.0.1', '::1'].includes(locks[0].client_addr) ||
    !['127.0.0.1', '::1'].includes(locks[0].server_addr) ||
    !Number.isInteger(locks[0].client_port) || locks[0].client_port < 1 ||
    !Number.isInteger(locks[0].server_port) || locks[0].server_port < 1)
    fail('DATABASE_OWNER_LEASE_UNVERIFIED');
  const sockets = await probe('lsof', ['-nP', '-a', '-p', String(coordinatorPid), '-iTCP', '-Fn']);
  const matches = [...sockets.matchAll(/^n(127\.0\.0\.1|\[::1\]):(\d+)->(127\.0\.0\.1|\[::1\]):(\d+)\s*$/gm)];
  const address = value => value === '[::1]' ? '::1' : value;
  if (!matches.some(match => address(match[1]) === locks[0].client_addr &&
    Number(match[2]) === locks[0].client_port &&
    address(match[3]) === locks[0].server_addr &&
    Number(match[4]) === locks[0].server_port)) fail('DATABASE_OWNER_LEASE_UNVERIFIED');
  return {clientAddr:locks[0].client_addr,clientPort:locks[0].client_port,
    serverAddr:locks[0].server_addr,serverPort:locks[0].server_port};
}

/** The old service must independently return the same saved original, using its own DB connection. */
export async function confirmServiceOriginal(options, fetcher = fetch) {
  let reply,value;
  try {
    reply=await fetcher(`http://127.0.0.1:${options.port}/api/projects/${options.projectId}/session-messages/${options.messageId}`,{
      headers:{Authorization:`Bearer ${process.env.PREFLIGHT_ROOT_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(5000),
    });
    if(!reply.ok)fail('SERVICE_ORIGINAL_UNVERIFIED');
    value=await reply.json();
  }catch{fail('SERVICE_ORIGINAL_UNVERIFIED');}
  if(value?.message?.id!==options.messageId || value?.message?.target?.kind!=='owned' ||
    value.message.target.sessionId!==options.sessionId || value?.processing?.id!==options.processingId ||
    value.processing.nativeTurnId!==options.nativeTurnId)
    fail('SERVICE_ORIGINAL_UNVERIFIED');
}

/** A read-only OS probe plus one append-only DB insert. Does not stop or signal processes. */
export async function capturePreflight(options, { probe = run, identify = authenticatedRoot,
  confirm = confirmServiceOriginal, connect = () => new pg.Client({
  connectionString: databaseUrl(process.env.PREFLIGHT_DATABASE_URL), connectionTimeoutMillis: 5000,
  query_timeout: 5000, statement_timeout: 5000,
}) } = {}) {
  const out = await privateOutput(options.out);
  const client = connect();
  await client.connect();
  let began = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); began = true;
    const row = (await client.query(`SELECT s.native_thread_id,s.native_session_id,s.state AS session_state,
        m.state AS message_state,m.version AS message_version,p.state AS processing_state,
        p.version AS processing_version,p.failure,p.native_turn_id,
        clock_timestamp() AS db_observed_at
      FROM runtime_session s JOIN session_message m ON m.project_id=s.project_id AND m.session_id=s.session_id
      JOIN session_message_processing p ON p.project_id=m.project_id AND p.message_id=m.message_id
      WHERE s.project_id=$1 AND s.session_id=$2 AND m.message_id=$3 AND p.processing_id=$4
        AND p.native_turn_id=$5 AND m.target_kind='owned' FOR SHARE OF s,m,p`,
      [options.projectId,options.sessionId,options.messageId,options.processingId,options.nativeTurnId])).rows[0];
    if (!row || row.session_state !== 'ready' || !row.native_thread_id || !row.native_session_id ||
      !['processing','unknown'].includes(row.message_state) || !['running','unknown'].includes(row.processing_state))
      fail('ORIGINAL_BINDING_NOT_ACTIVE');
    const owner = await discoverOriginalOwner(options.port, probe);
    const databaseLease=await proveDatabaseLease(client,owner.coordinator.pid,probe);
    const capturedByActorId = await identify(options.projectId, options.port);
    await confirm(options);
    const preflightId = randomUUID();
    const evidence = { format: 'evoloop-message-preflight-v1', preflightId,
      host: hostname(), capturedByActorId, projectId: options.projectId, sessionId: options.sessionId,
      threadId: row.native_thread_id, nativeSessionId: row.native_session_id,
      messageId: options.messageId, processingId: options.processingId, nativeTurnId: options.nativeTurnId,
      messageVersion: row.message_version, processingVersion: row.processing_version,databaseLease,
      dbObservedAt: row.db_observed_at.toISOString(), osObservedAt: new Date().toISOString(),
      oldCoordinator: { pid: owner.coordinator.pid, startIdentity: owner.coordinator.startIdentity },
      oldNative: { pid: owner.native.pid, startIdentity: owner.native.startIdentity,
        parentPid: owner.native.ppid }, listenPort: owner.listenPort };
    const evidenceJson = JSON.stringify(evidence), evidenceHash = sha(evidenceJson);
    const captureFile = { ...evidence, preStopObservedAt: evidence.osObservedAt,
      preStopEvidence: evidence, preStopEvidenceHash: evidenceHash };
    const fileBytes = Buffer.from(JSON.stringify(captureFile, null, 2) + '\n');
    if (fileBytes.length > 128 * 1024) fail('CAPTURE_TOO_LARGE');
    if (!sameOwner(owner, await discoverOriginalOwner(options.port, probe))) fail('PROCESS_IDENTITY_CHANGED');
    const file = await open(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(fileBytes); await file.sync(); } finally { await file.close(); }
    const inserted = await client.query(`INSERT INTO session_message_manual_stop_preflight(
      project_id,message_id,preflight_id,processing_id,session_id,native_turn_id,native_thread_id,
      message_version,processing_version,host,captured_by_actor_id,listen_port,old_coordinator_pid,old_coordinator_start_identity,
      old_native_pid,old_native_start_identity,pre_stop_evidence_json,pre_stop_evidence_hash,
      capture_file_ref,capture_file_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING captured_at`,
      [options.projectId,options.messageId,preflightId,options.processingId,options.sessionId,
        options.nativeTurnId,row.native_thread_id,row.message_version,row.processing_version,
        evidence.host,capturedByActorId,owner.listenPort,owner.coordinator.pid,owner.coordinator.startIdentity,
        owner.native.pid,owner.native.startIdentity,evidenceJson,evidenceHash,out,sha(fileBytes)]);
    if (!sameOwner(owner, await discoverOriginalOwner(options.port, probe))) fail('PROCESS_IDENTITY_CHANGED');
    await client.query('COMMIT'); began = false;
    return { preflightId, projectId: options.projectId, messageId: options.messageId,
      capturedAt: inserted.rows[0].captured_at.toISOString(), captureFileRef: out,
      captureFileHash: sha(fileBytes), preStopEvidenceHash: evidenceHash };
  } catch (error) {
    if (began) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help')) {
      process.stdout.write('PREFLIGHT_DATABASE_URL=postgres://... PREFLIGHT_ROOT_TOKEN=... PREFLIGHT_ROOT_ACTOR_ID=... node scripts/capture-session-message-preflight.mjs --listen-port PORT --project UUID --session UUID --message UUID --processing UUID --turn ID --out /PRIVATE/NEW.json\n');
    } else {
      const result = await capturePreflight(requiredOptions(process.argv.slice(2)));
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.code ?? 'CAPTURE_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
