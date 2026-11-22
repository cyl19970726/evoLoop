// Rehearsal of defect 581441ad in a real browser (runs in CI with `npm run test:browser`, needs the built workbench and
// EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE): four releases whose chunks all have new names, in one day. A tab opened on release 1 (its token lives in
// page memory, so it stays open) opens a page it had not visited after release 4. With the carry policy of the release script it opens; with the old
// "three generations" policy it shows the workbench's own "已经更新到新版本" page. Each release is the built dist with every script renamed, as a real
// rebuild renames every chunk whose imports changed; "releases" are directories and the served root is a symlink moved between them.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

async function release(root: string, n: number): Promise<string> {
  const out = join(root, `r${n}`, "dist"); await cp(dist, out, { recursive: true });
  const stems = (await readdir(join(out, "assets"))).filter(name => name.endsWith(".js")).map(name => name.slice(0, -3));
  const swap = async (file: string) => { let text = await readFile(file, "utf8"); for (const stem of stems) text = text.replaceAll(`${stem}.js`, `${stem}_v${n}.js`); await writeFile(file, text); };
  for (const stem of stems) await swap(join(out, "assets", `${stem}.js`));
  await swap(join(out, "index.html"));
  for (const stem of stems) await rename(join(out, "assets", `${stem}.js`), join(out, "assets", `${stem}_v${n}.js`));
  return out;
}

async function scenario(policy: Record<string, number>, t: { after: (fn: () => unknown) => void }): Promise<{ heading: string | null; chunkFailed: number; carried: number[] }> {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { carryAssets } = await import(pathToFileURL(join(repo, "scripts/release/carry-assets.mjs")).href) as { carryAssets: (o: Record<string, unknown>) => Promise<{ copied: string[] }> };
  const { projectId, token } = await import(pathToFileURL(join(repo, "scripts/frontend/fixture/common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(join(repo, "scripts/frontend/fixture/server.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const root = await mkdtemp(join(tmpdir(), "chunk-retention-")); t.after(() => rm(root, { recursive: true, force: true }));
  const dists: string[] = []; const carried: number[] = [];
  for (const n of [1, 2, 3, 4]) {
    const next = await release(root, n);
    if (n > 1) carried.push((await carryAssets({ previousAssets: join(dists[n - 2]!, "assets"), newAssets: join(next, "assets"), ...policy })).copied.length);
    dists.push(next);
  }
  const current = join(root, "current"); await symlink(dists[0]!, current);
  const fixture = await startFixtureServer(current); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" })).newPage();
  await page.goto(`${fixture.base}/p/${projectId}/overview`);
  await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "项目总览", exact: true }).first().waitFor();
  for (const n of [2, 3, 4]) { await unlink(current); await symlink(dists[n - 1]!, current); } // three releases while the tab stays open
  await page.getByRole("button", { name: "运转" }).click(); // 日程 sits in the folded 运转 group
  await page.getByText("日程", { exact: true }).filter({ visible: true }).first().click();
  await page.waitForTimeout(2500);
  const heading = await page.getByRole("heading", { level: 1 }).filter({ visible: true }).first().textContent().catch(() => null);
  return { heading, chunkFailed: await page.locator("[data-chunk-failed]").count(), carried };
}

test("a tab opened on release 1 still opens a page it had not visited after four releases in a day", { skip }, async t => {
  const result = await scenario({}, t);
  assert.deepEqual(result.carried.map(count => count > 0), [true, true, true], "every release carried the previous ones' files");
  assert.equal(result.chunkFailed, 0, "no load-failure page");
  assert.equal(result.heading, "日程", "the page the tab had not opened loads");
});

test("control: with the old policy (three generations, no time) the same tab gets the workbench's update page", { skip }, async t => {
  const result = await scenario({ keep: 3, keepDays: 0 }, t);
  assert.equal(result.chunkFailed, 1);
  assert.equal(result.heading, "工作台已经更新到新版本");
});
