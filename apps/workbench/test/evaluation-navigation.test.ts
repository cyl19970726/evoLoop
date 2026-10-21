import assert from "node:assert/strict";
import { test } from "node:test";
import { clearKnowledgeReturnsOnLogin, knowledgeReturnHref, rememberKnowledgeSource } from "../src/ui/returnRoute.ts";

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

test("fixed evaluation → Wiki → fixed source Document → Wiki preserves the evaluation return", () => {
  const entries = new Map<string, string>();
  const session = { getItem: (name: string) => entries.get(name) ?? null,
    setItem: (name: string, value: string) => { entries.set(name, value); },
    removeItem: (name: string) => { entries.delete(name); } };
  const source = `#/p/${project}/evaluations/${evaluation}?revision=${revision}`;
  const wiki = `#/p/${project}/knowledge?knowledgeId=${evaluation}&knowledgeRevision=${revision}`;
  const document = `#/p/${project}/documents/${evaluation}?revision=${revision}&return=${encodeURIComponent(wiki)}`;
  rememberKnowledgeSource(project, source, wiki, session);
  entries.set(`evoloop:document-return:${project}`, wiki);
  rememberKnowledgeSource(project, document, wiki, session);
  assert.equal(knowledgeReturnHref(project, session), source);

  // A later ordinary Document → Knowledge entry has no matching nested return.
  rememberKnowledgeSource(project, `#/p/${project}/documents/${evaluation}?revision=${revision}`, wiki, session);
  assert.equal(knowledgeReturnHref(project, session), null);
  rememberKnowledgeSource(project, `#/p/${project}/tasks/${evaluation}?revision=${revision}`, wiki, session);
  assert.equal(knowledgeReturnHref(project, session), `#/p/${project}/tasks/${evaluation}?revision=${revision}`);

  // A forged or stale explicit return without a matching prior Wiki entry must not retain this source.
  entries.set(`evoloop:document-return:${project}`, `#/p/${project}/knowledge`);
  rememberKnowledgeSource(project, document, wiki, session);
  assert.equal(knowledgeReturnHref(project, session), null);
});
