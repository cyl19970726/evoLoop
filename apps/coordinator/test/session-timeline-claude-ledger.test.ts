import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeAgentSdkAdapter } from '@evoloop/adapter-claude-agent-sdk';
import type { Principal, RuntimeSessionRecord } from '@evoloop/contracts';
import type { NativeInputSource } from '@evoloop/contracts/native-input';
import type { RuntimeBinding } from '@evoloop/contracts/runtime';
import type { SessionMessageProcessing, SessionMessageRecord } from '@evoloop/contracts/session-messages';
import { DomainError } from '@evoloop/contracts/ports';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import type { SessionObservationService } from '@evoloop/core/session-observation';
import { SessionTimelineService, type WorkspaceHistoryOwner } from '../src/session-timeline/index.js';

/**
 * M3 acceptance sample: a Claude Session's timeline now reads the adapter ledger. A person's message, a Run dispatch
 * input and both replies must each show once, linked to their saved business source, with nothing duplicated or lost.
 */
const fake = fileURLToPath(new URL('../../../packages/adapter-claude-agent-sdk/test/fake-claude.mjs', import.meta.url));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const project = id(1), sessionId = id(2), key = `owned:${sessionId}`, now = '2026-11-11T00:00:00.000Z';
const reader: Principal = { actorId: 'reader', projectIds: [project], permissions: ['read'] };

async function settle(adapter: ClaudeAgentSdkAdapter, binding: RuntimeBinding, turnId: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const turn = (await adapter.listTurns(binding)).data.find(candidate => candidate.id === turnId);
    if (turn?.completedAtUtc) return;
    if (Date.now() > deadline) throw new Error('Turn did not settle');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('Claude ledger timeline shows a person\'s message, a Run input and their replies once, each linked to its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evoloop-claude-timeline-'));
  const cwd = join(root, 'work'); await mkdir(cwd);
  const adapter = new ClaudeAgentSdkAdapter({ configDir: join(root, 'config'), executable: fake, startTimeoutMs: 15_000,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_CLAUDE_MODE: 'thinking', FAKE_CLAUDE_ANSWER_BLOCK: '1' },
    envPassthrough: ['FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_ANSWER_BLOCK'],
    verifyBinding: async () => true });
  await adapter.open();
  try {
    const binding = await adapter.create({ actorId: 'agent', sessionId, roleId: 'role', projectId: project, cwd,
      authorizationScope: 'project', sandbox: 'danger-full-access', approvalPolicy: 'never' });
    const messageOp = randomUUID(), runOp = randomUUID(), messageId = id(10), runId = id(30), taskId = id(40);
    const first = await adapter.startTurn(binding, `[evoloop-message-operation:${messageOp}]\nPlease check the build`, messageOp);
    await settle(adapter, binding, first.id);
    const second = await adapter.startTurn(binding, `[evoloop-run-operation:${runOp}]\nPrivate dispatch envelope`, runOp);
    await settle(adapter, binding, second.id);

    const message: SessionMessageRecord = { projectId: project, id: messageId, operationId: id(110), target: { kind: 'owned', sessionId },
      senderActorId: 'human-a', content: 'Please check the build', context: null, replyToMessageId: null, state: 'replied', version: 1,
      blockedReason: null, readReceipt: null, createdAt: now, updatedAt: now };
    const processing: SessionMessageProcessing = { projectId: project, id: id(111), messageId, sessionId, operationId: messageOp,
      state: 'completed', nativeTurnId: first.id, response: 'done: reply', failure: null, version: 1, startedAt: now, updatedAt: now };
    const sources = new Map<string, NativeInputSource>([
      [first.id, { kind: 'message', messageId, processingId: processing.id, operationId: messageOp, actorId: 'human-a' }],
      [second.id, { kind: 'run', runId, operationId: runOp, actorId: 'leader', taskId, taskRevisionId: id(41) }]]);
    const session = { projectId: project, id: sessionId, roleId: 'role', cwd, authorizationScope: 'project', model: null,
      sandbox: 'danger-full-access', approvalPolicy: 'never', state: 'ready', version: 1, nativeThreadId: binding.nativeThreadId,
      nativeSessionId: binding.nativeSessionId, operationId: id(99), actorId: 'agent', createdAt: now, updatedAt: now } as RuntimeSessionRecord;
    const uow = { read: async (_p: string, fn: (r: unknown) => Promise<unknown>) => fn({
      getRuntimeSession: async () => session,
      nativeObservation: { get: async () => null },
      nativeInputs: { findSources: async (_p: string, _s: string, turnIds: string[]) =>
        new Map(turnIds.flatMap(turnId => sources.has(turnId) ? [[turnId, sources.get(turnId)!] as const] : [])) },
      sessionMessages: { listSessionMessages: async () => ({ items: [message], nextCursor: null }),
        listSessionMessageProcessing: async (ids: string[]) => ids.includes(messageId) ? [processing] : [],
        getSessionMessages: async (ids: string[]) => ids.includes(messageId) ? [message] : [] },
    }) } as unknown as UnitOfWork;
    const observation = { snapshot: async (p: Principal) => {
      if (!p.projectIds.includes(project)) throw new DomainError('FORBIDDEN', 'scope');
      return { session: { key, target: { kind: 'owned', sessionId }, title: 'Claude dev' } };
    } } as unknown as SessionObservationService;
    const runner = { workspaceBinding: async () => binding,
      workspaceHistory: (_p: Principal, _project: string, _session: string, options: object) => adapter.readWorkspaceHistory(binding, options),
      onWorkspaceUpdate: () => () => {}, onWorkspaceDisconnect: () => () => {},
      nativeAdapter: () => ({ readWorkspaceHistory: adapter.readWorkspaceHistory.bind(adapter) }), status: () => ({ available: true }) } as unknown as WorkspaceHistoryOwner;
    const timeline = new SessionTimelineService({ uow, observation, runner });
    try {
      const page = await timeline.page(reader, project, key, { limit: 50 });
      assert.equal(page.capabilities.history, true);
      const ids = page.entries.map(entry => entry.id);
      assert.equal(new Set(ids).size, ids.length, 'no entry is repeated');

      const inputs = page.entries.filter(entry => entry.kind === 'message' && entry.role === 'input');
      assert.equal(inputs.length, 2, 'both inputs show, as messages rather than unverified notices');
      const human = inputs.find(entry => entry.turnId === first.id)!;
      assert.ok(human.kind === 'message' && human.body === 'Please check the build');
      assert.deepEqual([human.author.kind, human.author.id, human.origin?.kind, human.origin?.id], ['actor', 'human-a', 'message', messageId]);
      const dispatched = inputs.find(entry => entry.turnId === second.id)!;
      assert.ok(dispatched.kind === 'message' && dispatched.body === '项目派发任务', 'the dispatch envelope is not shown');
      assert.deepEqual([dispatched.origin?.kind, dispatched.origin?.id, dispatched.origin?.taskId], ['run', runId, taskId]);
      assert.doesNotMatch(JSON.stringify(page), /Private dispatch envelope/);

      for (const turn of [first.id, second.id]) {
        const replies = page.entries.filter(entry => entry.turnId === turn && entry.kind === 'message' && entry.role === 'assistant' && entry.phase === 'final_answer');
        assert.equal(replies.length, 1, 'each Turn has exactly one reply');
        // Like the real CLI, the answer was streamed as a text block and repeated as the result: the same text shows once.
        const bodies = page.entries.filter(entry => entry.turnId === turn && entry.kind === 'message' && entry.role === 'assistant')
          .map(entry => entry.kind === 'message' ? entry.body : '');
        assert.equal(bodies.filter(body => body === replies[0]!.body).length, 1, 'the reply text appears once in the Turn');
        assert.equal(new Set(bodies).size, bodies.length, 'no assistant text is repeated within a Turn');
        assert.deepEqual([replies[0]!.author.kind, replies[0]!.author.id], ['session', sessionId]);
        assert.ok(page.entries.some(entry => entry.turnId === turn && entry.kind === 'reasoning'));
      }
      assert.ok(!page.entries.some(entry => entry.id.startsWith('message-response:')), 'the saved reply is not shown a second time');
      assert.deepEqual(page.pending, [], 'the shown message is not also left pending');
    } finally { timeline.close(); }
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});
