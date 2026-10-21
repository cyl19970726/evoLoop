# Owner discussions and document recovery

Prepare a discussion only when a real direction or allocation choice needs it. Read the fixed handoff, the current Discussion and its events, and the owned Document. A handoff observation is a declaration by its observer; it does not prove native chat delivery or adoption.

Use `command schema discussion.decision.record` to discover the current fields. Submit the observed Discussion `expectedVersion`, its current `documentRevisionId`, a clear choice, evidence, reason, unresolved points and relook condition. A correction must name the actual latest decision in `supersedesDecisionEventId`. The command appends both the decision and its Document revision atomically. Generic `document.revise` can edit a discussion Document, but it does not record a decision or advance the Discussion's fixed pointer.

If that separate edit causes `DOCUMENT_CHANGED`:

1. Reconcile the original operation and preserve its confirmed rejection. Read the current Discussion/events and owned Document; read both the Discussion's fixed revision and the Document's actual current revision completely, and verify their hashes. Explain what changed and whether the edited content should be used.
2. When authorized to decide, prepare a **new intent and operation ID**. Keep the observed Discussion `expectedVersion` and latest decision supersede target; set `documentRevisionId` to the actual current Document revision. Add `documentRecovery: { expectedDocumentVersion, reason }` with that Document's observed version and a specific recovery reason. Do not add this field during normal in-sync decisions.
3. Read back the result, both current pointers, the new fixed body and its parent. The new body must retain the edited content and append the recovery provenance and decision; its parent is the independently edited revision. Both object versions advance once. Old revisions, decisions, rejected operations, adopted pointers and already frozen execution inputs remain unchanged. Link actual follow-up objects separately against the new current decision.

Recovery requires review authority and a genuinely different head of this Discussion's nonarchived, inline Markdown Document. A stale version/revision, invalid scope, unreadable/hash-mismatched original or changed latest decision is a refusal, not permission to substitute a newer baseline. Re-read and judge a changed intent; never repair heads with direct database edits or delete history. Unknown command outcomes still use the original-ID receipt rules before any new intent.
