# C2: scoped message ownership and native delivery disposition

Unpublished experiment on top of P1-B. This is not a generic cancel/restore API, a durable journal, or a ledger for every SDK/OS effect.

## Independent ownership and observation

```ts
session.enableManagedEffects(); // Before operations or extension context publication.
const scope = session.createRequestScope();
const effects = session.requestEffects(scope);
await effects.sendMessage(
  { customType: "aside", content: "context", display: true },
  { deliverAs: "nextTurn" }, // No observation receipt required.
);
const snapshot = session.getRequestMessages(scope);
```

Explicitly scoped prompt/steer/followUp/sendUserMessage/sendCustomMessage calls automatically receive invocation IDs and message delivery records. before-agent-start returned messages have their own delivery kind under the collecting invocation. Nested producers remain separate invocations and require an explicit scope; no ambient request or text/FIFO/ALS attribution is added.

MessageSubmissionReceipt is still optional, single-use and Session-local. Its ID matches the invocation when supplied. `receipt.release()` freezes that observer's snapshot, but the scoped ownership ledger continues to record admissions, actual removal, entries, native run facts and invocation return. Release before calling a producer is still invalid. Unscoped legacy behavior remains the comparison path; this does not retroactively attribute raw or unscoped producers.

## Snapshot

`session.getRequestMessages(scope, { includeDependents: true })` returns frozen plain metadata:

- `coverage: scoped-session-message-producers`: not all metadata/configuration/tool/external IO effects.
- `tracking: active | session-closed`: Session disposal ends the normal observation/persistence wiring. Retained positive facts are not a guarantee of complete post-close observation.
- `scopes`: own invalidated/pendingInvocations and optional parentId for explicitly dependent scopes. Historical dependencies remain queryable after invalidation; independent background scopes are excluded.
- `records`: per-scope retained/forgotten history and invocation records, with outcome/returned and delivery records.

Each delivery has Q2 identity/placement/native queue ID/started/entryId/removed, plus:

- `admission`: registered or session-accepted. Registration alone is not admission. The Session handoff/append/holding/native enqueue boundaries record acceptance; a raw host causing a later native conflict is not hidden as successful delivery.
- `disposition`: unresolved, entry-recorded, removed, or discarded-before-start.
- `executionId` when bound to a shared execution.
- optional `native`: Agent-local runId, phase, failed and abortRequested facts from native cleanup.

The native phase is message-ended, discarded-before-start, or interrupted-after-start. Agent records tagged direct and claimed occurrences at its actual ownership boundaries and constructs a final report in run cleanup without user callbacks. The last immutable core report is bounded to one run; Session ingests each report before post-run retry/continuation and before releasing its lease. A failed error-reporting listener cannot erase the cleanup report.

`native.failed` means an exception reached the native run catch, not that every provider/model outcome was successful otherwise. `abortRequested` does not prove abort caused a particular disposition. Native run IDs are Agent-local and differ from Session execution IDs. Multiple native retries/continuations can share one Session execution.

## Conservative persistence facts

Native message-ended means the native transcript reached message_end, not that AgentSession append succeeded. If a public listener or append fails, entryId can remain unknown even if the storage implementation partially appended. No leaf/text lookup fabricates that missing receipt. interrupted-after-start also stays unresolved unless actual entry/removal evidence exists.

The native cleanup's unstarted disposition is a positive fact about abandoned lifecycle delivery, not inference from queue absence. It is not a rollback of earlier request effects or a blanket guarantee about model exposure/external IO. entry-recorded is actual append-return evidence, not fsync, model interpretation, or request/execution completion.

An acquired nextTurn message retains its original producer scope while carrying the consuming execution ID. Invalidation does not automatically remove accepted messages or stop that shared execution.

## History lifetime

`session.forgetRequestMessages(scope, { includeDependents: true })` explicitly releases retained message history only when:

1. every selected scope is invalidated and its own tracked calls have settled;
2. no Session execution lease is active;
3. all selected invocations returned and none of their registered deliveries remain unresolved.

Validation covers the whole selection before deletion. Repeated forget is harmless. Snapshots then report `history: forgotten`, not a misleading complete empty history. Earlier immutable snapshots or still-held observer handles remain caller-owned references. Tiny forgotten-scope markers remain until the Session object is dropped; dependent scope metadata follows scope handle lifetime. No automatic memory cap or crash-safe retention is introduced. Unresolved history cannot be silently forgotten through this API; dropping the entire Session remains an explicit resource-lifetime boundary, not proof of cancellation.

## Limits

- All admitted messages from the supported explicitly scoped Session producer paths are covered independently of optional receipt issuance. Raw Agent/SessionManager mutation and unscoped producers are outside this coverage.
- Metadata/config/tool execution/OS/network/UI effects are not message records. The API name and coverage field deliberately do not claim a whole-request effect ledger.
- Scope invalidation, exact removal, native delivery disposition and execution settlement remain distinct. No cancel-complete or restore boolean is supplied.
- Full shared-run participant/impact enumeration, complete session replacement/close, durable storage and exactly-once semantics remain separate contracts.
- These APIs and their retention policy are experimental; no package publication or product installation is part of this change.
