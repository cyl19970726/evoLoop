// First-load budget: pages are split by route, so the entry stays small. Runs against the built dist/.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const workbench = join(import.meta.dirname, "..");
const index = join(workbench, "dist/index.html");
const budget = JSON.parse(readFileSync(join(workbench, "bundle-budget.json"), "utf8")) as { initialJsGzipBytes: number };

test("first-load JavaScript stays within the budget", { skip: !existsSync(index) && "build the workbench first (npm run build)" }, () => {
  const html = readFileSync(index, "utf8");
  const scripts = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map(match => match[1]!);
  assert.ok(scripts.length > 0, "dist/index.html names its entry script");
  const gzip = scripts.reduce((sum, file) => sum + gzipSync(readFileSync(join(workbench, "dist/assets", file))).length, 0);
  assert.ok(gzip <= budget.initialJsGzipBytes,
    `First-load JS is ${gzip} bytes gzip (budget ${budget.initialJsGzipBytes}). Load the new code on demand, or raise the budget with a reason.`);
});
