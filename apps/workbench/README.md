# Workbench frontend

People primarily observe progress, changes, evidence, responsibility, decisions and results in the GUI. The default change path is: discuss with an existing Agent → Agent executes through business skill/CLI → read back in the GUI. Direct GUI edits remain secondary where needed; it is not a second complete operation panel. Both paths use the same API/core, permissions, immutable revisions and operation receipts. Browser automation here is frontend QA, not human-use evidence.

## UI conventions

- `src/ui/WorkbenchShell.tsx` owns stable work/knowledge modules, project navigation, account and recovery entry. Each helper domain is its own route; the work list never appends all domain panels.
- `src/style.css` retains semantic domain layouts; `src/workbench.css` owns shared palette, surface, typography, shell and list rules. Its root variables are the shared token source. Use scoped domain CSS only for domain structures. No green, teal or mint, including success status.
- `src/components/ui` contains the needed shadcn/ui Button and Radix Sheet. Tailwind compiles their utilities without a second global reset. Mobile navigation uses modal focus containment and Escape return. Keep accessible names on icon controls and visible keyboard focus.
- Read first. Task overview keeps acceptance, execution, immutable basis and current delivery's technical/use results visible. Other material and commands open on demand. Do not invent stats, people or features.
- The current project retains visited routes in memory, including drafts and list position. Dirty command drafts with stable object scopes retain their original baseline across refresh/remount and block silent rebasing. Navigation within a project keeps state; refresh/logout/project leave warn for dirty forms. Credentials and draft bodies never go to browser storage. Receipt IDs and limited navigation paths may go to sessionStorage.
- Knowledge page/revision/candidate deep links use query fields within the hash. Source links carry a validated same-project return target. Task/Document revisions and hashes are authoritative; the graph is secondary navigation.
- F1 is shell/task, F2 documents/knowledge, F3 collaboration helpers. F4 overview waits for actual use feedback; product M milestones and Agent CLI milestones remain separate.

## Local development and verification

Use Node 24 and the root npm workspace. `npm run dev --workspace @evoloop/workbench -- --port <unused-port> --strictPort` starts a loopback frontend. Set `EVOLOOP_API_TARGET` to the existing coordinator; do not restart a shared coordinator for UI changes. Build/typecheck/unit checks run from the repo root. Browser-check desktop 1280×800, wide desktop, and a 390px viewport, ordinary fixed-original/return paths, drafts and loading/failure/unknown states. Private screenshots and service material stay in root `.local/`.

Developer skills are project-local `.agents/skills/frontend-design` and `.agents/skills/web-design-guidelines`. They are not product business skills. Exact upstream component sources, adaptations and licenses are in [THIRD_PARTY.md](THIRD_PARTY.md); no global entries were added.
