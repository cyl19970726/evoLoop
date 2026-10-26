import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { runCli } from '../src/application.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), roleId = id(2), discussionId = id(3), sessionKey = `owned:${id(4)}`;
const env = { EVOLOOP_TOKEN: 'fixture-only', EVOLOOP_PROJECT: projectId, EVOLOOP_API_URL: 'http://127.0.0.1:4318' };
async function invoke(args: string[]) {
  let stdout = '', stderr = '';
  const code = await runCli(args, env, { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  return { code, stdout, stderr };
}

test('named allocation reads request one page and retain reset and metadata without auto-pagination', async () => {
  const seen: string[] = [];
  const serverPage = { items: [], nextCursor: 'opaque-next', resetRequired: true, canonicalSessionKey: sessionKey,
    metadata: { generatedAt: new Date(0).toISOString(), sourceObservedAt: null, partial: false, limitations: ['refresh'] } };
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    seen.push(String(url)); return new Response(JSON.stringify(serverPage), { status: 200 });
  });
  try {
    const role = await invoke(['allocations', '--role', roleId]);
    assert.equal(role.code, 0, role.stderr);
    assert.deepEqual(JSON.parse(role.stdout), serverPage);
    const session = await invoke(['allocations', '--session', sessionKey, '--limit', '5', '--cursor', 'a/b+']);
    assert.equal(session.code, 0, session.stderr);
    const discussion = await invoke(['allocations', '--discussion', discussionId]);
    assert.equal(discussion.code, 0, discussion.stderr);
    assert.equal(seen.length, 3);
    assert.equal(new URL(seen[0]!).pathname + new URL(seen[0]!).search,
      `/api/projects/${projectId}/allocation-relations?roleId=${roleId}&limit=20`);
    assert.equal(new URL(seen[1]!).searchParams.get('sessionKey'), sessionKey);
    assert.equal(new URL(seen[1]!).searchParams.get('cursor'), 'a/b+');
    assert.equal(new URL(seen[1]!).searchParams.get('limit'), '5');
    assert.equal(new URL(seen[2]!).searchParams.get('discussionId'), discussionId);
    const help = JSON.parse((await invoke(['help'])).stdout);
    assert.ok(help.commands.some((line: string) => line.startsWith('allocations ')));
    assert.ok(help.commands.some((line: string) => line.startsWith('list discussions --project')));
  } finally { fetch.mock.restore(); }
});

test('allocation filter mistakes and unrelated list kind fail locally; old discussion list stays unchanged', async () => {
  const seen: string[] = [];
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    seen.push(String(url)); return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  });
  try {
    for (const args of [
      ['allocations'], ['allocations', '--role', roleId, '--discussion', discussionId],
      ['allocations', '--session', `desktop:${id(4)}`], ['allocations', '--role', 'bad'],
      ['allocations', '--role', roleId, '--limit', '51'], ['allocations', '--role', roleId, '--kind', 'allocation'],
      ['list', 'tasks', '--kind', 'allocation'], ['list', 'discussions', '--kind', 'other'],
      ['list', 'loops', '--kind', 'allocation'], ['list', 'dispatches', '--loop', id(9), '--kind', 'direction'],
    ]) {
      const result = await invoke(args);
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
    }
    assert.equal(seen.length, 0);
    const filtered = await invoke(['list', 'discussions', '--kind', 'allocation', '--limit', '5']);
    assert.equal(filtered.code, 0, filtered.stderr);
    assert.equal(new URL(seen[0]!).pathname + new URL(seen[0]!).search,
      `/api/projects/${projectId}/discussions?kind=allocation&limit=5`);
    const original = await invoke(['list', 'discussions']);
    assert.equal(original.code, 0, original.stderr);
    assert.equal(new URL(seen[1]!).pathname + new URL(seen[1]!).search,
      `/api/projects/${projectId}/discussions`);
  } finally { fetch.mock.restore(); }
});
