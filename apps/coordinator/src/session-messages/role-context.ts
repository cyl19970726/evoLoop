export function ordinaryRoleContext(input: {command:string;projectId:string;roleId:string;revisionId:string;
  skills:Array<{path:string;commit:string;contentHash:string}>}): string {
  const lines=[`当前 Role 固定修订 ${input.roleId}@${input.revisionId}`,
    `${input.command} get /api/projects/${input.projectId}/roles/${input.roleId}/revisions/${input.revisionId}`,
    ...input.skills.map(skill=>`${input.command} get '/api/projects/${input.projectId}/roles/${input.roleId}/skills/${skill.path.split('/')[2]}?commit=${skill.commit}&hash=${skill.contentHash}'`),
    "首次接手、修订变化或上下文缺失时读取这些固定来源。已有来源未变时沿用已读内容；Task 正文与交付仍须按具体原件核验。"];
  const result=lines.join("\n");
  if(Buffer.byteLength(result,"utf8")>3500)throw new Error("Ordinary Role context exceeds bounded input");
  return result;
}
