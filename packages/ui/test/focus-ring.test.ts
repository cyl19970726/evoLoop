// The keyboard focus ring must be plain on every surface (WCAG 2.4.7, docs/frontend/foundations.md 阴影与层级): an opaque
// accent ring with a gap in the surface colour, in the light and the dark theme. A translucent ring was too faint on the
// soft cards of the agent page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

test("the focus ring is an opaque accent ring with a surface-coloured gap, in both themes", () => {
  const tokens = readFileSync(resolve(import.meta.dirname, "../src/tokens.css"), "utf8");
  const rings = [...tokens.matchAll(/--focus-ring:\s*([^;]+);/g)].map(match => match[1]!.trim());
  assert.equal(rings.length, 2, "one ring for the light theme and one for the dark theme");
  for (const ring of rings) {
    assert.equal(ring, "0 0 0 2px var(--background), 0 0 0 4px var(--accent)");
    assert.doesNotMatch(ring, /\/\s*\d+%|rgba|transparent/, "no transparency");
  }
});
