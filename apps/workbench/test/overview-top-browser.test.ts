// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (EVOLOOP_OVERVIEW_SCREENSHOT_DIR keeps the shots).
// The overview's top (docs/frontend/overview-top-design.md): the goal, the deployed version, the six roadmap phases with one current phase, and the
// three blocks below, at 1440x900 and 390x844: all of it where the design puts it, nothing past the right edge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_OVERVIEW_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "42000001-0000-4000-8000-000000000001", goalId = "42000009-0000-4000-8000-000000000009", stageId = "42000011-0000-4000-8000-000000000011";
const stamp = "2026-11-12T08:00:00.000Z";
const phases = [
  ["M0", "正式定义与仓库", "产品目标、架构边界、规范、决定和可重建文档站；供后续切片共用同一判断依据", "新 checkout 能重建，未参与编写者能按文档解释一个目标→任务→使用→下一步的场景并定位边界"],
  ["M0.5", "技术与包边界确认", "为首片选定栈、共同 API、主数据/外部正文权威和进程依赖", "选择、替代与代价可追，实际包依赖不越界；证据不足时缩小实现范围"],
  ["M1", "任务与单次交接", "在一个已有或新建项目中明确目标、阶段交付、学习问题、消费者和授权，接受有界任务", "一条 dogfood 修复/需求改版任务从接受基线走到真实交付与目标消费者使用"],
  ["M2", "认识改变后续行动", "在 M1 可交接和可亲用的工作上接 S4 外置 Wiki 的来源、反例、修订与受控发布", "用户纠正或反例改变一个有理由的后续选择，新 session 正确采用指定修订"],
  ["M3", "分工管理试行", "在已观察的遗漏、返工、切换或负担上比较改方法、续开会话、临时专项和新职责", "试行记录责任边界、首项工作、原基线、成本和退出条件"],
  ["M4", "持续使用与发布", "将 S3 到期/重叠/暂停恢复与 S4 知识使用纳入受管项目试点；建立常在线运行", "至少两次相连的行动、亲用、认识变化与下一动作能互相追证"],
];

test("overview top: goal, version, six phases with one current, the three blocks below; measured at 1440x900 and 390x844",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    let mode: "linked" | "day1" | "unread" | "multi" = "linked";
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname === "/__fixture") { mode = (url.searchParams.get("mode") as typeof mode) ?? mode; res.end("ok"); return; }
      if (url.pathname.startsWith("/api/")) {
        const base = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null }, status = 200;
        if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
        else if (url.pathname === "/api/version") {
          if (mode === "unread") value = { commit: null, builtAt: null, startedAt: stamp };
          else value = { commit: "9a4020a5886be01b2d74fe850687ca7355b2d226", builtAt: "2026-11-12T03:10:00.000Z", startedAt: stamp };
        }
        else if (url.pathname === base) value = { id: projectId, title: "总览顶部项目", createdAt: stamp };
        else if (url.pathname === `${base}/impacts` || url.pathname === `${base}/resident-queues`) value = [];
        else if (url.pathname === `${base}/goals`) value = { items: mode === "day1" ? [] : [{ projectId, id: goalId, version: 1, outcome: "让使用者一眼看清项目要去哪里", constraints: "数据来自服务", consumer: "使用者",
          authority: "负责人", scope: "总览", owner: "o", createdAt: stamp, actorId: "reader" }], nextCursor: null };
        else if (url.pathname === `${base}/stages`) value = mode === "day1" ? [] : mode === "multi" ? phases.slice(0, 5).map(([key, title, deliver, exit], index) => ({ projectId, id: `4200001${index}-0000-4000-8000-00000000001${index}`, goalId, version: 2, state: "active",
          deliverable: `${key} ${title}：${deliver}；${exit}`, learningQuestion: `${key} 要弄清：${exit}，并且这一段文字故意写得很长，用来证明多个进行中的阶段不会把版本和里程碑挤出首屏`, createdAt: stamp, actorId: "reader" })) : [{ projectId, id: stageId, goalId, version: 2, state: "active", deliverable: "总览顶部", learningQuestion: "看得清吗", createdAt: stamp, actorId: "reader" }];
        else if (url.pathname === `${base}/milestones`) {
          const linked = mode === "linked", multi = mode === "multi";
          value = { source: { commit: "9a4020a5886be01b2d74fe850687ca7355b2d226", roadmap: "read" }, currentPhaseId: linked ? "M1" : null, currentNote: linked ? null : multi ? "有多个进行中的阶段，不猜哪个是当前" : "当前阶段未登记",
            phases: phases.map(([id, title, deliver, exit]) => {
              const status = multi ? "in_progress" : !linked ? null : id === "M0" ? "partial" : id === "M0.5" ? "exited" : id === "M1" ? "in_progress" : "not_started";
              const label = { partial: "部分成立", exited: "已退出", in_progress: "进行中", not_started: "未开始" } as Record<string, string>;
              return { id, title, deliver, exit, status, statusLabel: status ? label[status] : null, stage: status ? { id: stageId, goalId } : null, linkedStages: status ? 1 : 0,
                reviewedAt: linked && (id === "M0" || id === "M0.5") ? "2026-11-10T09:00:00.000Z" : null };
            }) };
        }
        else if (url.pathname === `${base}/work-management/index`) value = { items: [], nextCursor: null, partial: false, changeSequence: 1, total: 0, counts: {}, observedAt: stamp };
        res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
      try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
    t.after(() => browser.close());
    const errors: string[] = [];
    const measured: unknown[] = [];
    const open = async (width: number, height: number, state: string) => {
      await fetch(`${base}/__fixture?mode=${state}`);
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${base}/p/${projectId}/overview`);
      await page.getByLabel("访问令牌").fill("fixture-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.locator("#workspace-main:focus").waitFor();
      await page.locator("[data-overview-milestones] [data-phase]").first().waitFor({ timeout: 8000 });
      return page;
    };
    const measure = async (page: import("playwright-core").Page, label: string) => {
      const result = await page.evaluate(`(() => {
        const top = (selector) => { const e = document.querySelector(selector); return e ? Math.round(e.getBoundingClientRect().bottom) : null; };
        const rows = [...document.querySelectorAll("[data-overview-milestones] [data-phase]")];
        return { viewport: innerWidth + 'x' + innerHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
          goalBottom: top(".overview-goal"), versionBottom: top("[data-overview-version]"), milestonesBottom: top("[data-overview-milestones]"), lastPhaseBottom: Math.round(rows[rows.length - 1].getBoundingClientRect().bottom),
          attentionTop: Math.round(document.querySelector(".overview-attention").getBoundingClientRect().top), phaseCount: rows.length,
          pastRightEdge: [...document.querySelectorAll("main *")].filter(e => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 0.5).length };
      })()`) as Record<string, number>;
      measured.push({ label, ...result });
      return result;
    };

    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await open(width, height, "linked");
      const blocks = page.locator("[data-overview-top]");
      // Six phases in roadmap order; exactly one current; the version in its own words.
      const ids = await page.locator("[data-overview-milestones] [data-phase]").evaluateAll(items => items.map(item => item.getAttribute("data-phase")));
      assert.deepEqual(ids, ["M0", "M0.5", "M1", "M2", "M3", "M4"]);
      assert.equal(await page.locator("[data-overview-milestones] [data-current='true']").count(), 1);
      assert.equal(await page.locator("[data-overview-milestones] [data-current='true']").getAttribute("data-phase"), "M1");
      const text = await blocks.innerText();
      assert.match(text, /源码提交[\s\S]*9a4020a/); assert.match(text, /构建时间[\s\S]*2026-11-12 03:10 UTC/); assert.match(text, /启动时间/); assert.doesNotMatch(text, /发布时间/, "the start time is not called the release time");
      const links = await page.locator("[data-overview-version] a").evaluateAll(items => items.map(item => item.getAttribute("href")));
      assert.deepEqual(links, ["https://github.com/cyl19970726/evoLoop/commit/9a4020a5886be01b2d74fe850687ca7355b2d226", "https://github.com/cyl19970726/evoLoop/blob/main/docs/roadmap.md#当前基线", "https://github.com/cyl19970726/evoLoop/blob/main/docs/development/local-run.md"]);
      assert.ok((await page.locator("[data-phase][data-current]").innerText()).includes("退出证据"), "the current phase shows its exit evidence");
      for (const word of ["部分成立", "已退出", "进行中", "未开始", ...(width >= 1000 ? ["回看于 2026-11-10", "未登记"] : [])]) assert.ok(text.includes(word), word);
      if (shots) { await page.screenshot({ path: `${shots}/overview-top-${width}.png` }); await page.screenshot({ path: `${shots}/overview-top-${width}-full.png`, fullPage: true }); }
      const m = await measure(page, `linked ${width}x${height}`);
      assert.equal(m.scrollWidth <= m.clientWidth, true, `no horizontal overflow at ${width}`);
      assert.equal(m.pastRightEdge, 0, "nothing past the right edge");
            // The phone's bottom tab bar (about 64px) covers the lower edge of the screen, so "on the first screen" means above it.
      assert.ok(m.lastPhaseBottom <= height - (width >= 1000 ? 0 : 64), `all six phases are on the first screen at ${width}x${height} (last bottom ${m.lastPhaseBottom})`);
      assert.ok(m.goalBottom! < m.versionBottom! + 1, "the goal is above the version and milestones");
      assert.ok(m.attentionTop >= m.milestonesBottom!, "the three blocks sit below the milestones");
      for (const label of ["本次优先核对", "最近使用反馈"]) assert.ok(await page.getByLabel(label).count() === 1, label);
      await page.close();
    }
    // Day one: nothing linked, no goal: everything reads 未登记, no phase is highlighted, and the page says why.
    const day1 = await open(390, 844, "day1");
    assert.equal(await day1.locator("[data-overview-milestones] [data-current='true']").count(), 0, "no guess at a current phase");
    assert.equal(await day1.locator("[data-current-note]").innerText(), "当前阶段未登记");
    assert.equal((await day1.locator("[data-overview-milestones]").innerText()).match(/未登记/g)!.length >= 6, true, "the status of all six phases says 未登记");
    assert.doesNotMatch(await day1.locator("[data-overview-milestones]").innerText(), /部分成立|已退出|进行中|回看于/);
    await measure(day1, "day1 390x844");
    if (shots) await day1.screenshot({ path: `${shots}/overview-top-390-day1.png` });
    await day1.close();
    // The real project's case: five stages all active (M0-M4). Nothing is guessed as current, the stage list folds, and the first screen still holds
    // the goal, the version and all six phases at both sizes.
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const multi = await open(width, height, "multi");
      assert.equal(await multi.locator("[data-overview-milestones] [data-current='true']").count(), 0, "no guess at a current phase");
      assert.equal(await multi.locator("[data-current-note]").innerText(), "有多个进行中的阶段，不猜哪个是当前");
      const picker = multi.locator("[data-stage-picker]");
      assert.equal(await picker.count(), 1, "the stage list is one folded block");
      assert.equal(await picker.evaluate(node => (node as HTMLDetailsElement).open), false, "folded until opened");
      const m = await measure(multi, `multi-active ${width}x${height}`);
      if (shots) await multi.screenshot({ path: `${shots}/overview-top-${width}-multi-active.png` });
      assert.equal(m.scrollWidth <= m.clientWidth, true, `no horizontal overflow at ${width}`);
      assert.equal(m.pastRightEdge, 0);
      assert.equal(m.phaseCount, 6);
      assert.ok(m.versionBottom! <= height - (width >= 1000 ? 0 : 64), `the version is on the first screen at ${width}x${height} (bottom ${m.versionBottom})`);
      assert.ok(m.lastPhaseBottom <= height - (width >= 1000 ? 0 : 64), `all six phases are on the first screen at ${width}x${height} (last bottom ${m.lastPhaseBottom})`);
      await picker.locator("summary").click();
      assert.equal(await picker.locator("button").count(), 5, "opening the list shows all five stages");
      await multi.close();
    }
    // The version could not be read: never an old value.
    const unread = await open(1440, 900, "unread");
    const version = await unread.locator("[data-overview-version]").innerText();
    assert.match(version, /版本未读到/); assert.doesNotMatch(version, /9a4020a/);
    await unread.close();
    if (shots) { const { writeFile } = await import("node:fs/promises"); await writeFile(`${shots}/overview-top-real-measure.json`, JSON.stringify(measured, null, 1)); }
    assert.deepEqual(errors, []);
  });
