import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { runCli } from '../src/application.ts';

const projectId = '00000000-0000-4000-8000-000000000001';
const env = { EVOLOOP_TOKEN: 'fixture-only', EVOLOOP_PROJECT: projectId, EVOLOOP_API_URL: 'http://127.0.0.1:4318' };
async function invoke(args: string[]) {
  let stdout = '', stderr = '';
  const code = await runCli(args, env, { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  return { code, stdout, stderr };
}

test('list documents sends the type, status and title search to the server and keeps an opaque cursor', async () => {
  const seen: string[] = [];
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => { seen.push(String(url)); return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }); });
  try {
    const result = await invoke(['list', 'documents', '--kind', 'brief', '--status', 'active', '--search', '每日简报', '--limit', '5', '--cursor', 'eyJ2IjoxfQ']);
    assert.equal(result.code, 0, result.stderr);
    const url = new URL(seen[0]!);
    assert.deepEqual([url.searchParams.get('kind'), url.searchParams.get('status'), url.searchParams.get('search'), url.searchParams.get('limit'), url.searchParams.get('cursor')],
      ['brief', 'active', '每日简报', '5', 'eyJ2IjoxfQ']);
    const help = JSON.parse((await invoke(['help'])).stdout);
    assert.ok(help.commands.some((line: string) => line.startsWith('list documents --project') && line.includes('brief')));
  } finally { fetch.mock.restore(); }
});

test('an unknown document type or a search on another list is refused before any request', async () => {
  const seen: string[] = [];
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => { seen.push(String(url)); return new Response('{}', { status: 200 }); });
  try {
    assert.equal((await invoke(['list', 'documents', '--kind', 'digest'])).code, 2);
    assert.equal((await invoke(['list', 'tasks', '--search', 'x'])).code, 2);
    assert.equal((await invoke(['list', 'documents', '--search', ' '])).code, 2);
    assert.deepEqual(seen, []);
  } finally { fetch.mock.restore(); }
});
