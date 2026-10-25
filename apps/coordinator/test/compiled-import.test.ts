import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const isolatedEnv={PATH:process.env.PATH??'',HOME:process.env.HOME??'',NODE_OPTIONS:''};

test('compiled core and coordinator dependencies import under plain Node',()=>{
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    `await import('@evoloop/core');
     await import('./apps/coordinator/dist/server.js');
     await import('./apps/coordinator/dist/resident-queue/pump.js');`],{
    cwd:root,encoding:'utf8',env:isolatedEnv,timeout:5_000,
  });
  assert.equal(child.status,0,child.stderr||child.error?.message);
});

test('compiled production entry loads its dependency graph before requiring configuration',()=>{
  const child=spawnSync(process.execPath,['apps/coordinator/dist/main.js'],{
    cwd:root,encoding:'utf8',env:isolatedEnv,timeout:5_000,
  });
  assert.equal(child.error,undefined,child.error?.message);
  assert.equal(child.signal,null,'production entry must exit without hanging');
  assert.equal(child.status,1,child.stderr);
  assert.ok(child.stderr.includes('Error: Set EVOLOOP_DATABASE_URL and EVOLOOP_AUTH_FILE. Run migrations separately before starting.'),
    child.stderr);
});
