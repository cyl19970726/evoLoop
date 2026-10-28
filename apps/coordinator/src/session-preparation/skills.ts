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
  if(sources.size>32)throw new Error("Fixed source has too many direct references");
  return [...sources];
}

async function readSource(root:string,path:string,commit:string,expectedHash?:string){
  if(!safeSource.test(path)||!safeCommit.test(commit))throw new Error("Invalid fixed source reference");
  const {stdout:body}=await run("git",["-C",root,"show",`${commit}:${path}`],
    {maxBuffer:96*1024,encoding:"utf8"});
  const contentHash=digest(body);
  if(expectedHash&&expectedHash!==contentHash)throw new Error("Fixed source hash mismatch");
  return {path,commit,contentHash,body};
}

async function sourceReferences(root:string,path:string,commit:string,body:string){
  const paths=linkedSources(path,body);
  return Promise.all(paths.map(path=>readSource(root,path,commit).then(({body:_body,...reference})=>reference)));
}

export async function roleSkillSourceReferences(root:string,skillPath:string,commit:string){
  const skill=await readFixedSkill(root,skillPath,commit);
  return sourceReferences(root,skillPath,commit,skill.body);
}

/** Every hop is checked against its parent at the same commit; only selected children are returned. */
export async function readRoleSkillSource(root:string,skillPath:string,path:string,commit:string,hash:string,
  via:string[]=[skillPath]){
  if(via.length<1||via.length>8||via[0]!==skillPath||new Set(via).size!==via.length)
    throw new Error("Invalid fixed source trail");
  let parent=await readFixedSkill(root,skillPath,commit);
  for(const hop of via.slice(1)){
    if(!linkedSources(parent.path,parent.body).includes(hop))throw new Error("Source trail is not linked by this Role skill");
    parent=await readSource(root,hop,commit);
  }
  if(!linkedSources(parent.path,parent.body).includes(path)||via.includes(path))
    throw new Error("Source is not linked by this Role skill");
  const source=await readSource(root,path,commit,hash);
  const children=await sourceReferences(root,path,commit,source.body);
  const trail=[...via,path];
  const references=trail.length>=8?[]:children.filter(value=>!trail.includes(value.path));
  return {...source,references,cycleReferencesOmitted:children.filter(value=>trail.includes(value.path)).length,
    referenceLimitReached:trail.length>=8&&children.some(value=>!trail.includes(value.path))};
}

export async function roleSkillReferences(root: string, paths: string[]) {
  const commit = await currentSkillCommit(root);
  return Promise.all(paths.map(async path => {
    const { body: _body, ...reference } = await readFixedSkill(root, path, commit);
    return reference;
  }));
}
