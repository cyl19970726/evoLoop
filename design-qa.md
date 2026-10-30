# Product Design QA

Date: 2026-10-30

Selected target: supplied task workspace reference
Target image: `.local/frontend-reader-redesign/reference-task-layout.png`

The reference and the latest implementation were compared with the failed Session task selected. The final layout follows the reference's wide two-rail shell, three-column task table, and full-width detail area below the list.

## Implemented target

- The outer rail is fluid from 76 to 84 px and the project rail from 272 to 300 px.
- The project rail shows three real current Sessions, a full-Session link, and no always-visible secondary status labels.
- Task scope is switched by the `全部工作 / 我的承接` tab row, with search, state, and secondary filters aligned in one control row.
- The task table uses three content columns while the reader is open: work, progress, and concrete responsibility.
- The selected-task reader occupies the full width below the table, with next step on the left and fixed delivery plus outcomes on the right.
- The Task detail and document reader retain their complete content and real links rather than hiding them behind the compact table.
- The document index and full reader, overview, schedule, knowledge, team, operations, repository, and settings all share the same shell and layout rhythm.

## Captured states

- Task page at 1440 x 1024: `.local/frontend-reader-redesign/work-1440-final.jpg`
- Task page at 1920 x 1080: `.local/frontend-reader-redesign/work-1920-final.jpg`
- Task page at 871 x 1213: `.local/frontend-reader-redesign/work-871-reference-match.jpg`
- Task page at 390 x 844: `.local/frontend-reader-redesign/work-390-reference-match.jpg`
- Task detail at 1440 x 1024: `.local/frontend-reader-redesign/task-detail-1440.jpg`
- Process document index and reader at 1440 x 1024: `.local/frontend-reader-redesign/documents-1440-final.jpg`, `.local/frontend-reader-redesign/document-1440-final.jpg`
- Process document index and reader at 390 x 844: `.local/frontend-reader-redesign/documents-390-final.jpg`, `.local/frontend-reader-redesign/document-390-final.jpg`
- Overview, schedule, knowledge, team, operations, repository, and settings captures use `*-1440-final.jpg`.

## Responsive verification

- 390 px: no horizontal overflow; task rows become stacked semantic blocks and document side metadata follows the article.
- 871 px: the project rail automatically collapses to zero width and remains reachable from the header.
- 1171 px: the project rail remains collapsed and manually expandable.
- 1181 px: the project rail automatically expands.
- 1920 px and 2560 px: both rails expand, content fills the available workspace, and the document width equals the viewport width.
- Resizing from 871 px to 1920 px restores the project rail without a reload.

## Review

- P0: none.
- P1: none.
- P2: none.
- The earlier side-reader implementation diverged from the supplied reference and was replaced with the table-plus-below-reader layout.
- Real task titles, responsibility states, fixed revisions, technical checks, and use observations remain visible and correctly separated.
- No green or teal status styling is visible.
- Browser console reported no error or warning entries during the final route checks.

final result: passed
