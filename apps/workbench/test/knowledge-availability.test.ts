import test from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeCapabilities } from "@evoloop/contracts/knowledge";
import { knowledgeAvailability } from "../src/knowledge/availability.ts";
const caps = (override: Partial<KnowledgeCapabilities> = {}): KnowledgeCapabilities => ({backendVersion:null,backendReachable:true,fixedRevisionRead:"adapter_verified",conditionalPublish:"unavailable",boundedRelations:"unavailable",migration:"unsupported",semanticIndex:"unverified",...override});
test("a missing version does not turn a reachable backend into unavailable",()=>assert.equal(knowledgeAvailability(caps()).fullRead,true));
test("a cached version does not prove connectivity or fixed-original availability",()=>{
 assert.equal(knowledgeAvailability(caps({backendVersion:"cached",backendReachable:false})).fullRead,false);
 assert.equal(knowledgeAvailability(caps({fixedRevisionRead:"unavailable"})).fullRead,false);
 assert.equal(knowledgeAvailability(null).fullRead,false);
});
