import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authenticatedRoot, capturePreflight, confirmServiceOriginal, directChildren,
  discoverOriginalOwner, proveDatabaseLease, uniqueListener } from './capture-session-message-preflight.mjs';

const start = 'Tue Oct 27 16:18:54 2026';
function probe({ children = '123 1 /usr/local/bin/node\n456 123 /opt/homebrew/bin/codex\n',
  listener = 'p123\nn127.0.0.1:4318\n',socket='n127.0.0.1:56000->127.0.0.1:55461\n',
  nativeParent = 123 } = {}) {
  return async (name, args) => {
    if (name === 'lsof') return args.includes('-a') ? socket : listener;
    if (args[0] === '-axo') return children;
    const pid = Number(args[1]), field = args.at(-1);
    if (field === 'command=') return '/opt/homebrew/bin/codex app-server --stdio\n';
    if (field === 'ppid=') return `${pid} ${pid === 456 ? nativeParent : 1}\n`;
    if (field === 'lstart=') return start + '\n';
    if (field === 'stat=') return 'S\n';
    if (field === 'comm=') return pid === 456 ? '/opt/homebrew/bin/codex\n' : '/usr/local/bin/node\n';
    throw new Error(`Unexpected probe ${name} ${args.join(' ')}`);
  };
}

test('discovers one listening coordinator and its direct Codex app-server child from OS rows', async () => {
  assert.equal(uniqueListener('p123\nn127.0.0.1:4318\n'), 123);
  assert.deepEqual(directChildren('456 123 /opt/homebrew/bin/codex\n', 123),
    [{ pid: 456, comm: '/opt/homebrew/bin/codex' }]);
  const owner = await discoverOriginalOwner(4318, probe());
  assert.equal(owner.coordinator.pid, 123);
  assert.equal(owner.native.pid, 456);
  assert.equal(owner.native.ppid, 123);
  assert.equal(owner.native.startIdentity, start);
});

test('rejects ambiguous listeners, multiple native children and an orphaned native process', async () => {
  assert.throws(() => uniqueListener('p123\np124\n'), /LISTENER_NOT_UNIQUE/);
  await assert.rejects(discoverOriginalOwner(4318, probe({
    children: '123 1 /usr/local/bin/node\n456 123 /opt/homebrew/bin/codex\n457 123 /opt/homebrew/bin/codex\n',
  })), /NATIVE_CHILD_NOT_UNIQUE_OR_NOT_DIRECT/);
  await assert.rejects(discoverOriginalOwner(4318, probe({ nativeParent: 1 })),
    /NATIVE_CHILD_ANCESTRY_UNVERIFIED/);
  await assert.rejects(discoverOriginalOwner(4318, probe({
    children: '123 1 /usr/local/bin/node\n456 1 /opt/homebrew/bin/codex\n',
  })), /NATIVE_CHILD_NOT_UNIQUE_OR_NOT_DIRECT/);
});

test('Root identity comes from the old service response and cannot be self-declared', async () => {
  const previousToken = process.env.PREFLIGHT_ROOT_TOKEN;
  const previousActor = process.env.PREFLIGHT_ROOT_ACTOR_ID;
  process.env.PREFLIGHT_ROOT_TOKEN = 'private-test-token';
  process.env.PREFLIGHT_ROOT_ACTOR_ID = 'root-actor';
  const projectId = '00000000-0000-4000-8000-000000000001';
  try {
    const reply = principal => async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:4318/api/session');
      assert.equal(options.headers.Authorization, 'Bearer private-test-token');
      return { ok: true, json: async () => ({ principal }) };
    };
    assert.equal(await authenticatedRoot(projectId, 4318, reply({
      actorId: 'root-actor', projectIds: [projectId], permissions: ['read', 'review'],
    })), 'root-actor');
    await assert.rejects(authenticatedRoot(projectId, 4318, reply({
      actorId: 'reviewer', projectIds: [projectId], permissions: ['read', 'review'],
    })), /ROOT_IDENTITY_UNVERIFIED/);
  } finally {
    if (previousToken === undefined) delete process.env.PREFLIGHT_ROOT_TOKEN;
    else process.env.PREFLIGHT_ROOT_TOKEN = previousToken;
    if (previousActor === undefined) delete process.env.PREFLIGHT_ROOT_ACTOR_ID;
    else process.env.PREFLIGHT_ROOT_ACTOR_ID = previousActor;
  }
});

test('listener must hold the exact target database coordinator lease and serve the original message',async()=>{
  const database={query:async()=>({rows:[{client_addr:'127.0.0.1',client_port:56000,
    server_addr:'127.0.0.1',server_port:55461}]})};
  await proveDatabaseLease(database,123,probe());
  await assert.rejects(proveDatabaseLease(database,123,probe({socket:'n127.0.0.1:56001->127.0.0.1:55461\n'})),
    /DATABASE_OWNER_LEASE_UNVERIFIED/);
  await assert.rejects(proveDatabaseLease(database,123,probe({socket:'n[::1]:56000->[::1]:55461\n'})),
    /DATABASE_OWNER_LEASE_UNVERIFIED/);
  const original={port:4318,projectId:'project',sessionId:'session',messageId:'message',
    processingId:'processing',nativeTurnId:'turn'};
  const fetcher=async()=>({ok:true,json:async()=>({message:{id:'message',target:{kind:'owned',sessionId:'session'}},
    processing:{id:'processing',nativeTurnId:'turn'}})});
  await confirmServiceOriginal(original,fetcher);
  await assert.rejects(confirmServiceOriginal({...original,processingId:'other'},fetcher),/SERVICE_ORIGINAL_UNVERIFIED/);
});

test('capture binds OS discovery to the exact locked DB original and writes a private hashed anchor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evoloop-preflight-test-'));
  const out = join(directory, 'capture.json');
  const projectId = '00000000-0000-4000-8000-000000000001';
  const sessionId = '00000000-0000-4000-8000-000000000002';
  const messageId = '00000000-0000-4000-8000-000000000003';
  const processingId = '00000000-0000-4000-8000-000000000004';
  const nativeTurnId = 'original-turn';
  const calls = [];
  const client = {
    connect: async () => {}, end: async () => {},
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('FROM pg_locks')) return {rows:[{client_addr:'127.0.0.1',client_port:56000,
        server_addr:'127.0.0.1',server_port:55461}]};
      if (sql.startsWith('SELECT')) return { rows: [{ native_thread_id: 'original-thread',
        native_session_id: 'original-native-session', session_state: 'ready', message_state: 'unknown',
        message_version: 3, processing_state: 'unknown', processing_version: 4,
        db_observed_at: new Date('2026-11-03T03:00:00Z') }] };
      if (sql.startsWith('INSERT')) return { rows: [{ captured_at: new Date('2026-11-03T03:00:01Z') }] };
      return { rows: [] };
    },
  };
  try {
    const result = await capturePreflight({ out, port: 4318, projectId, sessionId,
      messageId, processingId, nativeTurnId }, {
      probe: probe(), identify: async () => 'root-actor', confirm:async()=>{},connect: () => client,
    });
    const bytes = await readFile(out);
    const saved = JSON.parse(bytes.toString());
    const digest = value => createHash('sha256').update(value).digest('hex');
    assert.equal(saved.oldCoordinator.pid, 123);
    assert.equal(saved.oldNative.parentPid, 123);
    assert.equal(saved.capturedByActorId, 'root-actor');
    assert.equal(result.captureFileHash, digest(bytes));
    assert.equal(result.preStopEvidenceHash, digest(JSON.stringify(saved.preStopEvidence)));
    assert.equal(calls.filter(call => call.sql.startsWith('INSERT')).length, 1);
    assert.equal(calls.at(-1).sql, 'COMMIT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
