import assert from "node:assert/strict";
import { test } from "node:test";
import * as ReactModule from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleGrantHelp } from "../src/features/scheduling/ScheduleGrantHelp.tsx";

// Shared parts written for the automatic JSX runtime expect React in scope under this test loader.
Object.assign(globalThis, { React: ReactModule });

test("without a creation grant the schedule page says where the grant is set and links the how-to", () => {
  const html = renderToStaticMarkup(createElement("p", null, createElement(ScheduleGrantHelp)));
  assert.match(html, /取得本项目明确授权后才能创建日程/);
  assert.match(html, /<code>scheduling\.grants<\/code>/);
  assert.match(html, /私有配置/);
  assert.match(html, /维护者/);
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(hrefs, [
    "https://github.com/cyl19970726/evoLoop/blob/main/docs/development/local-run.md",
    "https://github.com/cyl19970726/evoLoop/blob/main/docs/development/runtime-operations.md",
  ]);
  assert.match(html, /运行接线手册<\/a>/);
});
