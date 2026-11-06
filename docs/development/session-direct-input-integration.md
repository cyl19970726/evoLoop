# Session direct input integration handoff

This branch is based on `b9180e4`. PR #203 owns the continuous reading UI. PR #204 still owns the shared coordinator entry and Connector files. Integrate this branch after that file handoff; use the current heads when applying these steps.

## Owned interfaces

| Interface | Purpose |
| --- | --- |
| `directInputConfigurationSchema` | Additional opt-in `directInputs` policy; `enabled` defaults to false, with exact project, Session and sender grants plus separate `canSteer` / `canStart`. |
| `createDirectInputService` | Composes the existing ordinary grant, current project writer and owned Session execution authority with the additional direct policy. It creates `PgDirectInputs` on the existing pool. |
| `registerDirectInputRoutes` | Adds capability, submit, exact receipt, cursor page and original-input reconciliation routes to the existing authenticated Fastify server. |
| `directInputClient` | Browser requests with caller-held `inputId` and `operationId`; an unknown network result is read back by the original input ID and is never automatically reposted. |
| `CodexAppServerAdapter.steerTurn` | Sends pinned alpha.6 `turn/steer` with `expectedTurnId` and `clientUserMessageId=inputId`; returns an enqueue acknowledgement, not consumption. |

## Shared-file patch after ownership transfer

1. In `configuration.ts`, add `directInputs: directInputConfigurationSchema.optional()` to the integrations schema. Keep the default absent/disabled. Do not add a production grant in this patch. Existing `sessionMessages.grants` remain the maxTurns authority; a direct grant only adds the two mode permissions.
2. In `main.ts`, after the runner exists, construct `createDirectInputService({pool,uow,runtime:()=>requireDirectInputRuntime(runner.nativeAdapter()),canWrite:()=>lease.canWrite()&&runner.nativeStartsAvailable(),configuration:()=>loadIntegrations(...),currentProjectWriter,currentSessionExecutionAuthority,allowedCwd:...})`. Resolve `allowedCwd` from the current integration path and exact realpath policy. Pass `directInput` into `buildServer` only when the pinned native adapter and configuration path are present.
3. In `server.ts`, add optional `directInput?: DirectInputService` to `buildServer` options and call `registerDirectInputRoutes(app,options.directInput)` beside the Session message routes. This route must use the same authentication hook and error mapping as other project routes.
4. After PR #203 is merged into the working head, connect its Session composer to `directInputClient`. Render send only from `GET .../direct-input-capability` with `available=true`. Preserve the original IDs through request, timeout, readback and reconciliation. Show `attempted` as sending, `accepted` as native received, `rejected` as refused, and `unknown` as awaiting exact reconciliation. The old “保存待处理” path must stay labelled as queued until the direct feature is fully wired.
5. The existing message pump already reads `processing` and `unknown` rows without a queued dispatch; it must continue settling direct start messages by their original `[evoloop-message-operation:<operationId>]` marker. Do not route these direct rows through its `queued` start branch. Re-run its reconciliation and terminal tests against the integrated branch.

## Contract and evidence limits

`session_direct_input` records `inputId`, actor, exact primary Run/message source, expected/actual Turn and optional Item ID. A steer never creates another processing record. Idle start creates the original message and processing in one transaction, under the existing session lock and maxTurns count. The 062 recovery trigger releases only the gate for an exactly reconciled direct start whose terminal message and Turn match; an old terminal cannot release a new cause.

Native acknowledgement means accepted for enqueue. It does not prove the model read or used the supplement. The adapter currently returns `itemId=null`; reconciliation binds an Item only when native history carries the exact client ID or the original start marker. A native Item without such evidence remains unbound. The local installed `codex` reports 0.164.0, so this branch has fixture tests for the alpha.6 transport and no independent real alpha.6 Turn proof.

Isolated PostgreSQL, HTTP injection, source, budget, crash, concurrent slot and native adapter fixture checks are in the focused tests. The service is not registered in `main.ts` or `server.ts` on this branch, there is no production direct grant, and the ordinary user entry still uses its previously published behavior. These are explicit follow-on integration gates before independent QA can assess all seven Task criteria.
