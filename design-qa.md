# Task workspace image-to-code QA (historical)

Source design:

- Fixed Document `37455fe9-91ca-4659-8740-37151ebc54f6@e43a052c-c6e2-42d8-b300-4e49126b0566`
- List reference: `.local/task-production/reference-task-list.png`
- Detail reference: `.local/task-production/reference-task-detail.png`

Implementation evidence:

- List, 1487 x 1058 CSS pixels, density 1: `.local/task-production/implementation-task-list-final.jpg`
- Detail, 1487 x 1058 CSS pixels, density 1: `.local/task-production/implementation-task-detail-final.jpg`
- List, 1440 x 1024: `.local/task-production/implementation-task-list-1440x1024.jpg`
- Detail, 1440 x 1024: `.local/task-production/implementation-task-detail-1440x1024.jpg`
- Detail width correction, 1440 x 1024: `.local/task-production/implementation-task-detail-width-fix-1440x1024.jpg`
- List, 1171 x 635: `.local/task-production/implementation-task-list-1171x635.jpg`
- Detail, 1171 x 635: `.local/task-production/implementation-task-detail-1171x635.jpg`
- List, 871 x 768: `.local/task-production/implementation-task-list-871x768.jpg`
- Detail, 871 x 768: `.local/task-production/implementation-task-detail-871x768.jpg`
- List, 390 x 844: `.local/task-production/implementation-task-list-390x844.jpg`
- Detail, 390 x 844: `.local/task-production/implementation-task-detail-390x844.jpg`
- Combined list comparison: `.local/task-production/comparison-task-list-final-1487x1058.png`
- Combined detail comparison: `.local/task-production/comparison-task-detail-final-1487x1058.png`

The reference and implementation captures are both 1487 x 1058 pixels at density 1. The combined images place both sources in one comparison input and add only a 54 px label strip; neither panel was otherwise cropped or rescaled.

## States

- Task list: default six columns, no optional columns, unfinished-work filter, selected pending frontend-acceptance Task, table at its left scroll position.
- Task detail: current fixed Task revision, Overview tab, two visible completion conditions, remaining conditions collapsed, full body open, light evidence rail visible.
- Additional checks: optional “固定成果” column, row A/B switching, independent horizontal scrolling, full Task navigation, return preserving `scrollLeft=649`, 1171 side-by-side layout, 871 sequential layout, and 390 card layout.

## Fidelity result

No actionable P0, P1, or P2 visual findings remain.

- Fonts and typography: the implementation keeps the product's system Chinese sans-serif stack, 16 px body text, 14 px secondary facts, clear list/detail hierarchy, and does not fall back to Latin-first typography. Long Task goals are limited to the first authored sentence and clamped in the summary.
- Spacing and layout rhythm: the list title, top controls, table header, six-column scroll surface, and persistent right summary align with the reference's proportions. The list grid is `695.703px + 351.297px` at 1171. The detail narrative is wider than the evidence rail: `686px + 300px` at 1440 and `550px + 280px` at 1280, with page overflow false. At 871 and 390, the detail evidence rail follows the narrative in DOM order.
- Colors and tokens: blue/white surfaces, neutral text, restrained warm alerts, and gray rules follow the reference and the product's no-green rule.
- Icons and assets: the screen uses the product-owned wordmark and existing Lucide icon family. The reference contains no illustration, photo, product image, or custom icon asset requiring generation.
- Copy and content: labels use real Task, assignment, completion, Delivery, and observation facts. No fabricated event time or fake result is shown.
- Accessibility and responsiveness: column headers are semantic, row selection and open-detail are separate controls, the table region is focusable, controls are labeled, and page overflow was false at 390, 871, 1171, 1440, 1920, and 2560 CSS px.

The remaining differences are expected:

- The reference uses illustrative task names, counts, dates, and four rows. The implementation shows the real two unfinished Tasks and the real `candidate-consumer` session, so matching text is impossible and undesirable.
- The fixed design requires six columns even though the reference image compresses some responsibility text into the row. The implementation preserves all six columns and scrolls the table independently; the first Task column remains sticky while reading later columns.
- The reference depiction includes green check styling. The project's authoritative no-green constraint uses blue and neutral check text instead.
- The currently running 55431 service is release `285510cda6`, before this branch's `latestProgress` projection. The live screen therefore correctly shows `未记录 / 没有可归属的真实业务事件`; the current adapter was separately exercised against PostgreSQL and returned direct `dependency`, `task`, and `delivery` events without substituting `businessChangedAt`.

## Comparison history

1. P1: The legacy `max-width:1200px` rule moved the summary into column one and reversed the intended table/reader order at 1171.
   Fix: assigned explicit grid rows and columns and added higher-specificity responsive overrides.
   Recheck: 1171 measured `695.703px + 351.297px`, summary to the right, page overflow false.
2. P1: At 1171 x 635, 871 x 768, and 390 x 844, the Task body began below the first viewport.
   Fix: two visible conditions on desktop, one on mobile; secondary acceptance notes moved behind disclosure; compact short-height spacing.
   Recheck: body begins at 606 px / 635 px, 706 px / 768 px, and 765 px / 844 px respectively.
3. P2: The old table column rules hid column four and collapsed later columns to a few pixels, producing a 489 px row.
   Fix: explicit `<colgroup>`, table minimum width, semantic six-column headers, and overrides for legacy selectors.
   Recheck: six headers are present, the final desktop row is about 105 px high, and only the table scrolls horizontally.
4. P2: The summary initially repeated nearly the whole Task body, including internal UUID text.
   Fix: use the first real sentence, clamp to three lines, and prefer the stage goal when available.
5. P2: Desktop controls wrapped unevenly and pushed the table down.
   Fix: compact one-row desktop control grid with a stacked fallback below 1350 px.
6. P2: Horizontal table scrolling lost Task identity.
   Fix: keep the first column sticky on desktop, while returning the table to stacked cards and disabling sticky positioning below 760 px.
7. P1: Independent review found the 1440 Task narrative was only about 587 px wide and fell to about 470 px at 1280 because the evidence track used viewport-relative `27vw`.
   Fix: measure the evidence rail from the content grid with a 300 px desktop cap, 280 px at 1280, and a 32 px or 28 px gutter instead of viewport width.
   Recheck: 1440 narrative measured 686 px with a 300 px evidence rail; 1280 measured 550 px with a 280 px rail; both retained the two left rails and reported no page overflow.

## Additional page check

The shared Document list and full Document reader were opened after the Task changes at 1487 and 390 CSS px. Both retained their existing layout, loaded 50 list rows, exposed a full reading body and evidence aside, and reported no page-level overflow or browser console errors. This change does not restyle those pages.

## Test evidence

- `npm run typecheck`: passed.
- `npm run test:unit` with PostgreSQL: 889 tests, 853 passed, 36 skipped, 0 failed.
- `packages/adapter-postgres/test/work-index.test.ts` with PostgreSQL: 14 passed, including direct latest-progress event and not-renamed-`businessChangedAt` assertions.
- `npm run test:docs`: 42 passed.
- `npm run docs:build`: 67 pages built.
- `npm run build --workspace @evoloop/workbench`: passed.
- In-app browser console: no errors after final navigation and interaction checks.

## Implementation checklist

- [x] Six default columns and separate column settings.
- [x] Independently scrolling table with sticky Task identity.
- [x] Persistent right summary at 1171 and wider desktop sizes.
- [x] Selection-only summary update and explicit full-detail entry.
- [x] Article-first detail layout with body and completion conditions in the first viewport.
- [x] Real creation time and event-backed latest progress with honest fallback.
- [x] Preserve PR167 pagination behavior.
- [x] Verify 390, 871, 1171, 1440, 1920, and 2560 widths.
- [x] Verify Document list and reader remain usable.

## Follow-up polish

- Once this branch's backend is deployed, capture the populated “最近进展” column against the same real sample and replace the current “未记录” fallback screenshot.

final result: passed

---

# Sessions workspace image-to-code QA (current)

Date: 2026-10-31 (Asia/Taipei). This section covers the approved Sessions directory, detail and conversation redesign. It is visual and technical evidence, not the Lead's independent acceptance.

## Comparison target and evidence

- Source visual truth: fixed Design Document `e6b83216-6140-4aa4-8b84-d8030fb4ebcb@be4202db-6d91-4f24-bc00-43ab391e10a8`, image `/Users/hhh0x/.codex/worktrees/task-production-experience/evoLoop/.local/sessions-redesign-20261031/design-be4202db/assets/session-message-workspace.png`, `1487×1058` RGB.
- Normalized source: `.local/sessions-redesign-20261031/compare-top.png` and `compare-conversation.png` resize the source to `1440×1024` before placing it beside the implementation in one image.
- Implementation: production build served locally at `http://127.0.0.1:55444`, connected by a local read-through proxy to the real coordinator API. CSS viewport `1440×1024`, device pixel ratio 1.
- External Session full view: `.local/sessions-redesign-20261031/screenshots/final-session-detail-1440-v8.jpg`.
- Combined structural comparison: `.local/sessions-redesign-20261031/source-vs-implementation.png`; focused top comparison: `compare-top.png`; focused conversation comparison: `compare-conversation.png`.
- Managed conversation comparison: `.local/sessions-redesign-20261031/source-vs-managed-implementation.png`, using `.local/sessions-redesign-20261031/screenshots/final-managed-session-tools-1440-v5.jpg`.
- Directory states: `.local/sessions-redesign-20261031/screenshots/final-directory-1440-v5.jpg` and `final-directory-390-v3.jpg`.
- Responsive implementation captures: `final-session-detail-1171-exact.jpg`, `final-session-detail-871-v3.jpg`, and `final-session-detail-390-v3.jpg`.

The source and implementation represent different data states. The source uses illustrative Agent messages and a short example reply. The implementation uses the real external frontend Session and its stored manual-handoff message; the managed comparison uses the real Session Experience messages, original Thread replies and two observed tool items. Layout structure is compared; record values and text length are not treated as visual defects.

## States

- External Session: `功能开发 · 前端文档与工作台`, activity/conversation tab, manual handoff semantics, current Task visible, one stored external message, input visible.
- Managed Session: `功能开发 · Session 体验`, idle after two ordinary-message turns, completed response plus failed read-only tool attempt, tool summary visible and composer visible.
- Directory: current business/System/unclassified groups, compact sidebar group disclosure and complete main catalog.
- Responsive checks: `1440×1024`, `1171×900`, `871×1171`, and `390×844`; every measured page had `scrollWidth === innerWidth`.

## Fidelity result

No actionable P0, P1, or P2 visual findings remain.

- Fonts and typography: system Chinese sans-serif stack; title hierarchy, body and secondary-fact sizes remain readable. Markdown replies preserve headings, lists, code and links. Long identifiers and permission values wrap without expanding the page.
- Spacing and layout rhythm: shared two-rail shell, title, current-Task card, compact Agent band, tab row, conversation, tool summary and composer now follow the approved structure. At 1440 the context band is about 139 px high, tabs begin around 342 px, and the conversation composer begins around 741 px. At 871 the project rail collapses and content uses the available width; at 390 the structure becomes one column with a 324 px message column.
- Colors and tokens: white/blue surfaces, navy typography, neutral rules, and warm failure/attention states; no green is introduced.
- Assets/icons: source contains only application UI, text and standard icons. No raster illustration required generation. The implementation reuses the product's existing Lucide icon family and `eL` wordmark.
- Copy/content: real Task, Session, actor, message, processing, tool and recovery facts remain distinct. External Sessions explicitly show unsynchronized realtime state. Saving, processing, replying, reading and manual handoff are not merged.

## Findings and fixes

1. P1: Agent values initially wrapped one character per line because the global `dl>div` rule applied a two-column grid inside the narrow Agent card.
   Fix: reset each Agent field to a one-column grid and keep the three first-screen fields on one row.
   Recheck: the field labels and values render horizontally at 1440 and 871; dynamic permission values wrap as whole tokens.
2. P1: The first implementation pushed the conversation and composer below the fold because a redundant four-item fact band consumed a full row.
   Fix: remove the duplicate band, move assignment/queue/result facts into the Task and queue tab, compact the Agent band, and constrain the activity viewport.
   Recheck: at 1440 the composer begins around 741 px and remains fully visible in the 1024 px viewport.
3. P1: After sending a message, the old implementation opened a stale message-detail panel and left the actual reply hidden while processing advanced.
   Fix: keep the conversation in view after saving, preserve processing records across polls, and fetch missing terminal processing records only as a compatibility fallback.
   Recheck: the actual managed response and two-item failed tool summary are visible without opening raw project events.
4. P2: The sidebar rendered all current Sessions inside the shared navigation, pushing System Sessions and the full-directory entry below the fold.
   Fix: show a compact overview of two business, two System and one unclassified Session; always retain the selected Session; expose the complete searchable catalog through the dedicated Sessions page.
   Recheck: both formal classes and the complete-directory entry are visible at 1440 without reducing the conversation column.
5. P2: Re-polling could re-enable “load earlier messages” after the final history page had already been exhausted.
   Fix: preserve the expanded-history state across polls; only initialize the cursor before the user starts loading older messages.
   Recheck: the cursor remains exhausted until the user explicitly starts a new history read.
6. P2: The full directory rendered empty history/unclassified messages when those reads had actually failed.
   Fix: distinguish loading, error and empty states per group and provide an inline retry without replacing unread data with a normal empty state.
   Recheck: sidebar category retry passes, and the full directory no longer reports failed reads as empty results.

Remaining P3 polish:

- The source uses illustrative records; exact row count, text stops and bubble height necessarily differ with real project data.
- The source uses a small role bullet and a compact information icon in its activity banner; the implementation uses the product's existing icon and text conventions.
- A managed Session with a failed tool correctly expands the failure by default, while the source example shows a successfully collapsed tool summary.

## Interaction and runtime evidence

- Full directory and search were exercised against the real API; menu navigation at 390 lists Work and Sessions first, then project functions and the unique Session catalog.
- Session → Task → return preserved the canonical Sessions route, activity tab and filter.
- Ordinary managed-message turn 1:
  - message `bc672cbe-0ef4-4b2f-8e19-83a88fdeb93f`, state `replied`;
  - processing `156bf0db-16ba-4c81-bdf3-43597954412f`, native Turn `01a19210-0d01-7242-89a8-8a000736e661`;
  - original Thread response: `Sessions 普通消息测试已收到。`
- Ordinary managed-message turn 2:
  - message `8b06bb25-cd52-464c-a9a2-60776a491311`, state `replied`;
  - processing `481b7bae-aca8-4588-bac6-31f3937fce9b`, native Turn `01a19211-2be9-70d0-b1b6-e5540c8e2d99`;
  - two tool activities observed, one failed and one completed;
  - final response truthfully reports that `docs/frontend/README.md` could not be read from that Session's cwd.
- Ordinary managed-message turn 3:
  - message `0ff0149b-b4a3-4f8b-8ef9-4a4c05406057`, state `replied`;
  - processing `c90fa24d-7dc8-40de-9990-79566a9204d4`, native Turn `01a1924f-439e-7820-a5c5-85a9e61201b3`;
  - one read-only tool completed;
  - final response rendered from Markdown as `文档导航`.
- The managed Session was verified before sending: `ready`, `busy:false`, active `gpt-6-sol`, `danger-full-access`, `never`, open recovery gate, zero prior messages, configured budget 12, three Turns used.
- External Session remained manual-only. No automatic delivery, native model/tool activity or read receipt was inferred.
- Browser console: no error or warning entries on the final external and managed Session checks.

## Test evidence

- `npm run typecheck`: passed.
- `npm run docs:check`: passed, 67 published pages and 16 assets.
- `npm run test:unit`: 891 tests, 854 passed, 37 opt-in/integration tests skipped, 0 failed.
- Session browser regressions: 12 passed, 0 failed, including directory pagination/retry, close recovery, history switching, native input, native progress, recovery races, polling, message entry and the new Sessions redesign journey.
- Task browser regressions: 3 passed, 0 failed, preserving PR167/168 Task list, detail, owner and Session-link behavior.
- Schedule → Run → Session browser regression: passed with the canonical Sessions path.
- `npm run build`: passed. Vite reports only its existing module-directive and large-chunk warnings.

final result: passed

---

# Workbench design QA — completed reading layouts (historical)

Date: 2026-10-31 (Asia/Taipei). Replaces the earlier c2 visual self-check; the earlier report remains in Git history. This is implementation/visual QA, not human aesthetic acceptance or production deployment.

## Comparison target and evidence

- Source visual truth: twelve desktop candidate frames from the 2026-10-30 frontend design review; exact files and source hashes remain in the private design manifest. The selected two-rail, blue/white direction is retained. Illustrative records are not application data.
- Implementation: this PR's application changes over base `c2df2a2`; exact changed source file hashes are in `.local/frontend-completion-20261030/application-source-manifest.json` (SHA-256 `0eda79c6399d4d436e77883d60188c1e7deb0bb551a9e4a2f2b77209a37201a7`). The built preview connects to the existing API; live captures block every API write.
- Whole-view comparisons: `.local/frontend-completion-20261030/comparisons/{01-tasks,02-task-detail,03-overview,04-documents,05-document-reader,06-knowledge,07-schedules,08-team,09-session,10-operations,11-repository,12-settings}-pair.jpg`. Matching `-detail.jpg` files compare the dense content region `(380,100)–(1480,900)` from both views.
- Implementation screenshot paths: matching `*-raw.png` files in that evidence directory. Source and final implementation are both 1487×1058 pixels, CSS viewport 1487×1058, deviceScaleFactor 1. Final comparisons require no density rescaling. Earlier IAB/ego captures with different density, animation or loading states are superseded by these settled built-app captures.
- State: desktop/light, existing authenticated project; current records differ from the illustrative references. The original recovery task is now cancelled and has no current-revision delivery. Current project goal/body is longer; all such differences are preserved rather than replaced with mock content. `captures-tasks.json` waits for the current-work projection. `captures-documents.json` waits for lifecycle references, the fixed-body outline and diagram SVG.
- Responsive evidence: five core routes at 390×844, workspace geometry at 1171, 1440 and 1920px, and narrow create-task/journey/inbox/evaluation routes. `captures-final.json`, `captures-tasks.json`, `captures-documents.json` record routes, dimensions, errors and write guard results.

## Findings and comparison history

| Earlier finding | Implemented fix | Post-fix evidence |
| --- | --- | --- |
| Collapsed navigation moved content below the rail | Preserve rail/zero-width-sidebar/content grid tracks; await the actual breakpoint state in the regression | `work-1171-raw.png`, 1440/1920 captures; changed-flow browser log |
| First heading faded; overview regions appeared in the wrong order | Remove first-child fade, retain dark heading tokens; explicit goal → priority → current work/recent feedback layout | 03 pair/detail and final independent review |
| Dense document/team rows and duplicate metadata | 16px row names, 14px secondary facts, readable padding, compact revision relationship, accessible exact versions/details | 04/08 pair/detail; document lifecycle capture |
| Knowledge/schedule lacked desktop hierarchy | Fixed references beside available actions; schedule basic facts beside trigger/result, provenance disclosed | 06/07 pair/detail |
| Session metadata pushed activity off the first screen and composer covered content | Main activity column and information/handoff rail; static composer, narrow sequential reading | 09 pair/detail, 390px capture, message and activity regressions |
| Task completion conditions were a continuous long paragraph | Render only explicitly contiguous numbered conditions as an ordered list; retain prose and version numbers unchanged | Latest 02 pair/detail; three acceptance regressions; final independent P2 closure |
| Document fixed version and long-body navigation were weak | Selected revision beside the title; desktop/mobile outline focuses actual fixed-body headings without replacing the route | Latest 05 pair/detail; `captures-documents.json` |
| Fixed-history result shortcut could discard the selected revision | Hide current-delivery shortcut in a fixed history view | Integrated source review; current result shortcut remains on current task |
| Filtered reader and close action were misleading | Label a retained Task outside current results; keep an explicitly dismissed reader closed | Discovery/list-owner browser regressions |

## Required fidelity surfaces

- Fonts/typography: system/PingFang sans stack; 32px route headings, 16px reading/body and row names, 14px secondary facts; conditions separate into readable clauses. Long live names/content wrap. Final independent review found no remaining actionable typography P1/P2.
- Spacing/layout: two navigation rails; task table above the reader with bounded table scrolling; task narrative and evidence rail; document article/outline/source rail; overview and knowledge/schedule groups; Session activity and handoff rail. Narrow layouts preserve reachability and no recorded page overflow.
- Colors/tokens: dark navy text, blue actions/selections, neutral and warm failure/warning treatments; no green state substitution. Initial first-frame fade removed.
- Assets/icons: existing Lucide library icons and canonical `eL` brand; blue repository icon tiles. No screenshot is used as an application surface. Diagram is rendered in the existing non-executing sandbox; SVG readiness was checked before the final document capture.
- Copy/content: actual API records, revisions, source restrictions and capabilities; assignment, Run, technical result, Agent use and human use remain distinct. Saving manual handoff does not claim delivery or acceptance. No fake settings switches or illustrative records added.

## Validation and limits

- Build/typecheck passed. Unit checks: 826 passed, 32 opt-in browser checks skipped, 0 failed. Documentation tests: 42 passed; document check/build passed.
- Changed paths: 9 browser/presentation cases passed, 0 failed, covering cross-page Task/document discovery and return, stale owners, reader dismissal, breakpoint geometry, schedule→Run→Session, message/manual entry, narrow activity, and acceptance formatting.
- Live built-app verification: 24 route/viewport records passed; additional settled Task and document/outline captures passed. No page errors, page overflow or API write attempt was recorded. Source values changed during the long session; the capture identity is recorded rather than assumed.
- Independent visual/source review: `.local/frontend-completion-20261030/final-independent-review.md`; all twelve whole views plus focused and mobile evidence were inspected. Its final residual disposition closes the only remaining P2. The first independent review is retained as historical evidence, not presented as a final pass.
- The older full opt-in browser suite is **not green**: its last complete run had 16/26 failures, and the original c2 baseline also had 16/26. The two latest changed-flow differences were subsequently resolved and covered by the passing focused suite; other baseline checks were not rewritten or disabled. Do not report the complete suite as passed. No human aesthetic acceptance, full-scroll asset audit, accessibility compliance, production API guarantee or release to the original service is claimed.

P3 follow-up: exact illustrative row counts, copy length and icon variants differ; these are documented data/library differences. Future surfaces/states still need their own evidence when changed.

final result: passed

The current delivery is the Sessions workspace section above; this trailing historical section is retained so earlier Task and reading-layout evidence is not lost.
