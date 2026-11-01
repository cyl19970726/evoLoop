# Unified Session workspace — image-to-code QA

2026-11-02 · Author visual and interaction QA. This replaces the old PR173 author result; that record remains in Git history and the private iteration archive. This pass does not establish independent consumer use, user aesthetic acceptance, merge or release.

## Comparison evidence and conditions

- Source visual truth: `.local/session-workspace-implementation/reference.png`, the selected 1536×1024 image from the adopted Task basis.
- Current build: `http://127.0.0.1:55522/?build=Dzl1zQ8x`; browser DOM confirms `/assets/index-Dzl1zQ8x.js`, matching the served index and current production build. A previously open tab retained an older client; it was excluded from the final comparison and replaced with a fresh authorized tab.
- Implementation screenshot: `.local/session-workspace-implementation/screenshots/final-reference-current.png`, 1536×1024, same light theme, same selected Session, expanded task/Agent context and latest conversation position as the visual target.
- Full joint comparison: `screenshots/source-vs-final.png`, 3072×1060 including a 36px comparison label. Both 1536×1024 images were placed together without scaling.
- Focused joint comparison: `screenshots/source-vs-final-context.png`, headings, context values and tabs cropped at the same coordinates. It was inspected separately to assess typography, wrapping, spacing and controls.

The source contains illustrative conversation copy. The implementation displays the actual stored business history at its latest position, including original public text and failures. It does not seed mock messages, infer unproved senders or replace a historical delivery with the mock's assumed current Task. Content and length differences are evaluated separately from visual hierarchy; a pixel-error score would be misleading.

### Density normalization

The final IAB reports DPR0.75. A physical override of1152×768 produced a measured CSS document1536×1024. Raw output2048×1365 contains blank canvas outside the actual document; the saved comparison crops only the measured document boundary at origin. It does not downscale text or stretch the layout. Likewise, the2880×1772 capture had3840×2363 raw output; the phone was approximately390.667×844 CSS and521×1125 raw. Root/document bounds were checked before cropping.

Earlier ego-browser normal-window measurements and captures remain in the private evidence archive. Its original TaskSpace was unavailable later; final screenshots use the Product Design IAB with explicit measurements. This is disclosed rather than treating an old ego capture as proof of the final client. Exact1171/871/390 integer viewports are separately covered by the built-app browser suite.

## Findings resolved and comparison history

| Severity / earlier finding | Fix and post-fix evidence |
| --- | --- |
| P1: Separate recent-business-reply card and bottom audit break the conversation | Replaced the old components with one typed message/tool stream. Project audit and recovery remain in Session information. Current full comparison shows the continuous reading surface. |
| P2: Context consumes excessive height and Agent values wrap vertically | Context defaults to a compact expandable strip; expanded values use available-width columns and single-column label/value pairs. Removed87 legacy cross-page Session selectors. Focused current comparison and phone capture show readable values. |
| P2: Cached hidden Session changed the Task shell | Apply Session layout only to the active canonical route using `data-session-reader`; three cached Task routes retain their normal64px shell and grid. Built-app browser regression passed. |
| P2: Tall wide view shows substantial blank space while older history exists | Initial wide evidence `screenshots/reviewed-2880.png` was blocked. Added bounded history fill through the existing pagination, at most three rounds per mounted scope, only while following latest. Current `screenshots/final-autofill-2880.png/json` shows four actual messages and adjacent tool groups instead of only the tail's two messages. Reading column1480px; stream1443px; remaining top space169px; composer bottom1760 within1772. Tests verify the budget, filled-pane stop, no paging after scrolling to history and genuinely short exhausted threads. |
| P2: Growing input or width changes hide history / move the input | Flex viewport layout and internal history scroll; visible-entry anchor recovery; stable composer. Actual phone input40→120px reduced history431.5→351.5px while composer bottom stayed832/844; no overlay. Test text was cleared without sending. |
| P2: Following latest was lost after wide→phone reflow | New scrollHeight cannot reconstruct the previous bottom position. The observer now retains the reader’s prior follow intention. Earlier failed capture: `screenshots/before-resize-fix-phone.png`; final phone has latest reply bottom686.54, composer top709.17 and no overflow. Final reference/latest is914.67/937.52. Focused browser verifies wide→390→871→2880 plus the separate older-reading case. |
| P2: Detail dismissal loses keyboard focus | Controlled dialog restores the connected visible trigger. Actual restricted-tool dialog and Escape were tested; built-app regression also passed. |
| P1: Historical running Turn falsely appears currently processing | Only a scoped current start supplies activeTurnId; matching terminal, disconnect and reset clear it. Known terminal cannot reopen on late start. Empty-but-active stream does not show the initial empty prompt. Coordinator and browser regressions passed. |
| P1/P2: Late source binding, resets and old pages duplicate or reorder history | Exact aliases, independent source positions, reset/history epochs, aborts and visible-entry anchors. Built-app assertions cover delayed pages, source exhaustion, overlap, Task return and scope/permission changes. |

## Five fidelity surfaces

- **Typography:** system sans stack with native CJK fallbacks;15px desktop message text,14px narrow message text and16px mobile textarea. Heading, sender/time, body and secondary source links retain the reference hierarchy. No vertical model-value wrapping or enlarged type to fill a wide window. Long public text and code remain readable; source bodies are preserved rather than rewritten for fit.
- **Spacing and layout:** two left rails, a single reading column, compact context, tabs, adjacent tool summaries and stable bottom composer. Reading width caps at1480px. Current expanded-context1536 capture has645px of history and composer bottom1012/1024; collapsed phone has430px of history and stream bottom equal to composer top709.17px. No page-level horizontal overflow in actual captures or exact browser checks.
- **Color/tokens:** white and pale blue/gray surfaces, restrained blue selection/action, red failures, muted completion. Actual primary action computed rgb(21,86,231). No green status treatment. Borders and radii keep the source's quiet outline treatment.
- **Assets/icons:** retained existing eL product brand and project icon system; library outline icons render tools and actors. No fabricated raster, CSS drawing or inline handcrafted artwork replaces a missing source asset. The reference's illustrative wordmark/avatar initials are not new product branding requirements.
- **Copy/content:** app labels and primary action remain concise. Actual identities, public phases, failure, unsupported/partial reads and unavailable live connection remain factual. Audit identifiers and originals are secondary. Native input envelopes and reasoning are not inserted as ordinary chat; source Task and public reply remain reachable.

## Verification and remaining scope

Full built-app browser batch:17/17 across15 files,0 skipped, before the final three-line follow-on-resize fix. After that fix, the final production build and focused timeline2/2 passed with the new resize assertions; no source edit followed. Other suite paths were unchanged. It covers directory pagination, current/history grouping, native and PG history, exact current-turn liveness, active empty state, three-round fill, shorter/taller/mobile geometry, keyboard/modal focus, drafts/receipts, native questions, recovery and schedule→Run→Session. Runtime versions and reproduction details are recorded in the private `reproenv.json`; final logs contain no disabled assertion or hidden failure. Final actual preview console:0 errors and0 warnings.

Actual read-only backend restart:8 native pages,134 unique entries (12messages/122tools across2Turns);10 assistant bodies identical to prior preserved history; public detail200, ordinary original-tool detail403; live=false and activeTurnId=null. A separate real one-Turn isolated test established public input/progress/tool/final persistence and stable identities; it is not a formal live-browser release acceptance.

No actionable P0/P1/P2 remains in this author comparison. P3: avatar initials versus existing outline actor icons and small shared-header rhythm differences can be evaluated during user iteration; they do not change reading order or access. Independent QA must judge the actual experience against the fixed visual and original Task, then Lead controls release and formal-entry retest. Experimental timeline wire and external-Session realtime access remain explicitly unverified.

## Implementation checklist

- [x] Open source and current rendered build; full and focused joint comparison.
- [x] Resolve major layout, state, source and responsive findings and recapture.
- [x] Run browser regressions without opt-in skips; verify actual stored history and read permissions.
- [x] Preserve raw private evidence outside public Git; publish only the controlled journey screenshot.
- [ ] Independent consumer use, Lead merge/release and formal-entry retest (handoff responsibilities).

final result: passed
