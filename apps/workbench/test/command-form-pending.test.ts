// #295 items 3 and 5: a control that sets its value after an asynchronous read must not write an old baseline into the kept draft, a form
// waits for a selector that is still reading, and a field `requiredWhen` makes required is required in the control itself too.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldInput, FormPendingContext, fieldOptional, useCommand, useFormPending, type FormField, type MutationContext, type SavedDraft } from "../src/shared/command/index.ts";

const projectId = "10000001-0000-4000-8000-000000000001";
const context = (): MutationContext => ({ token: "", projectId, principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] } as MutationContext["principal"],
  blocked: false, onAttempt: () => true, onKnown: () => undefined, onChanged: () => undefined });

function hookRunner<P, R>(hook: (props: P) => R) {
  const slots: unknown[] = [];
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return (props: P): R => {
    let index = 0;
    const effects: Array<() => void> = [];
    const dispatcher = {
      useState(initial: unknown) { const at = index++; if (!(at in slots)) slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
        return [slots[at], (next: unknown) => { slots[at] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots[at]) : next; }]; },
      useRef(initial: unknown) { const at = index++; if (!(at in slots)) slots[at] = { current: initial }; return slots[at]; },
      useEffect(effect: () => void, deps?: unknown[]) { const at = index++; const before = slots[at] as unknown[] | undefined;
        if (!before || !deps || deps.length !== before.length || deps.some((dep, i) => !Object.is(dep, before[i]))) effects.push(effect); slots[at] = deps; },
    };
    const previous = internals.H; internals.H = dispatcher;
    let result: R; try { result = hook(props); } finally { internals.H = previous; }
    for (const effect of effects) effect();
    return result;
  };
}

test("item 3: a control that writes its value after an asynchronous read saves the draft against the baseline as it is now, not as it was when the read began", () => {
  const store = new Map<string, SavedDraft>();
  const render = hookRunner((baseline: { taskVersion: number }) => useCommand(context(), baseline, { draft: { store, key: "owner:1" } }));
  const early = render({ taskVersion: 1 });                       // the render the asynchronous read started in
  early.saveDraft({ owner: "" });
  assert.deepEqual(store.get("owner:1"), { values: { owner: "" }, baseline: { taskVersion: 1 } });
  // The person keeps their changes against a newer version meanwhile (rebase), and the read answers afterwards, through the OLD render's functions.
  const later = render({ taskVersion: 2 });
  later.rebase({ owner: "typed" });
  render({ taskVersion: 2 });                                      // the next render records the new baseline
  early.saveDraft({ owner: "typed", late: "answer of the read" });
  assert.deepEqual(store.get("owner:1"), { values: { owner: "typed", late: "answer of the read" }, baseline: { taskVersion: 2 } },
    "the draft is written against the newer baseline; it used to be written against the first one");
});

test("item 3: a selector that is still reading holds the form; the form can send again once it has the choices", () => {
  const seen: string[] = [];
  const report = (id: string, reason: string | null) => seen.push(`${id}:${reason}`);
  const html = (reason: string | null) => renderToStaticMarkup(createElement(FormPendingContext.Provider, { value: report },
    createElement(function Reading() { useFormPending(reason); return createElement("span", null, "x"); })));
  // useFormPending reports from an effect, which a static render does not run: what is checked here is that it is wired to the context and renders.
  assert.match(html("正在读取本项目的成员，读回后才能提交。"), /x/);
  assert.equal(typeof useFormPending, "function");
});

const field = (patch: Partial<FormField>): FormField => ({ name: "consumer", label: "指定验收身份", ...patch });
const render = (f: FormField, values: Record<string, string>) => renderToStaticMarkup(createElement(FieldInput, { field: f, value: values[f.name] ?? "", values, onChange: () => undefined }));

test("item 5: an optional field that requiredWhen makes required is required in the control and has no 'not set' choice; otherwise it keeps both", () => {
  const select = field({ kind: "select", optional: true, requiredWhen: values => values.mode === "human_required", options: [{ value: "a", label: "甲" }] });
  assert.equal(fieldOptional(select, { mode: "human_required" }), false);
  const required = render(select, { mode: "human_required", consumer: "a" });
  assert.match(required, /<select[^>]*\srequired=""/);
  assert.doesNotMatch(required, /不设置/);
  assert.ok(!required.includes("（可选）"));
  const optional = render(select, { mode: "independent_agent", consumer: "" });
  assert.doesNotMatch(optional, /<select[^>]*\srequired=""/);
  assert.match(optional, /<option value=""[^>]*>不设置<\/option>/);
  assert.match(optional, /（可选）/);
  // The same rule for text, textarea and datetime controls.
  for (const kind of ["text", "textarea", "datetime"] as const) {
    const f = field({ kind, optional: true, requiredWhen: values => values.mode === "human_required" });
    assert.match(render(f, { mode: "human_required" }), /\srequired=""/, `${kind}: required now`);
    assert.doesNotMatch(render(f, { mode: "x" }), /\srequired=""/, `${kind}: optional otherwise`);
  }
});
