import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { BasisSet, RuntimeRunRecord, TaskRevision } from "@evoloop/contracts";
import { buildLightweightInput } from "../src/runtime/lightweight-input.js";
import { runInputPage } from "../src/runtime/input-read.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

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
