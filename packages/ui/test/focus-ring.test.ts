// The keyboard focus ring must be plain on every surface (WCAG 2.4.7, docs/frontend/foundations.md 阴影与层级) and never
// clipped by a scroll container: an opaque accent edge drawn inside the element, with a surface-coloured band within it,
// in the light and the dark theme. A translucent ring was too faint; an outer ring was cut off at scroll edges.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

test("the focus ring is an opaque accent edge drawn inside the element, in both themes", () => {
  const tokens = readFileSync(resolve(import.meta.dirname, "../src/tokens.css"), "utf8");
  const rings = [...tokens.matchAll(/--focus-ring:\s*([^;]+);/g)].map(match => match[1]!.trim());
  assert.equal(rings.length, 2, "one ring for the light theme and one for the dark theme");
  for (const ring of rings) {
    assert.equal(ring, "inset 0 0 0 2px var(--accent), inset 0 0 0 4px var(--background)");
    assert.ok(ring.split(",").every(part => part.trim().startsWith("inset")), "inside the element, so a scroll container cannot clip it");
    assert.doesNotMatch(ring, /\/\s*\d+%|rgba|transparent/, "no transparency");
  }
});
