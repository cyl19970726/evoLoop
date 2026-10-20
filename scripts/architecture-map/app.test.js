import test from 'node:test';
import assert from 'node:assert/strict';
import { pageView } from './app.js';

test('fresh reading starts with system meaning while published module links remain direct', () => {
  for (const hash of ['', '#read=loop', '#read=revision', '#read=authority']) assert.equal(pageView(hash), 'reading');
  for (const hash of ['#open=authority&open=core', '#node=sourcebridge', '#mode=ownership', '#journey=correction', '#view=modules'])
    assert.equal(pageView(hash), 'modules');
  assert.equal(pageView('#read=recovery&open=core'), 'reading');
});
