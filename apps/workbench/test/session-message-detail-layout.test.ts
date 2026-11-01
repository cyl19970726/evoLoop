import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("narrow Session message detail returns to in-flow main-area reading", async () => {
  const css = await readFile(new URL("../src/sessions/workspace.css", import.meta.url), "utf8");
  const narrow = /@media\(max-width:850px\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(narrow, /\.session-message-detail\{position:static;height:auto;/);
  assert.match(narrow, /\.session-message-detail \.panel-head\{position:static\}/);
});
