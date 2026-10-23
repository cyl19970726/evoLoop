import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { delegationTemplateSchema } from "@evoloop/contracts/division";
import { delegationTemplateHash } from "../src/configuration.js";

const base = () => ({id:randomUUID(),revision:1,projectId:randomUUID(),goalId:randomUUID(),loopId:randomUUID(),
  existingRoleIds:[],cognitionRoleIds:[],newRoleAllocation:{maxTotal:1,requiredState:"trial"},
  firstTaskId:randomUUID(),actorId:"controller",authorizationScopeId:"finite-trial",decisionActorIds:["researcher"],
  allowedChoices:["new-role"],cwd:"/tmp/fixture",model:"fixture",sandbox:"read-only",networkAccess:false,
  approvalPolicy:"on-request",expiresAtUtc:"2026-10-25T00:00:00.000Z"});

test("legacy template canonical shape and hash stay unchanged; creation changes the grant hash",()=>{
  const legacy=base();
  const parsed=delegationTemplateSchema.parse(legacy);
  assert.equal(Object.hasOwn(parsed.newRoleAllocation!,"creation"),false);
  assert.deepEqual(parsed,legacy);
  const oldHash=delegationTemplateHash(parsed);
  const denied=delegationTemplateSchema.parse({...legacy,newRoleAllocation:{...legacy.newRoleAllocation,creation:null}});
  assert.notEqual(delegationTemplateHash(denied),oldHash);
  const permitted=delegationTemplateSchema.parse({...legacy,revision:2,
    newRoleAllocation:{...legacy.newRoleAllocation,creation:{allowProposeAndAcceptTrial:true,maxTrialDays:7}}});
  assert.notEqual(delegationTemplateHash(permitted),oldHash);
  assert.equal(permitted.newRoleAllocation?.creation?.maxTrialDays,7);
  for(const maxTrialDays of [0,91,1.5]) assert.equal(delegationTemplateSchema.safeParse({...legacy,
    newRoleAllocation:{...legacy.newRoleAllocation,creation:{allowProposeAndAcceptTrial:true,maxTrialDays}}}).success,false);
  assert.equal(delegationTemplateSchema.safeParse({...legacy,newRoleAllocation:{...legacy.newRoleAllocation,
    creation:{allowProposeAndAcceptTrial:false,maxTrialDays:7}}}).success,false);
});
