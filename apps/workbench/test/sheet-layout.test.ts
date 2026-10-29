import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { build } from "vite";
import postcss from "postcss";

test("portaled Sheets keep viewport geometry when a preview omits the utility compiler", async () => {
  // Match the affected preview build, without replacing its dist or starting a server.
  const result = await build({
    configFile: false,
    root: resolve(import.meta.dirname, ".."),
    logLevel: "silent",
    build: { write: false, minify: false, reportCompressedSize: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : []);
  const css = outputs.filter(item => item.type === "asset" && item.fileName.endsWith(".css"))
    .map(item => String(item.source)).join("\n");
  assert.ok(css, "inspect the emitted CSS, not just class names in the source");
  const rules = postcss.parse(css);
  function declarations(selector: string) {
    const values = new Map<string, string>();
    rules.walkRules(rule => {
      if (rule.selectors.includes(selector)) rule.walkDecls(declaration => { values.set(declaration.prop, declaration.value); });
    });
    return values;
  }
  assert.equal(declarations(".fixed").size, 0, "this regression must exercise the build without utilities");
  const overlay = declarations(".sheet-overlay"), content = declarations(".sheet-content");
  assert.equal(overlay.get("position"), "fixed");
  assert.equal(overlay.get("inset"), "0");
  assert.equal(content.get("position"), "fixed", "a body Portal must not fall below the page in normal flow");
  assert.ok(Number(content.get("z-index")) > Number(overlay.get("z-index")), "navigation stays above its dismissal overlay");
  assert.equal(content.get("overflow-y"), "auto", "long Session navigation scrolls within the viewport");
  const left = declarations('.sheet-content[data-side="left"]');
  assert.equal(left.get("inset"), "0 auto 0 0");
  assert.equal(left.get("height"), "100dvh");
  const close = declarations(".sheet-close");
  assert.equal(close.get("position"), "absolute");
  assert.equal(close.get("top"), "1rem");
  assert.equal(close.get("right"), "1rem");
});
