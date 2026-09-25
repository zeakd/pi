# Request lifetime experiment (P1-A)

This is an unpublished experiment on top of Q2 message evidence, not a general cancellation or security API.

## Three separate responsibilities

- The application decides which request to withdraw, where to restore source input, and whether to stop a shared execution.
- A Session-local request scope controls **future managed producer admission**. It may cover several calls and explicitly dependent child scopes.
- The Session owns one conflicting execution/preparation lease at a time. Long input/before-agent-start hooks do not hold that lease.

A request, invocation, delivery, native run and stored entry are not interchangeable. `initiatingScopeId` does not describe every request participating in an execution.

## Usage

```ts
const scope = session.createRequestScope();
const receipt = session.createMessageReceipt();
const pending = session.prompt("input", { scope, receipt });

// May be called while an input or before-agent-start handler is suspended.
const admission = session.invalidateRequestScope(scope);
// admission.invalidated is true; pendingInvocations may still be nonzero.

// Removing already admitted pending deliveries is a DIFFERENT operation.
const ids = receipt.snapshot().deliveries.flatMap((item) =>
  item.queueItemId === undefined ? [] : [item.queueItemId]);
const removed = session.removeQueuedMessages(ids);

// If application policy calls for stopping the whole possibly shared execution,
// capture its ID and pass that ID, never "whichever execution is current later".
const execution = session.getExecutionSnapshot();
if (execution) await session.stopExecution(execution.id);

await pending.catch((error) => {
  // RequestInvalidatedError is expected if invalidation won before admission.
  // Other failures must still be reported by the application.
  throw error;
});
```

The example separates the decisions; it is not an atomic cancel-and-remove transaction. Actual queue removal receipts, claimed state, and existing entry facts still govern reconciliation. Do not automatically stop an execution merely because one queued participant was invalidated.

Scopes are also accepted by `sendUserMessage`/`sendCustomMessage` options and the fourth argument of `steer`/`followUp`. A child created with `createRequestScope(parent)` is invalidated with the parent; an independently created scope is not. Parent association means cancellation dependency, not inferred causation. Scope creation and late producers on an invalidated scope reject. Foreign or copied handles reject.

Call `invalidateRequestScope` when a scope is no longer needed. Live scopes are retained until invalidation or Session disposal; this experiment does not provide an automatic memory bound. Observation `receipt.release()` does not invalidate a scope.

## Ordering contract

- Invalidation marks the entire dependent subtree before synchronous signal listeners execute.
- After suspended managed preflight returns, scope validity is checked before SDK-controlled admission.
- Preparing a direct prompt does not acquire nextTurn deliveries or set the active system prompt. Those changes occur after the final admission check with no awaited/user callback interval before native run entry.
- The legacy acceptance callback remains a notification, not native run evidence. A callback may invalidate its scope; the subsequent admission check rejects the prompt. It is not notified a second time with false.
- A managed before-agent-start result is rejected with `StalePreparationError` if the observed branch leaf, model, thinking level, base prompt, tool list reference or extension runner changed. The SDK does not retry it silently. Arbitrary in-place raw mutations are outside this version check.
- Compaction is a conflicting shared operation and holds a lease. Invalidation checks protect late SDK append/continuation after awaited compaction preparation. A non-cooperative compaction hook may still retain that lease until it returns; no progress guarantee is made in that case.
- `stopExecution(id)` sets stop intent synchronously, aborts cooperative active work and waits for that captured lease to settle, including awaited listeners. It does not target a newer execution. Already accepted message persistence is not retroactively removed.
- A failed competing execution does not run the current owner's finally cleanup. Settlement releases only its own lease. `isIdle` is false while the execution/settlement lease remains held.

## Explicit limitations and follow-up

- This is **admission invalidation**, not complete request cancellation: already accepted queues/nextTurn, claimed deliveries and shared executions need separate reconciliation.
- No automatic mapping of current execution participants or atomic cancel receipt is implemented yet.
- `scope.signal` is available for explicitly cooperating code. The legacy extension `ctx.signal` remains the active Agent signal; this experiment does not implicitly bind every extension hook/producer to a request scope.
- Unscoped extension/raw Agent calls do not inherit an outer scope. Arbitrary extension/file/network effects are not fenced or rolled back. This is not process isolation.
- Public manual navigation/reload/model mutation/SessionManager/raw Agent APIs have not all been routed through execution ownership. This prototype is not a complete sole-writer architecture.
- Session dispose invalidates managed scopes, but full runtime replacement/close across every legacy producer and durable writer remains future work.
- Invocation settlement counts tracked producer Promises, not arbitrary child resources, accepted delivery completion or disk durability.
- No durable operation journal, crash recovery, exactly-once IO or general event replay is added here.

A successful P1-A test is evidence for these managed boundaries only. Product integration requires closing the unsupported mutation paths and defining the combined cancellation/reconciliation protocol first.
