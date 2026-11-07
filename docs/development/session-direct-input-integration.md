# Session direct input candidate

This PR carries the Session reader and direct input path on current `main`. It contains no Connector runtime or Connector migrations. The direct input migration is numbered 062; it is an unpublished candidate. PR #210 currently reserves 058 for Session compaction, while open Connector work also proposed 058–061. Root must settle the migration ledger and merge order before publishing 062. Do not replay an old migration number with different SQL.

## Entry and authority

- `directInputs` is optional and disabled by default. A grant names the exact project, owned Session and sender, with separate `canSteer` and `canStart`. An enabled `sessionMessages.grants` entry remains the ordinary message authority. An omitted `maxTurns` means unlimited cumulative Turns; an explicit limit remains a transactional cap. Steer does not start or bill a new Turn.
- The coordinator constructs the service only when an owned runner exists. Capability and submit use the same current project writer, Session execution, canonical cwd, ordinary grant and direct grant checks. The writer lease and native availability guard submission. Routes use ordinary bearer authentication.
- The owned Session composer sends directly only when the service capability is available. An unresolved input ID survives reload and is read or reconciled under its original ID. The UI blocks a second direct attempt while it is unresolved. Without direct capability, the queue action retains its “保存待处理” wording.
- An accepted steer appears in the timeline only when its project, Session, Turn, source, native client ID and Item ID agree with the durable input. If PG has no Item ID yet, a bounded complete settled Turn read may prove one unique Item. Other readers see actor and source with a redacted body; the sender and project reviewer may read the saved content. An unresolved or conflicting Item stays an unattributed native notice.
- The existing message pump settles the original processing for an idle direct start. An attached steer does not enter queued dispatch or create another primary source.

## Verification boundary

The branch has isolated PG18 checks for the processing slot, finite and unlimited grants, original ID recovery, and Run and message sources. Timeline tests cover both source projections, Item and Session mismatch, reviewer content and ordinary reader redaction. Earlier independent QA used an isolated candidate through HTTP, PG and signed alpha.6 for one idle start and two steers; this is evidence for that fixed candidate, not publication of this head. Root owns protected merge, migration and release. The independent acceptance owner must inspect the changed candidate and the published ordinary path before the Task's seven criteria can pass.
