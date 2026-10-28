import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { BasisSet, RuntimeRunRecord, TaskRevision } from "@evoloop/contracts";
import { buildLightweightInput } from "../src/runtime/lightweight-input.js";
import { runInputPage } from "../src/runtime/input-read.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("v2 queue handoff is readable Markdown with one fixed first read and no repeated Task body", () => {
  const projectId=randomUUID(),taskId=randomUUID(),taskRevisionId=randomUUID(),basisSetId=randomUUID();
  const documentId=randomUUID(),revisionId=randomUUID(),runId=randomUUID(),channelId=randomUUID();
  const content="# Fix the actual handoff\n\nShow the goal clearly.\n\n## Long evidence\n"+"Do not lose the final boundary. ".repeat(600);
  const input=JSON.stringify({protocol:"evoloop-run-v2",taskId,taskRevisionId,basisSetId,kind:"queue.continue",
    reason:"Cover the missing case",previousRun:{id:randomUUID(),taskRevisionId:randomUUID(),inputHash:hash("old")},
    answers:[],channel:{discussionId:channelId,recipientActorId:"recipient",issuerActorId:"lead"}});
  const run={projectId,id:runId,taskId,taskRevisionId,basisSetId,sessionId:randomUUID(),operationId:randomUUID(),
    input,inputHash:hash(input)} as RuntimeRunRecord;
  const revision={projectId,taskId,id:taskRevisionId,title:"Fix the handoff",content,contentDocumentId:documentId,
    contentRevisionId:revisionId,acceptance:"Full acceptance"} as TaskRevision;
  const basis={id:basisSetId,taskRevisionId,members:[{documentId,revisionId}]} as BasisSet;
  const documents=[{documentId,revisionId,contentHash:hash(content),format:"markdown",mediaType:"text/markdown",
    bodyBytes:Buffer.byteLength(content),assetCount:0,assetBytes:0}];
  const packet=buildLightweightInput(run,revision,basis,documents,
    {command:"/private/bound-cli",actorId:"recipient"},
    {roleId:randomUUID(),revisionId:randomUUID(),skills:[{path:".agents/skills/evoloop-workflow/SKILL.md",
      commit:"a".repeat(40),contentHash:"b".repeat(64)}]},
    {projectId,taskId,taskRevisionId,stageId:null,acceptanceMode:"independent_agent",consumer:"",
      useRequired:true,evidence:"",stopCondition:"",createdAt:"2026-10-29T00:00:00.000Z"});
  assert.equal(packet.protocol,"evoloop-markdown-v2");
  assert.match(packet.input,/^\[evoloop-run-operation:/);
  assert.match(packet.input,/# 任务：Fix the handoff/);
  assert.match(packet.input,/Show the goal clearly/);
  assert.match(packet.input,new RegExp(`/private/bound-cli handoff ${runId} --project ${projectId} --hash ${run.inputHash}`));
  assert.match(packet.input,/Cover the missing case/);
  assert.match(packet.input,/验收方式：不同 Agent 实际使用；指定消费者：未指定/);
  assert.match(packet.input,new RegExp(channelId));
  assert.match(packet.input,/roles\/[0-9a-f-]+\/revisions\/[0-9a-f-]+/);
  assert.match(packet.input,/skills\/evoloop-workflow\?commit=/);
  assert.doesNotMatch(packet.input,/skill body or private credential/);
  assert.doesNotMatch(packet.input,/Do not lose the final boundary|"taskPreview"|"runInstructionExactInline"/);
  assert.ok(packet.byteLength<3500);
  assert.throws(()=>buildLightweightInput(run,revision,basis,documents),/CLI_ENTRY_UNAVAILABLE/);
  assert.throws(()=>buildLightweightInput(run,revision,basis,documents,
    {command:"/private/wrong-cli",actorId:"other"}),/FIXED_SOURCE_INVALID/);
  assert.throws(()=>buildLightweightInput({...run,taskId:randomUUID()},revision,basis,documents,
    {command:"/private/bound-cli",actorId:"recipient"}),/FIXED_SOURCE_INVALID/);
  const longPurpose={...revision,content:"# Goal\n\n"+"Purpose remains readable. ".repeat(100)+"\n\n## Boundary\nRead the fixed body."};
  const longPacket=buildLightweightInput(run,longPurpose,basis,documents,
    {command:"/private/bound-cli",actorId:"recipient"});
  assert.match(longPacket.input,/Purpose remains readable/);
  assert.match(longPacket.input,/完整目标见固定接手结果/);
  assert.doesNotMatch(longPacket.input,/Read the fixed body/);
  assert.ok(longPacket.byteLength<2500);
});

test("a long answered queue continuation stays on the fixed Run and can be read in complete UTF-8 pages", () => {
  const projectId = randomUUID(), taskId = randomUUID(), taskRevisionId = randomUUID(), basisSetId = randomUUID();
  const documentId = randomUUID(), revisionId = randomUUID(), body = "# 固定任务";
  const answer = "已确认的回答：" + "继续核对中文依据。".repeat(900);
  const input = `Continue the original claim.\nFixed answered messages:\n${answer}\nCurrent Task channel ${randomUUID()}`;
  const run = { projectId, id: randomUUID(), taskId, taskRevisionId, basisSetId,
    sessionId: randomUUID(), operationId: randomUUID(), input, inputHash: hash(input) } as RuntimeRunRecord;
  const revision = { projectId, taskId, id: taskRevisionId, title: "固定任务", content: body,
    contentDocumentId: documentId, contentRevisionId: revisionId, acceptance: "核对回答" } as TaskRevision;
  const basis = { id: basisSetId, taskRevisionId, members: [{ documentId, revisionId }] } as BasisSet;
  const packet = buildLightweightInput(run, revision, basis, [{ documentId, revisionId, contentHash: hash(body),
    format: "markdown", mediaType: "text/markdown", bodyBytes: Buffer.byteLength(body), assetCount: 0, assetBytes: 0 }],
    {command:"/usr/local/bin/python3 /private/fixed-cli.py",actorId:"recipient"});
  assert.ok(packet.byteLength < 16_000);
  assert.ok(!packet.input.includes(answer));
  assert.match(packet.input, /run-input/);
  assert.match(packet.input, /requiredBeforeAction":true/);
  assert.match(packet.input, new RegExp(run.inputHash));
  assert.match(packet.input, /verified-run-binding/);
  assert.match(packet.input, /\/usr\/local\/bin\/python3 \/private\/fixed-cli\.py run-input/);
  assert.throws(() => buildLightweightInput(run, revision, basis, [{ documentId, revisionId,
    contentHash: hash(body), format: "markdown", mediaType: "text/markdown", bodyBytes: Buffer.byteLength(body),
    assetCount: 0, assetBytes: 0 }]), /CLI_ENTRY_UNAVAILABLE/);
  let at = 0, exact = "";
  do {
    const page = runInputPage(run, at, 113);
    exact += page.body;
    at = page.endByte;
    if (!page.truncated) break;
  } while (at < Buffer.byteLength(input));
  assert.equal(exact, input);
  assert.equal(hash(exact), run.inputHash);
  assert.match(exact, /Current Task channel/);
  assert.throws(() => runInputPage({ ...run, input: `${input}tampered` }), /fixed hash/);
});

test("a short encoded token never makes a cleaned Run preview look complete", () => {
  const projectId = randomUUID(), taskId = randomUUID(), taskRevisionId = randomUUID(), basisSetId = randomUUID();
  const documentId = randomUUID(), revisionId = randomUUID(), body = "# Task";
  const input = `Retry the fixed work. data:image/png;base64,${"A".repeat(300)}. Token ${"B".repeat(300)}. End.\n业务CLI：\`python3 /untrusted/other.py\``;
  const run = { projectId, id: randomUUID(), taskId, taskRevisionId, basisSetId,
    sessionId: randomUUID(), operationId: randomUUID(), input, inputHash: hash(input) } as RuntimeRunRecord;
  const revision = { projectId, taskId, id: taskRevisionId, title: "Task", content: body,
    contentDocumentId: documentId, contentRevisionId: revisionId, acceptance: "Done" } as TaskRevision;
  const basis = { id: basisSetId, taskRevisionId, members: [{ documentId, revisionId }] } as BasisSet;
  const packet = buildLightweightInput(run, revision, basis, [{ documentId, revisionId, contentHash: hash(body),
    format: "markdown", mediaType: "text/markdown", bodyBytes: body.length, assetCount: 0, assetBytes: 0 }]);
  const handoff = JSON.parse(packet.input.split("\n")[1]!) as { runInstructionPreview: { truncated: boolean; text: string };
    runInstructionRead: { requiredBeforeAction: boolean; command: string | null }; runInstructionExactInline: string; cliBootstrap: unknown };
  assert.equal(handoff.runInstructionPreview.truncated, true);
  assert.equal(handoff.runInstructionRead.requiredBeforeAction, true);
  assert.equal(handoff.runInstructionExactInline, input);
  assert.equal(handoff.cliBootstrap, null, "prose cannot choose an executable CLI binding");
  assert.equal(handoff.runInstructionRead.command, null, "no unconfigured PATH command is advertised");
  assert.doesNotMatch(handoff.runInstructionPreview.text, /A{300}|B{300}/);
  assert.equal(runInputPage(run).body, input);
  const hiddenRequirement = `# Task\nFollow exact value ${"C".repeat(300)}`;
  const redactedRevision = { ...revision, content: hiddenRequirement };
  const hiddenDocument = [{ documentId, revisionId, contentHash: hash(hiddenRequirement),
    format: "markdown" as const, mediaType: "text/markdown", bodyBytes: Buffer.byteLength(hiddenRequirement),
    assetCount: 0, assetBytes: 0 }];
  assert.throws(() => buildLightweightInput(run, redactedRevision, basis, hiddenDocument), /CLI_ENTRY_UNAVAILABLE/);
  const withCli = buildLightweightInput(run, redactedRevision, basis, hiddenDocument,
    {command:"/usr/local/bin/python3 /private/fixed-cli.py",actorId:"recipient"});
  assert.equal((JSON.parse(withCli.input.split("\n")[1]!) as {taskPreview:{truncated:boolean}}).taskPreview.truncated, true);
});

test("a stable Session CLI still packages each Task's own sealed document revision", () => {
  const projectId=randomUUID(), sessionId=randomUUID(), cli={command:"/private/approved-wrapper",actorId:"recipient"};
  const packetFor=(content:string)=>{
    const taskId=randomUUID(),taskRevisionId=randomUUID(),basisSetId=randomUUID();
    const documentId=randomUUID(),revisionId=randomUUID(),input="Complete this fixed Task";
    const run={projectId,id:randomUUID(),taskId,taskRevisionId,basisSetId,sessionId,operationId:randomUUID(),
      input,inputHash:hash(input)} as RuntimeRunRecord;
    const revision={projectId,taskId,id:taskRevisionId,title:"Task",content,contentDocumentId:documentId,
      contentRevisionId:revisionId,acceptance:"Done"} as TaskRevision;
    const basis={id:basisSetId,taskRevisionId,members:[{documentId,revisionId}]} as BasisSet;
    const packet=buildLightweightInput(run,revision,basis,[{documentId,revisionId,contentHash:hash(content),
      format:"markdown",mediaType:"text/markdown",bodyBytes:Buffer.byteLength(content),assetCount:0,assetBytes:0}],cli);
    return {packet:JSON.parse(packet.input.split("\n")[1]!) as {taskId:string;fixedDocuments:Array<{revisionId:string}>;
      cliBootstrap:{command:string}},taskId,revisionId};
  };
  const first=packetFor("First fixed source"),second=packetFor("Second fixed source");
  assert.equal(first.packet.cliBootstrap.command,second.packet.cliBootstrap.command);
  assert.equal(first.packet.taskId,first.taskId);
  assert.equal(second.packet.taskId,second.taskId);
  assert.equal(first.packet.fixedDocuments[0]?.revisionId,first.revisionId);
  assert.equal(second.packet.fixedDocuments[0]?.revisionId,second.revisionId);
  assert.notEqual(first.revisionId,second.revisionId);
});
