import assert from "node:assert/strict";
import { test } from "node:test";
import { isChunkLoadError, lazyChunk, resetChunks } from "../src/app/chunkLoad.tsx";

test("the browser errors for a chunk that cannot be fetched are recognised, other errors are not", () => {
  for (const message of ["Failed to fetch dynamically imported module: https://x/assets/ArrangementPage-BFkRO_z-.js", "error loading dynamically imported module: https://x/a.js",
    "Importing a module script failed.", "Loading chunk 12 failed.", "ChunkLoadError"])
    assert.equal(isChunkLoadError(new TypeError(message)), true, message);
  assert.equal(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')")), false);
  assert.equal(isChunkLoadError(new Error("render failed")), false);
  assert.equal(isChunkLoadError("Failed to fetch dynamically imported module: x"), true, "a thrown string counts too");
});

test("a failed chunk load is not remembered: after resetChunks the loader is asked again", async () => {
  let calls = 0; let available = false;
  const Page = () => null;
  const Chunk = lazyChunk(async () => { calls++; if (!available) throw new TypeError("Failed to fetch dynamically imported module: /assets/Page-x.js"); return { Page }; }, "Page");
  // Rendering the chunk creates the lazy component; React.lazy would remember its first rejection for good.
  const { createElement } = await import("react");
  const { renderToString } = await import("react-dom/server");
  const attempt = () => { try { renderToString(createElement(Chunk as never)); return null; } catch (error) { return error; } };
  const first = attempt(); assert.ok(first instanceof Promise || first === null || first instanceof Error);
  assert.ok(calls >= 1);
  const afterFirst = calls;
  // Without a reset the same lazy component would replay its first outcome and never call the loader again.
  attempt(); assert.equal(calls, afterFirst, "no reset: the first outcome is replayed, the loader is not called again");
  resetChunks(); available = true;
  attempt(); assert.ok(calls > afterFirst, "after the reset the loader is asked again");
});
