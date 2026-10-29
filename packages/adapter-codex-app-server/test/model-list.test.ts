import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { CodexAppServerAdapter } from "../src/index.js";

const fixture=resolve(import.meta.dirname,"fixture.mjs");
async function open(mode:string,requestTimeoutMs=500):Promise<CodexAppServerAdapter>{
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
    initializationTimeoutMs:5000,requestTimeoutMs});
  await adapter.open();
  return adapter;
}

test('model/list follows cursors, preserves exact slugs and removes duplicates',async t=>{
  const adapter=await open('model-page');t.after(()=>adapter.close());
  const result=await adapter.listModels();
  assert.deepEqual({status:result.status,models:result.models,error:result.error},
    {status:'available',models:['gpt-6-astra','gpt-6-luna'],error:null});
  assert.ok(Number.isFinite(Date.parse(result.observedAtUtc)));
});

test('model/list caches a result briefly and isolates callers from array mutation',async t=>{
  const adapter=await open('model-cache');t.after(()=>adapter.close());
  const [first,concurrent]=await Promise.all([adapter.listModels(),adapter.listModels()]);
  assert.deepEqual(first.models,['gpt-6-astra-1']);
  assert.deepEqual(concurrent.models,first.models);
  first.models.push('injected');
  const cached=await adapter.listModels();
  assert.deepEqual(cached.models,['gpt-6-astra-1']);
  assert.equal(cached.observedAtUtc,first.observedAtUtc);
});

test('empty model catalog is distinct from failed catalog',async t=>{
  const adapter=await open('model-empty');t.after(()=>adapter.close());
  const result=await adapter.listModels();
  assert.deepEqual({status:result.status,models:result.models,error:result.error},
    {status:'empty',models:[],error:null});
});

test('closed connection reports unavailable without sending a request',async()=>{
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,'model-cache']});
  const result=await adapter.listModels();
  assert.deepEqual({status:result.status,models:result.models,error:result.error},
    {status:'unavailable',models:[],error:'model_list_unavailable'});
});

for(const [mode,code] of [
  ['model-reject','model_list_rejected'],['model-timeout','model_list_timeout'],
  ['model-invalid','model_list_invalid_response'],['model-loop','model_list_incomplete'],
  ['model-overflow','model_list_incomplete'],
] as const){
  test(`${mode} returns safe unavailable state without partial slugs`,async t=>{
    const adapter=await open(mode,mode==='model-timeout'?50:500);t.after(()=>adapter.close());
    const result=await adapter.listModels();
    assert.equal(result.status,'unavailable');
    assert.deepEqual(result.models,[]);
    assert.equal(result.error,code);
    assert.ok(Number.isFinite(Date.parse(result.observedAtUtc)));
    assert.doesNotMatch(JSON.stringify(result),/private token|path/);
  });
}
