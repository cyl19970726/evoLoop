import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const safeSkill = /^\.agents\/skills\/[A-Za-z0-9_-]+\/SKILL\.md$/;
const safeCommit = /^[a-f0-9]{40}$/;
const safeSource = /^(?:docs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md|\.agents\/skills\/[A-Za-z0-9_-]+\/references\/[A-Za-z0-9_-]+\.md)$/;
const digest = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

export async function currentSkillCommit(root: string): Promise<string> {
  const { stdout } = await run("git", ["-C", root, "rev-parse", "HEAD"], { maxBuffer: 4096 });
  const commit = stdout.trim();
  if (!safeCommit.test(commit)) throw new Error("Skill source revision is unavailable");
  return commit;
}

export async function readFixedSkill(root: string, path: string, commit: string, expectedHash?: string) {
  if (!safeSkill.test(path) || !safeCommit.test(commit)) throw new Error("Invalid fixed skill reference");
  const { stdout: body } = await run("git", ["-C", root, "show", `${commit}:${path}`],
    { maxBuffer: 96 * 1024, encoding: "utf8" });
  const contentHash = digest(body);
  if (expectedHash && contentHash !== expectedHash) throw new Error("Fixed skill hash mismatch");
  return { path, commit, contentHash, body };
}

function linkedSources(path:string,body:string):string[] {
  const sources=new Set<string>();
  for(const match of body.matchAll(/\]\(([^)]+)\)/g)){
    const link=match[1]!.split("#",1)[0]!;
    if(!link||link.startsWith("/")||link.includes(":")||link.includes("?"))continue;
    const target=posix.normalize(posix.join(posix.dirname(path),link));
    if(safeSource.test(target))sources.add(target);
  }
  return [...sources].slice(0,32);
}

async function readSource(root:string,path:string,commit:string,expectedHash?:string){
  if(!safeSource.test(path)||!safeCommit.test(commit))throw new Error("Invalid fixed source reference");
  const {stdout:body}=await run("git",["-C",root,"show",`${commit}:${path}`],
    {maxBuffer:96*1024,encoding:"utf8"});
  const contentHash=digest(body);
  if(expectedHash&&expectedHash!==contentHash)throw new Error("Fixed source hash mismatch");
  return {path,commit,contentHash,body};
}

export async function roleSkillSourceReferences(root:string,skillPath:string,commit:string){
  const skill=await readFixedSkill(root,skillPath,commit);
  const paths=linkedSources(skillPath,skill.body);
  return Promise.all(paths.map(path=>readSource(root,path,commit).then(({body:_body,...reference})=>reference)));
}

export async function readRoleSkillSource(root:string,skillPath:string,path:string,commit:string,hash:string){
  const direct=await roleSkillSourceReferences(root,skillPath,commit);
  if(!direct.some(value=>value.path===path))throw new Error("Source is not linked by this Role skill");
  return readSource(root,path,commit,hash);
}

export async function roleSkillReferences(root: string, paths: string[]) {
  const commit = await currentSkillCommit(root);
  return Promise.all(paths.map(async path => {
    const { body: _body, ...reference } = await readFixedSkill(root, path, commit);
    return reference;
  }));
}
