# Managed Session interface (I2, unpublished)

Use `createManagedSession` for the managed request API. The legacy AgentSession factory and its raw control methods are not an alternative recommended path for managed clients. This experiment does not replace installed packages or the legacy product's entrypoint.

## One ordered factory

```ts
const { session } = await createManagedSession(options);
const request = session.requests.create();
const dependent = request.createDependent();
const independent = session.requests.create();
```

The factory constructs the existing AgentSession, enables managed effects, binds extensions, then returns a frozen ManagedSession facade. There is no public post-hoc adoption/toggle. Extension loading errors reject creation; binding failure disposes the constructed Session before rejection. Startup hooks have no initiating request and cannot use ambient writers. This preserves P1-B's fail-closed boundary, rather than inventing a startup request.

Options such as ModelRuntime, ResourceLoader and SessionManager are trusted host bootstrap dependencies. Retaining them can bypass the facade: this is not a sandbox. The returned handle exposes no Agent, persistence writer, extension runtime or generic cancellation method. Supported host event subscription delivers detached copies; thrown listener errors can still fail processing.

## Request owner vs effect capability

RequestHandle groups:

- `id`, `signal`, `snapshot()`: request lifetime, own tracked SDK invocation count, not complete subtree/resource settlement.
- `createDependent()`: explicit cancellation dependency. No implicit async-context inheritance.
- `invalidate()`: blocks future effects for this request/dependents, not accepted-message removal or shared-run stop.
- `prompt(text, options)`: host input, including normal command/template processing and explicit streamingBehavior.
- `effects`: RequestEffects, the same narrow capability passed as `ctx.request` to scoped extension hooks.
- `messages`: snapshot/removal/history retirement.

Pass only `request.effects` to code that may produce effects but must not enumerate/remove messages, create independent requests or stop shared execution. RequestEffects retains self-invalidation and signal access; it has no host control authority.

`effects.sendUserMessage` is extension input (does not expand host commands/templates). `effects.sendMessage` produces a custom message. Both message effects return `Promise<MessageInvocationResult>`. Host `prompt` instead returns an immediate `PromptInvocation` handle, whose explicit `result` Promise has the same return/rejection meaning:

```ts
const call = request.prompt("input", { streamingBehavior: "followUp" });
// call.id is the exact outer invocation, even while nested producers run.
const observation = call.observe((snapshot) => {
  // Read only this invocation, not the first user delivery in the whole request.
  // snapshot.invocation separates outcome/returned/admission/entry/native facts.
});
const returned = await call.result;
// returned.kind === "returned", returned.invocationId === call.id
observation.release(); // Does not end the call, discard history, remove, or stop.
const messages = request.messages.snapshot();
```

Returned means the call returned, not every message processed, persisted, or a model succeeded. The snapshot separately records handled/submitted/failed and delivery facts. Existing producer errors still reject, including invalidated scope errors. A rejected call can have committed effects; inspect message history rather than assuming rollback. Normal call identity comes from a single-use internal observer, automatically released; ownership still comes from the C2 ledger. A caller-supplied observer is not automatically released. Releasing it during a call does not make its frozen snapshot authoritative for the call's eventual return.

## Invocation observation (I2)

`prompt()` starts the operation and returns a non-thenable handle with `id`, `requestId`, `result`, `snapshot()` and `observe(listener)`. Await `call.result`, NOT `call`. Creation with an invalid request or uncloneable input throws before issuing a call. Once issued, producer failures reject `result`; the exact ID remains available for inspecting retained failure/partial-success facts. The handle marks that Promise handled internally to allow late awaits; those awaits still reject.

`snapshot()` reads the existing ledger, never an independently advanced copy. `invocation` is absent after explicit history retirement; `history: forgotten` is not proof of no effects. `tracking: session-closed` is not settlement. A pending producer may still settle after tracking closes, and a later explicit snapshot can show that fact.

`observe` schedules an initial snapshot and subsequent latest-state snapshots in microtasks. It coalesces synchronous changes: it is NOT a journal and does not promise every intermediate state. No observer callback is injected into the synchronous mutation/admission boundary. Same-request nested activity may cause an unchanged outer snapshot; identity never changes. A subscription created after a change still sees current facts. Call return and automatic internal receipt release do not end these ledger observations; queued delivery removal/entry/native facts remain observable.

Each subscription exposes `release()`, diagnostic `snapshot()` and `closed: Promise<MessageObservationEnd>`. It ends with released, failed(error), tracking-closed, or history-forgotten. Closure/forgetting publishes the final current boundary before closing, unless released/failed first. A callback failure ends only that subscription and never rewrites producer facts or fails other observers. Callbacks must be synchronous; a returned thenable is diagnosed as failed and its rejection consumed. This cannot undo arbitrary work an incorrectly async callback already started. An observer may issue commands, but must expect that admission/consumption has already advanced by notification time; notifications are not veto hooks.

Migration from unpublished I1: replace `await request.prompt(...)` with `await request.prompt(...).result` where only call settlement is needed. Effects methods remain Promise-returning; legacy SDK producer entrypoints are unchanged. I1 originals are preserved in separate worktrees.

## IDs and data

RequestId, InvocationId, DeliveryId, ExecutionId and EntryId are distinct branded strings. Brands prevent identifier-kind mixups in typed clients. They are neither secrets nor authority, and casting strings cannot bypass message ownership checks. Entry IDs remain relative to their bound Session store; branding does not make legacy storage IDs globally unique.

`request.messages.snapshot({ includeDependents: true })` is immutable plain metadata, JSON round-trippable. It projects the existing C2 ledger and does not maintain a second mutable state machine. Native queueItemId is omitted from this surface. Delivery placement and native lifecycle results remain diagnostic facts; callers need not branch on queue type to remove.

Coverage stays `scoped-session-message-producers`; metadata/configuration/tool/arbitrary IO and complete execution participant coverage are NOT included. `tracking: session-closed`, `history: forgotten`, and `disposition: unresolved` must not be interpreted as complete empty history or cancellation success.

## Exact selected removal

```ts
request.invalidate(); // Independent operation: policy chose to block future effects.
const result = request.messages.remove({ deliveryIds: selectedIds });
```

- `rejected / delivery-not-in-selected-history`: at least one ID is not in retained selected request history; no removal is attempted for any ID. Foreign request/Session IDs, invented IDs and forgotten records all fail this check. Dependents are included only with explicit includeDependents.
- `attempted`: one result per unique requested ID, `removed` or `not-removed`, plus publicationErrors.

The implementation routes supported IDs to their actual native or nextTurn queue. It retains actual receipts, not snapshot differences. Across queues this is NOT atomic: a synchronous publication callback can change the later queue. A nested removal can remove a message while the outer attempt reports not-removed. Both facts can be true. A display failure cannot erase prior actual removal. Empty selection performs no publication.

No automatic invalidation, execution stop, retry or editor restoration is bundled into removal. Registration/queue absence/returned calls cannot establish safe restoration.

## Shared execution is separate

```ts
const selected = session.executions.snapshot();
// Policy decides whether this possibly shared run should stop.
if (selected) {
  const result = await session.executions.stop({ executionId: selected.id });
}
```

`settled` means the selected execution's SDK settlement barrier completed. It is not rollback. `target-not-active` means that exact ID was not active when requested, including foreign or stale IDs; it says nothing about past effects. No stop-current overload exists. Capture the target BEFORE invalidation if abort listeners may start other work. initiatingScopeId is not the participant list. Foreign IDs never target another Session or fall back to its current execution.

## Explicit history retirement and disposal

`request.messages.forget(selection)` returns forgotten, or blocked with one or more reasons:

- scope-active
- invocations-pending
- execution-active
- delivery-unresolved

It checks the full selection without callbacks/await before calling the original guarded C2 forget. No second ledger is cleared independently. Repeated forget is harmless, and a forgotten marker remains. Previously held immutable snapshots/observations remain caller-owned. No automatic memory ceiling or durable history is added.

`session.dispose()` returns `tracking-closed`: the existing SDK disposal boundary, NOT full resource settlement. Pending calls may still return later. Scope creation/late managed effects reject. Full close/replacement remains a separate contract.

## Intentionally absent

Generic cancel/restore booleans, ambient current requests, a builder DSL, automatic retry/restoration policy, complete execution-participant accounting, arbitrary IO rollback, durable/exactly-once guarantees, and a second copy of SDK execution state.

Executable external-consumer examples and negative type probes accompany I1. They exercise public package exports, not internal adapters. No live AI usability evaluation is claimed by the deterministic/type tests.
