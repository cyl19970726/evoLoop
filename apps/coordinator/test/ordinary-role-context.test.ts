import assert from "node:assert/strict";
import test from "node:test";
import { ordinaryRoleContext } from "../src/session-messages/role-context.js";

test("ordinary input names the fixed Role and Skill sources for the recipient",()=>{
  const result=ordinaryRoleContext({command:"/private/ux-cli.py",projectId:"project",roleId:"role",
    revisionId:"revision",skills:[{path:".agents/skills/evoloop-workflow/SKILL.md",commit:"commit",contentHash:"hash"}]});
  assert.match(result,/Role 固定修订 role@revision/);
  assert.match(result,/get \/api\/projects\/project\/roles\/role\/revisions\/revision/);
  assert.match(result,/skills\/evoloop-workflow\?commit=commit&hash=hash/);
  assert.match(result,/上下文缺失时读取这些固定来源/);
});
