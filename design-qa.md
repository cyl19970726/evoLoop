# Unified Session workspace — current image-to-code QA

2026-11-02, Asia/Taipei. **Author candidate QA; independent use and release remain separate.** Original author QA for7821/Dzl and the later independent `failed` observation are retained in Git and fixed process reports. They are not relabelled as a successful old Delivery.

## Visual truth and normalized comparison

Selected source: `.local/session-workspace-implementation/reference.png`,1536×1024, from the adopted research basis. Current frontend: **Br54UO-c**, JS SHA256 `104715e3c7194176a1557d94ac9f786a5b40a7749573412e23092abe8664283f`. It is byte-identical to the frontend independently used at cfd82ae; later runtime fixes do not change workbench source or JS.

Actual current browser image: `.local/session-workspace-implementation/rework-screenshots/reference-current.jpg/png/json`. CSS document1536×1024, DPR0.75, raw2048×1365. Only the measured document boundary at origin was cropped; text was not rescaled. The source and current UI were put together without scaling in `rework-screenshots/source-vs-final.png` (3072×1060 with36px labels). `source-vs-final-context.png` uses the same-coordinate heading/context/tab crops and was inspected separately.

State: same light theme, selected owned Session, expanded task/Agent context and latest reading position. Actual current stream645px; latest reply bottom915.42, composer top937.52/bottom1012 in1024px; input empty, no horizontal overflow. The source uses illustrative dialogue; actual stored messages, their lengths, historical delivery state and true actors remain unchanged. No mock messages are inserted to match the picture.

## Findings, fixes and post-fix evidence

| Finding | Outcome |
| --- | --- |
| P1: detached recent-business reply and bottom audit break the workspace | One message/public-progress/tool/final stream; audit/configuration/recovery are secondary. Full current comparison preserves the selected hierarchy. |
| P2: oversized context, vertically wrapped model values, stale cross-page CSS and Task shell leakage | Compact context by default, width-aware expanded values, single Session stylesheet, active-route shell flag. Earlier captures and browser regressions retain the before/fix evidence. |
| P2: tall window wastes space despite available older history; width reflow loses latest | Bounded earlier-history fill and stored follow/reader-anchor intention. Earlier failure captures remain. Prior independent QA actually used1440,2880,1171short,871 and390 with no page overflow; no layout/style change was made during this rework. |
| P1: updates403 followed by an in-flight homepage success restores protected content | Authorization epochs invalidate responses and queued state/cache updates; empty denial survives remount; explicit reread is required. Inspector selection and protected children clear. Old-hook build fails the held-A/403/release-A assertion; final fixture passes entries/inspector/cache and explicit reauthorization. |
| P2: matching inputs on different pages each become canonical | Page/detail/live share bounded uniqueness proof for a completed Turn. Ambiguity/unverifiable history stays unassociated; saved messages remain readable. No first-seen or current-page choice. Cross-page/independent refresh/detail/live tests pass. |
| P2: body preview truncation and old metadata are mistaken for missing input identity | Item enumeration completeness is separate from preview partial. Exact Turn metadata may page at most10×100; ordinary Thread page stays bounded. Joined Reader/proof tests bind unique inputs with5000-character text and at positions101/1000;1001 remains unknown. Protocol independent re-review passed45/45. |
| Actual QA failure: fixed Document returns to the directory | Explicit Session/results/filter return context plus canonical sessions route validation. Exact Document/revision retained. Author actual9c5b8756@45c96090 return hash equals original results hash; same consumer independently passed this repaired path at cfd/Br54. |
| Actual QA failure: Run input initiated by current actor appears as personal chat | Explicit project-dispatch identity/file avatar for origin.kind=run, keeping actor/Task/Run/Turn. Ordinary personal input remains mine. Same-actor fixture and the same consumer's actual two-Run inspection passed. |

## Required fidelity surfaces

- **Typography:** native system/CJK sans,15px desktop body,14px narrow body,16px mobile textarea; distinct title/sender/body/source hierarchy. Model values wrap as words, not vertically. No enlarged or shrunken text to fill a viewport.
- **Spacing/layout:** two rails, one reading surface, compact context, tabs, adjacent tool groups and stable bottom input.1480px maximum reading width; internal history scroll and retained reader position. New semantic labels do not redesign the composition.
- **Colors:** white/pale blue-gray surfaces, restrained blue actions and selection, muted completion and red failures. No green treatment.
- **Images/icons:** existing eL brand and outline icon library remain. No custom placeholder artwork, generated avatar or hand-drawn SVG substitutes a source asset. Project dispatch uses an existing file icon to avoid person identity.
- **Copy/content:** real public messages and source phases remain; unknown/partial/denied is explicit. “Project dispatch” and original actor are distinct from a person writing a chat. Task/Turn and fixed revisions remain reachable; identifiers and raw evidence are secondary.

## Evidence and limits

Same independent consumer's first report: `df974347@4bf40335`, old Delivery failed on Document return and dispatch identity while unified reading,12 real messages/tools/long text, several windows, drafts and A/B paths were usable. Second actual-use report: `9c34c42e@376baf3c`, the two UI failures passed on **cfd/Br54**; its four before/after images are preserved. Those reports are not final full-Runner/live or release acceptance.

Current source: full unit/protocol982 tests (941pass/41opt-in skips/0fail), typecheck and production build passed. Targeted provider22, coordinator80, joined45 and frontend four browser paths passed. Real compiled readback still8pages/134unique entries/12messages/122tools across2Turns, two Run inputs retained and10Agent bodies identical; public Item200, ordinary raw tool403, live=false. Source and compiled evidence do not start another model Turn. Final protocol incremental review found no blocker in its scope.

Author current full/focused comparison has no actionable P0/P1/P2 visual difference. P3 remains: reference avatar initials and existing product icons differ; small shared-header rhythm differs. The original layout and selected direction are maintained. Complete Runner ownership/live, controlled publication and formal-entry retest remain Lead/original consumer responsibilities on the same open Task.

## Checklist

- [x] Compare source and actual current UI together at matching viewport/state, full and focused.
- [x] Fix the four reported failures and the two neighboring protocol limits with targeted evidence.
- [x] Preserve old failed observation and screenshots; distinguish author, independent UI and protocol checks.
- [x] Confirm frontend JS equality across backend-only commits; keep credentials/raw sessions private.
- [ ] Controlled full-Runner release and original-consumer formal-entry live retest.

final result: passed
