// The frame's navigation model and right-column rules (docs/frontend/layout.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute } from "../src/shared/routes.ts";
import { projectPaths } from "../src/app/routePaths.ts";
import { leafOf, projectInitial, rememberSpace, sectionLabels, spaceHref, spaceOf, workNavigation, workSectionOf } from "../src/app/shell/spaces.ts";
import { addObjectTab, clampWidth, maxObjectTabs, panelWidth, readPanelState, type PanelObject } from "../src/app/shell/ContextPanel.tsx";

const p = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };

test("every address belongs to one space, and every work page is reachable from the section navigation", () => {
  assert.equal(spaceOf(parseRoute(`/p/${p}/sessions?session=owned:${id}`)), "agents");
  assert.equal(spaceOf(parseRoute(`/p/${p}/runtime?session=owned:${id}`)), "agents", "an old runtime Session link opens the agents space");
  assert.equal(spaceOf(parseRoute(`/p/${p}/runtime`)), "work");
  assert.equal(spaceOf(parseRoute(`/p/${p}/inbox`)), "inbox");
  assert.equal(spaceOf(parseRoute(`/p/${p}/operations`)), "inbox");
  const reachable = new Set(workNavigation.flatMap(item => [item.section, ...(item.children ?? []).map(child => child.section)]));
  for (const path of projectPaths) {
    const route = parseRoute(`/p/${p}/${path.replace(/\$\w+/, id)}`);
    assert.ok(sectionLabels[route.section], `${path} has a label`);
    if (spaceOf(route) !== "work" || ["settings", "connectors"].includes(route.section)) continue;
    assert.ok(reachable.has(leafOf(route.section)), `${path} is reachable from the work navigation`);
    assert.ok(workSectionOf(route.section), `${path} highlights a section`);
  }
  assert.equal(leafOf("task"), "work");
  assert.equal(workSectionOf("document"), "documents");
  assert.equal(workSectionOf("roles"), "runtime");
});

test("each space reopens where the reader left it, only inside the same project", () => {
  const store = memory();
  assert.equal(spaceHref(store, "reader", p, "work"), `/p/${p}/work`);
  assert.equal(spaceHref(store, "reader", p, "agents"), `/p/${p}/sessions`);
  rememberSpace(store, "reader", p, parseRoute(`/p/${p}/tasks/${id}?tab=runtime`), `/p/${p}/tasks/${id}?tab=runtime`);
  rememberSpace(store, "reader", p, parseRoute(`/p/${p}/sessions?session=owned:${id}`), `/p/${p}/sessions?session=owned:${id}`);
  assert.equal(spaceHref(store, "reader", p, "work"), `/p/${p}/tasks/${id}?tab=runtime`);
  assert.equal(spaceHref(store, "reader", p, "agents"), `/p/${p}/sessions?session=owned:${id}`);
  assert.equal(spaceHref(store, "other", p, "work"), `/p/${p}/work`, "another identity starts fresh");
  rememberSpace(store, "reader", p, parseRoute(`/p/${id}/work`), `/p/${id}/work`);
  assert.equal(spaceHref(store, "reader", p, "work"), `/p/${p}/tasks/${id}?tab=runtime`, "another project's address is not kept here");
});

test("the right column keeps at most five objects, reuses an open one, and stays between 280 and 560 px", () => {
  const object = (n: number): PanelObject => ({ id: `doc:${n}`, title: `文档 ${n}`, render: () => null });
  let tabs: PanelObject[] = [];
  for (let n = 1; n <= 7; n++) tabs = addObjectTab(tabs, object(n));
  assert.equal(tabs.length, maxObjectTabs);
  assert.deepEqual(tabs.map(tab => tab.id), ["doc:7", "doc:6", "doc:5", "doc:4", "doc:3"], "newest first, oldest dropped");
  assert.deepEqual(addObjectTab(tabs, { ...object(5), title: "文档 5 第 2 版" }).map(tab => tab.title)[2], "文档 5 第 2 版", "reopening replaces in place");
  assert.equal(clampWidth(100), panelWidth.min);
  assert.equal(clampWidth(900), panelWidth.max);
  assert.deepEqual(readPanelState(null, "work", true), { open: true, width: panelWidth.initial }, "wide screens start open");
  assert.deepEqual(readPanelState(null, "work", false), { open: false, width: panelWidth.initial });
  const store = memory(); store.setItem("evoloop:panel:agents", JSON.stringify({ open: false, width: 999 }));
  assert.deepEqual(readPanelState(store, "agents", true), { open: false, width: panelWidth.max }, "remembered per space, clamped");
});

test("the project mark skips brackets and punctuation", () => {
  assert.equal(projectInitial("【合成示例】工作台"), "合");
  assert.equal(projectInitial("evoLoop"), "E");
  assert.equal(projectInitial("  "), "E");
});
