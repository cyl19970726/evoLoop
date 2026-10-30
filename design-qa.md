# Workbench design QA — completed reading layouts

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
