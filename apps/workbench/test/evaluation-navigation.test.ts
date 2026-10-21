import assert from "node:assert/strict";
import { test } from "node:test";
import { clearKnowledgeReturnsOnLogin, knowledgeReturnHref } from "../src/ui/returnRoute.ts";

const project = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const evaluation = "33333333-3333-4333-8333-333333333333";
const revision = "44444444-4444-4444-8444-444444444444";
const key = `evoloop:knowledge-return:${project}`;
const storage = (value: string | null) => ({ getItem: (requested: string) => requested === key ? value : null });

test("knowledge reader returns to the exact same-project fixed evaluation definition", () => {
  const source = `#/p/${project}/evaluations/${evaluation}?revision=${revision}`;
  assert.equal(knowledgeReturnHref(project, storage(source)), source);
});

test("knowledge return discards foreign, unrelated, and self-referential routes", () => {
  for (const source of [
    `#/p/${other}/evaluations/${evaluation}?revision=${revision}`,
    `javascript:alert(1)`,
    `#/p/${project}/knowledge?knowledgeId=${evaluation}&knowledgeRevision=${revision}`,
    `#/p/${project}/not-a-workbench-page`,
  ]) assert.equal(knowledgeReturnHref(project, storage(source)), null, source);
});

test("actor B's verified login removes actor A's same-project return without touching other stored work", () => {
  const entries = new Map([
    [key, `#/p/${project}/evaluations/${evaluation}?revision=${revision}`],
    [`evoloop:knowledge-return:${other}`, `#/p/${other}/work`],
    ["evoloop:operation-receipts", "unconfirmed-operation"],
  ]);
  const session = { getItem: (name: string) => entries.get(name) ?? null, removeItem: (name: string) => { entries.delete(name); } };
  assert.match(knowledgeReturnHref(project, session) ?? "", /evaluations/);
  clearKnowledgeReturnsOnLogin([project], session);
  assert.equal(knowledgeReturnHref(project, session), null);
  assert.equal(entries.get(`evoloop:knowledge-return:${other}`), `#/p/${other}/work`);
  assert.equal(entries.get("evoloop:operation-receipts"), "unconfirmed-operation");
});
