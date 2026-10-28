import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFixedSkill, readRoleSkillSource, roleSkillReferences, roleSkillSourceReferences } from "../src/session-preparation/skills.js";

const run=promisify(execFile);
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");

test("Role skill references read the committed version and reject altered hash or path",async()=>{
  const root=await mkdtemp(join(tmpdir(),"evoloop-role-skill-"));
  const path=".agents/skills/example/SKILL.md";
  try {
    await run("git",["init","-q",root]);
    await mkdir(join(root,".agents/skills/example"),{recursive:true});
    await writeFile(join(root,path),"version one\n");
    await run("git",["-C",root,"add",path]);
    await run("git",["-C",root,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","source"]);
    const [reference]=await roleSkillReferences(root,[path]);
    assert.ok(reference);
    assert.equal(reference.contentHash,hash("version one\n"));
    await writeFile(join(root,path),"uncommitted change\n");
    assert.equal((await readFixedSkill(root,path,reference.commit,reference.contentHash)).body,"version one\n");
    await assert.rejects(readFixedSkill(root,path,reference.commit,hash("wrong")),/hash mismatch/);
    await assert.rejects(readFixedSkill(root,"../../private",reference.commit),/Invalid fixed skill reference/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("linked references and repo docs remain readable from the same fixed commit",async()=>{
  const root=await mkdtemp(join(tmpdir(),"evoloop-role-links-"));
  const skill=".agents/skills/example/SKILL.md";
  const writing=".agents/skills/example/references/writing.md";
  const guide="docs/development/agent-cli.md";
  try {
    await run("git",["init","-q",root]);
    await mkdir(join(root,".agents/skills/example/references"),{recursive:true});
    await mkdir(join(root,"docs/development"),{recursive:true});
    await writeFile(join(root,skill),"[Writing](references/writing.md) [Private](../../../private.md)\n");
    await writeFile(join(root,writing),"fixed writing [CLI](../../../../docs/development/agent-cli.md#start)\n");
    await writeFile(join(root,guide),"fixed CLI [Writing](../../.agents/skills/example/references/writing.md)\n");
    await run("git",["-C",root,"add","."]);
    await run("git",["-C",root,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","source"]);
    const [reference]=await roleSkillReferences(root,[skill]);
    assert.ok(reference);
    const sources=await roleSkillSourceReferences(root,skill,reference.commit);
    assert.deepEqual(sources.map(value=>value.path),[writing]);
    await writeFile(join(root,guide),"new CLI\n");
    await assert.rejects(readRoleSkillSource(root,skill,guide,reference.commit,hash("fixed CLI\n")),/not linked/);
    const first=await readRoleSkillSource(root,skill,writing,reference.commit,hash("fixed writing [CLI](../../../../docs/development/agent-cli.md#start)\n"));
    assert.deepEqual(first.references.map(value=>value.path),[guide]);
    const fixed=await readRoleSkillSource(root,skill,guide,reference.commit,
      hash("fixed CLI [Writing](../../.agents/skills/example/references/writing.md)\n"),[skill,writing]);
    assert.match(fixed.body,/fixed CLI/);
    assert.deepEqual(fixed.references,[]);
    assert.equal(fixed.cycleReferencesOmitted,1);
    await assert.rejects(readRoleSkillSource(root,skill,"private.md",reference.commit,hash("anything")),/not linked/);
    await assert.rejects(readRoleSkillSource(root,skill,guide,reference.commit,hash("new CLI\n"),[skill,writing]),/hash mismatch/);
    await assert.rejects(readRoleSkillSource(root,skill,guide,reference.commit,hash("new CLI\n"),[skill,guide]),/trail/);
  } finally {await rm(root,{recursive:true,force:true});}
});
