# Experimental message submission evidence (Q2)

This unpublished prototype observes explicit Session producer invocations. It is not preflight cancellation, a transaction, or a durable journal.

## Explicit registration

```typescript
const receipt = session.createMessageReceipt();
const requestId = "application-request";
// Keep requestId -> receipt in the application/Port, before starting the call.
await session.prompt("hello", { receipt, streamingBehavior: "steer" });
const facts = receipt.snapshot();
// Eventually, when no more observations are needed:
receipt.release();
```

A receipt is single-use and belongs to exactly one AgentSession. Foreign, released, disposed, or reused handles are rejected before the invocation starts. SDK IDs are generation-qualified. No text, FIFO, async-local scope, or snapshot difference is used to infer the application request. The message/model payload and stored session format are unchanged.

Receipt parameters are available on:

- `prompt(text, { receipt, ... })`
- `steer(text, images, receipt)` and `followUp(text, images, receipt)`
- `sendUserMessage(content, { receipt, ... })`
- `sendCustomMessage(message, { receipt, ... })`

Nested calls must receive their own receipts to be registered. Unregistered extension calls and raw Agent producers remain unattributed; they do not inherit a surrounding receipt. This version does not add receipt creation to ExtensionAPI or automatically identify individual extension authors. Custom messages returned by `before_agent_start` have a separate `before-agent-start` delivery kind under the invocation that collected them, not the user's original-content identity.

## Facts, not a success boolean

Snapshots are frozen copies of scalar metadata, without mutable message references:

- `outcome`: pending, handled (no ordinary submission), submitted, or failed.
- `returned`: the producer Promise settled; it does not imply queue consumption or provider completion.
- `observing`: false after receipt release or Session disposal.
- `deliveries`: separate occurrences with kind, placement, optional native queue ID, started, optional entry ID, and removed facts.

An invocation can fail after inserting a queue item (for example a display listener throws). Its delivery facts remain visible. A user message can start without an entry being appended. Run errors after acceptance can appear through normal SDK events while the producer Promise resolves; `submitted` is not model success.

Tracked queue insertion registers its delivery and native occurrence before `queue_update` listeners run. Legacy untracked queue notifications retain their pre-insertion behavior. Do not assume legacy observers are reentrancy-safe. Read the receipt at existing lifecycle boundaries or after the producer returns; this is not an additional callback bus.

Direct deliveries carry `deliveryId` on native/public message_start/message_end events. Queue deliveries also carry `queueItemId`. Direct tags are per invocation, not sticky properties on message objects. Session entry IDs are recorded from the actual append return value, not from the current leaf or text matching. Public loop message_end precedes Session append; idle custom append precedes its public message_end. An entry ID is not an fsync or crash-durability promise.

## Selective removal

```typescript
const ids = receipt.snapshot().deliveries.flatMap(d => d.queueItemId === undefined ? [] : [d.queueItemId]);
const result = session.removeQueuedMessages(ids);
// Always handle result.removed, including when result.displayError exists.
```

Only specified pending native occurrences are removed. Duplicated targets do not duplicate receipts. Missing or claimed IDs are not reported as removed. New arrivals with different IDs remain pending. Display rows are reconciled using occurrence IDs, not equal text. A synchronous display callback failure is reported separately without losing the successful native receipt.

Queue IDs are Agent-local: bind delayed commands to their original Session/Agent, rather than looking up the newest runtime.session when they execute. This API is not a cross-session capability or protection against a caller supplying another Agent's numeric ID.

`nextTurn` custom messages occupy a different holding queue. A tracked aside keeps its original delivery identity when a later prompt acquires it. `removeNextTurnMessages(deliveryIds)` removes only asides still in that holding queue and returns exactly those IDs. Once acquired by a prompt it cannot be recalled by this method. Clearing native queues does not clear nextTurn.

Do not interpret a missing entry ID, an empty removal receipt, a claim that disappears, or a returned Promise as permission to restore user content. Applications own those decisions and must retain unknown states where evidence is insufficient.

## Lifetime and limitations

A receipt retains its snapshots until the consumer drops it. Live delivery lookup entries are removed on observed entry append, selective/Session removal, release, or Session disposal. Failure without a terminal delivery observation requires explicit release; there is no automatic memory bound. `release()` stops observation, not IO. `dispose()` still does not cancel pending preflight: Q2 deliberately leaves that separate P1 problem unchanged.

Direct low-level native clears/reset bypass Session bookkeeping; their exact native receipts remain available, but receipt snapshots are not a complete observer of arbitrary Agent mutation. Use Session removal for observed requests. Low-level loops, arbitrary extension side effects, retry/compaction admission, rewind, and full runtime replacement are not covered by a general cancellation or completion guarantee.

Observer callbacks are not a security boundary. Caller-provided native delivery tags can be forged by another in-process caller. This prototype is for cooperative SDK/application correlation, not untrusted-code isolation.
