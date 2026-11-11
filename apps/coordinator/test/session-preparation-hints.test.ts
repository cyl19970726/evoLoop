import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sessionPreparationChecklist, sessionPreparationConfigurationCodes, sessionPreparationHints } from "@evoloop/contracts/session-preparation";

const repo=(path:string)=>fileURLToPath(new URL(`../../../${path}`,import.meta.url));
const ids={projectId:"00000000-0000-4000-8000-000000000001",roleId:"00000000-0000-4000-8000-000000000002"};

test("every configuration code has a named key, a fix and when it takes effect; other codes are labelled as state",()=>{
  const all=sessionPreparationHints([...sessionPreparationConfigurationCodes,"role_binding","recovery_blocked"],ids);
  for(const hint of all.slice(0,sessionPreparationConfigurationCodes.length)){
    assert.ok(hint.setting,`${hint.code} names the key to set`);
    assert.notEqual(hint.reread,"not_configuration",hint.code);
    assert.ok(hint.fix.length>20&&hint.problem.length>10,hint.code);
  }
  for(const hint of all.slice(sessionPreparationConfigurationCodes.length)) assert.deepEqual([hint.setting,hint.reread],[null,"not_configuration"]);
  // Only the runtime switch is read once at start; the rest are read again by every `session prepare`.
  assert.deepEqual(all.filter(hint=>hint.reread==="startup").map(hint=>hint.code),["runtime_unavailable"]);
  const mismatch=sessionPreparationHints(["material_cli_actor_mismatch"],{...ids,materialCliActorId:"cli-actor",roleActorId:"queue-actor"})[0]!;
  assert.match(mismatch.problem,/cli-actor/);assert.match(mismatch.problem,/queue-actor/);
});

test("the codes `session prepare` can report are the ones this list covers (checked against the service source)",async()=>{
  const source=await readFile(repo("apps/coordinator/src/server.ts"),"utf8");
  const block=source.slice(source.indexOf("const missing=["),source.indexOf("return {projectId:p.projectId,sessionId:p.sessionId"));
  const codes=new Set([...block.matchAll(/"([a-z][a-z_]+)"/g)].map(match=>match[1]!));
  for(const code of sessionPreparationConfigurationCodes) assert.ok(codes.has(code),`${code} is no longer reported by the service; update the list`);
  assert.ok(codes.has("role_actor")&&codes.has("material_cli")&&codes.has("runtime_grant"),"the block was read");
});

test("the private-configuration checklist is in the docs, and residentQueue.roleActors is in all three places that explain preparation",async()=>{
  const [agentCli,operations,localRun]=await Promise.all(["docs/development/agent-cli.md","docs/development/runtime-operations.md","docs/development/local-run.md"].map(path=>readFile(repo(path),"utf8")));
  for(const item of sessionPreparationChecklist) assert.ok(agentCli!.includes(item.setting),`agent-cli.md lists ${item.setting}`);
  for(const [name,text] of [["agent-cli.md",agentCli],["runtime-operations.md",operations],["local-run.md",localRun]] as const){
    assert.ok(text!.includes("residentQueue.roleActors"),`${name} mentions residentQueue.roleActors`);
    assert.ok(text!.includes("materialCli"),`${name} mentions materialCli`);
  }
  assert.match(agentCli!,/role_actor/,"the docs name the code a blocked preparation reports");
});
