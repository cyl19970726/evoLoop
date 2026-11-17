// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import type { BasisSet, Document, DocumentRevision, Project, Task, TaskRevision } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { createLeaderWorkIndexReader } from "../../apps/coordinator/src/work-management/work-index.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

/**
 * Task a29100df: a current Delivery the declared consumer judged notUsed (or failed) was counted as 待验收 while the Task's timeline said 返工中. Real database and migrations, the
 * real Leader work index and Task routes behind the real server; the four shapes are seeded as rows (no native runtime here). With EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE and the built
 * workbench the same server serves the pages and a real Chromium reads label, counts and the timeline sentence of each Task at 1440×900 and 390×844.
 */
test("the work index, the Task list and the Task page agree: notUsed, failed and used→notUsed are 待返工; a new Delivery without an answer is 待验收 again", async t => {
  const schema = `notused_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await migrate(url!, schema);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: url }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const uow = new PostgresUnitOfWork(pool);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const actor = "author-role", now = new Date(Date.now() - 3 * 3600_000).toISOString();
  const later = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
  const project: Project = { id: randomUUID(), title: "notUsed 分类", createdAt: now };
  const token = randomUUID() + randomUUID();

  const fixture = async (title: string) => {
    const id = randomUUID(), revisionId = randomUUID(), basisId = randomUUID(), docId = randomUUID(), docRev = randomUUID(), body = `# ${title}`;
    const doc: Document = { projectId: project.id, id: docId, title: `${title} 正文`, version: 1, currentRevisionId: docRev, adoptedRevisionId: null, kind: "task", status: "draft" };
    const rev: DocumentRevision = { projectId: project.id, documentId: docId, id: docRev, body, format: "markdown", mediaType: "text/markdown", originalName: "a.md", payloadRef: null,
      entrypoint: null, assetsManifest: [], contentHash: hash(body), author: actor, createdAt: now, previousRevisionId: null, reason: "fixture" };
    const head: Task = { projectId: project.id, id, version: 1, currentRevisionId: revisionId, title, content: body, contentDocumentId: docId, contentRevisionId: docRev, kind: "implementation",
      acceptance: "可见的验收条件", owner: actor, state: "in_progress" };
    const revision: TaskRevision = { projectId: project.id, taskId: id, id: revisionId, version: 1, title, content: body, contentDocumentId: docId, contentRevisionId: docRev, kind: "implementation",
      acceptance: head.acceptance, owner: actor, state: "in_progress", basisSetId: basisId, actorId: actor, reason: "fixture", createdAt: now };
    const basis: BasisSet = { projectId: project.id, taskId: id, taskRevisionId: revisionId, id: basisId, sealed: true, members: [{ documentId: docId, revisionId: docRev }] };
    await uow.transaction(project.id, async tx => {
      await tx.insertDocument(doc); await tx.insertDocumentRevision(rev); await tx.insertTask(head); await tx.insertTaskRevision(revision); await tx.insertSealedBasisSet(basis);
    });
    await pool.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,stage_id,consumer,use_required,evidence,stop_condition,created_at) VALUES($1,$2,$3,NULL,'accept-agent',true,'e','s',$4)`,
      [project.id, id, revisionId, now]);
    const deliver = async (at: string) => { const deliveryId = randomUUID();
      await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,'fixture://pr','r',$5,'passed','fixture','fixture',$6,$7)`, [project.id, deliveryId, id, revisionId, hash(deliveryId), actor, at]); return deliveryId; };
    const answer = (deliveryId: string, result: string, at: string) => pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'accept-agent','agent',$5,'checked','checked','accept-agent',$6)`, [project.id, randomUUID(), id, deliveryId, result, at]);
    return { id, deliver, answer };
  };
  await uow.transaction(project.id, async tx => { await tx.insertProject(project); });
  const notUsed = await fixture("形态一 notUsed"); await notUsed.answer(await notUsed.deliver(later(5)), "notUsed", later(10));
  const failed = await fixture("形态二 failed"); await failed.answer(await failed.deliver(later(5)), "failed", later(10));
  const usedThenNot = await fixture("形态三 used 后 notUsed"); { const d = await usedThenNot.deliver(later(5)); await usedThenNot.answer(d, "used", later(10)); await usedThenNot.answer(d, "notUsed", later(20)); }
  const redelivered = await fixture("形态四 notUsed 后新交付"); await redelivered.answer(await redelivered.deliver(later(5)), "notUsed", later(10)); await redelivered.deliver(later(30));
  const noAnswer = await fixture("反例 没有结论"); await noAnswer.deliver(later(5));
  const usedWait = await fixture("反例 已 used 等关闭"); await usedWait.answer(await usedWait.deliver(later(5)), "used", later(10));
  const all = [notUsed, failed, usedThenNot, redelivered, noAnswer, usedWait];

  const playwright = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
  const webRoot = playwright ? resolve(import.meta.dirname, "../../apps/workbench/dist") : undefined;
  const service = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } });
  const app = await buildServer({ ...(webRoot ? { webRoot } : {}), service, workIndex: createLeaderWorkIndexReader(pool),
    credentials: [{ token, actorId: "reader", projectIds: [project.id], permissions: ["task", "document", "session", "management"], decisions: true }] } as never);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}` };
  const index = (await app.inject({ url: `/api/projects/${project.id}/work-management/index?view=tasks&limit=100`, headers })).json() as
    { items: Array<{ taskId: string; phase: string; nextAction: string; responsible: { kind: string; id: string | null }; timing: { current: { stage: string } } }>; counts: Record<string, number> };
  const row = (item: { id: string }) => index.items.find(x => x.taskId === item.id)!;

  for (const item of [notUsed, failed, usedThenNot]) {
    assert.equal(row(item).phase, "rework"); assert.equal(row(item).timing.current.stage, "rework", "label and timeline stage agree");
    assert.deepEqual([row(item).responsible.kind, row(item).responsible.id], ["role", actor]); assert.match(row(item).nextAction, /不需要再验收；在原 Task 安排返工并重新交付/);
  }
  assert.equal(row(redelivered).phase, "awaiting_acceptance"); assert.equal(row(noAnswer).phase, "awaiting_acceptance"); assert.equal(row(usedWait).phase, "awaiting_close");
  assert.deepEqual([index.counts.rework, index.counts.awaiting_acceptance, index.counts.awaiting_close], [3, 2, 1], "counts equal the rows");

  if (!playwright) return;
  const { chromium } = (await import(pathToFileURL(playwright).href)).default;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const shots = process.env.EVOLOOP_NOTUSED_SCREENSHOT_DIR;
  const expectLabel = (item: { id: string }) => row(item).phase === "rework" ? "待返工" : row(item).phase === "awaiting_close" ? "等关闭" : "待验收";
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${base}/p/${project.id}/work?state=all`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByText("形态一 notUsed").first().waitFor({ timeout: 30000 });
    await page.getByText(/待返工\s*·\s*\d/).first().waitFor({ timeout: 30000 });   // the counters come with the work index read
    const body = await page.locator("body").innerText();
    for (const item of all) {
      const title = (await pool.query(`SELECT title FROM task WHERE project_id=$1 AND task_id=$2`, [project.id, item.id])).rows[0].title as string;
      assert.ok(body.includes(title), `${width}: ${title} is on the list`);
    }
    // The list's counters (the chips above the table): rework 3, awaiting acceptance 2.
    assert.match(body, /待返工\s*·\s*3/, `${width}: 待返工 count`); assert.match(body, /待验收\s*·\s*2/, `${width}: 待验收 count equals its rows`);
    if (shots) await page.screenshot({ path: `${shots}/list-${width}.png`, fullPage: true });
    for (const item of all) {
      await page.goto(`${base}/p/${project.id}/tasks/${item.id}`);
      await page.getByLabel("访问令牌").fill(token).catch(() => undefined); await page.getByRole("button", { name: "进入", exact: true }).click().catch(() => undefined);
      await page.getByText(expectLabel(item)).first().waitFor({ timeout: 30000 });
      await page.getByText(/现在：/).first().waitFor({ timeout: 30000 });   // the timeline sentence arrives with the Task reads
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      if (row(item).phase === "rework") {
        assert.match(text, /现在：返工中/, `${width}: the timeline says 返工中`);
        assert.ok(!/等验收者核对交付与实际使用/.test(text), `${width}: not waiting for an acceptance`);
        if (width >= 1100) {   // the next step is in the right column, which is a drawer on a phone
          assert.match(text, /验收者已判 (notUsed|failed)，不需要再验收/, `${width}: the next step names the consumer's answer`);
          assert.ok(!/先核对失败的结果，再安排返工/.test(text), `${width}: not the generic failed-result wording`);
        }
      } else if (row(item).phase === "awaiting_acceptance") {
        assert.ok(!/现在：返工中/.test(text), `${width}: a Task in 待验收 does not say 返工中`);
      }
      if (shots && width === 1440) await page.screenshot({ path: `${shots}/task-${row(item).phase}-${item.id.slice(0, 6)}.png`, fullPage: true });
    }
    assert.deepEqual(errors, [], `${width}: no page error`);
    await context.close();
  }
});
