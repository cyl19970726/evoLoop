# Session direct input candidate

This branch combines the continuous reader from PR #203 (`a65a0cef`), the standard Connector receiver from PR #204 (`97c1f5c`), and the historical migration fixture from PR #205 (`a31b916`). It registers direct input in the ordinary coordinator and Session composer. The feature is disabled until a separate direct grant is configured; this candidate adds no production grant.

## Entry and authority

- `directInputs` is optional and defaults to disabled. A grant names the exact project, owned Session and sender, with separate `canSteer` and `canStart`. The existing enabled `sessionMessages.grants` entry remains the maxTurns authority.
- `main.ts` constructs the service only when an owned runner exists. Capability and submit share current project writer, Session execution, canonical cwd, ordinary grant and direct grant checks. The current writer lease and native availability guard submission. `server.ts` registers the routes under ordinary bearer authentication.
- An owned Session composer shows direct send only when the service capability is available. An unresolved input ID survives a page reload and is read or reconciled under its original ID; the UI blocks a second direct attempt meanwhile. The old queue action keeps its “保存待处理” wording when direct capability is absent.
- The existing message pump reads processing and unknown direct start rows and settles their original processing ID. A direct input does not enter the queued dispatch branch or create a second primary source.

## Evidence and remaining gate

The 062 migration, HTTP, slot, budget, source and recovery checks ran against an isolated PostgreSQL 18.6 database. The alpha.6 adapter fixture suite passed. A separate signed alpha.6 bundle with a private profile confirmed one start acknowledgement and one terminal read. Two attempted steers found the Thread idle before acceptance; a later sample returned `method_not_found` for Turn paging despite experimental initialization. Native two-input and exact Item correlation remain unproved; the service leaves missing Item IDs null.

This is a review candidate. Root owns protected merge, migration and publication. The independent acceptance owner must use the published ordinary path before all seven Task criteria can pass.
