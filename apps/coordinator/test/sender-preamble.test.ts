import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { RuntimeSessionRecord } from '@evoloop/contracts';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';
import type { SessionMessageService } from '@evoloop/core/session-messages';
import { SessionMessagePump } from '../src/session-messages/pump.ts';
import { legacyPreamble, senderPreamble, type SenderClass } from '../src/session-messages/sender.ts';

const claim = "Act within the user's request and project identity";
const projectId = randomUUID();
const session = (id: string): RuntimeSessionRecord => ({ projectId, id, roleId: 'role', cwd: '/tmp/sender', authorizationScope: 'project',
  model: null, sandbox: 'danger-full-access', approvalPolicy: 'never', state: 'ready', version: 1, nativeThreadId: `thread-${id}`,
  nativeSessionId: `native-${id}`, operationId: randomUUID(), actorId: 'receiver', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const message = (target: string): SessionMessageRecord => ({ projectId, id: randomUUID(), operationId: randomUUID(), target: { kind: 'owned', sessionId: target },
  senderActorId: 'sender-1', content: 'Hello', context: null, replyToMessageId: null, state: 'queued', version: 2, blockedReason: null,
  readReceipt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

test('only the user themself is said to be making the user\'s request', () => {
  assert.ok(senderPreamble({ kind: 'user', actorId: 'alice' }).includes(claim));
  for (const kind of ['leader', 'requirements', 'session', 'system', 'unknown'] as const) {
    const text = senderPreamble({ kind, actorId: 'x-1' });
    assert.ok(!text.includes(claim), kind);
    assert.match(text, /x-1/);
    assert.match(text, /not the user's authorization/);
    assert.match(text, /不等于使用者授权；超出你职责的权限交给有权者/);
  }
  assert.match(senderPreamble({ kind: 'leader', actorId: 'l' }), /Leader Session/);
  assert.match(senderPreamble({ kind: 'requirements', actorId: 'r' }), /requirements Session/);
  assert.match(senderPreamble({ kind: 'session', actorId: 's', roleTitle: 'Dev' }), /another managed Session, Role Dev/);
  assert.match(senderPreamble({ kind: 'unknown', actorId: 'u' }), /class is not recorded/);
});

const continued = async (sender: SenderClass | null, hashed: (op: string, m: SessionMessageRecord) => string) => {
  const target = randomUUID(), m = { ...message(target), state: 'unknown' as SessionMessageRecord['state'] }, operationId = randomUUID();
  const expected = hashed(operationId, m);
  const p = { operationId, state: 'unknown', nativeTurnId: null, readOnlyPolicyFingerprint: 'a'.repeat(64),
    preTurnProof: { status: 'approved', inputHash: createHash('sha256').update(expected).digest('hex') } };
  let sent: string | null = null;
  const service = { pending: async () => [m], session: async () => ({ ...session(target), nativeThreadId: target }), processing: async () => p,
    claimPreTurnContinuation: async () => { p.preTurnProof.status = 'attempting'; return p; },
    bindTurn: async () => { p.state = 'running'; p.nativeTurnId = 't'; (m as SessionMessageRecord).state = 'processing'; } } as unknown as SessionMessageService;
  const runtime = { isReady: () => true, registerBinding: async () => {}, qualifyConversationThread: async () => ({ available: true, reason: 'safe', fingerprint: 'a'.repeat(64) }),
    startConversationTurn: async (_b: unknown, text: string) => { sent = text; return { id: 't', status: 'inProgress', completedAtUtc: null }; },
    listTurns: async () => ({ data: [{ id: 't', status: 'inProgress', completedAtUtc: null }], nextCursor: null }), listItems: async () => ({ data: [], nextCursor: null }) };
  const pump = new SessionMessagePump({ service, runtime: () => runtime, projects: async () => [projectId], canStart: async () => true, canWrite: () => true,
    pollIntervalMs: 1000, onError: e => { throw e; }, ...(sender ? { senderClass: async () => sender } : {}) });
  await pump.tick(); await pump.tick();
  return { sent, expected };
};
const line = (opening: string) => (op: string, m: SessionMessageRecord) =>
  `[evoloop-message-operation:${op}]\n${opening} A reply does not by itself record Task delivery or acceptance.\n${m.content}`;

test('the pump opens each message by naming its sender and class', async () => {
  for (const sender of [{ kind: 'user', actorId: 'alice' }, { kind: 'leader', actorId: 'l-1' }, { kind: 'requirements', actorId: 'r-1' },
    { kind: 'session', actorId: 's-1', roleTitle: 'Dev' }, { kind: 'unknown', actorId: 'u-1' }] as SenderClass[]) {
    const { sent, expected } = await continued(sender, line(senderPreamble(sender)));
    assert.equal(sent, expected, sender.kind);
    assert.equal(sent!.includes(claim), sender.kind === 'user', sender.kind);
  }
});

test('without a class resolver the sender is named as unrecorded, never as the user', async () => {
  const unknown: SenderClass = { kind: 'unknown', actorId: 'sender-1' };
  const { sent, expected } = await continued(null, line(senderPreamble(unknown)));
  assert.equal(sent, expected);
  assert.ok(!sent!.includes(claim));
});

test('a continuation refused under the old opening line is sent again with that exact text', async () => {
  const { sent, expected } = await continued({ kind: 'leader', actorId: 'l-1' }, line(legacyPreamble));
  assert.equal(sent, expected);
});
