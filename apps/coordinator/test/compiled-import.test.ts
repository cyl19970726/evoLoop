import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root=fileURLToPath(new URL('../../../',import.meta.url));

test('compiled core and coordinator dependencies import under plain Node',()=>{
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    `await import('@evoloop/core');
     await import('./apps/coordinator/dist/server.js');
     await import('./apps/coordinator/dist/resident-queue/pump.js');`],{
    cwd:root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:''},
  });
  assert.equal(child.status,0,child.stderr||child.error?.message);
});
