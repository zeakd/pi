# Managed extension effects (P1-B experiment)

This unpublished experiment extends P1-A request admission lifetimes. It is not a sandbox, complete request-cancellation transaction, or production migration.

## Activation and ownership

```ts
const { session } = await createAgentSession(options);
session.enableManagedEffects(); // Before bindExtensions, any operation, or publishing a context.
await session.bindExtensions(bindings);
const scope = session.createRequestScope();
const effects = session.requestEffects(scope);
await session.prompt("input", { scope });
```

Activation is irreversible for that Session. A previously started legacy operation or published context prevents activation: old references/async continuations cannot be retroactively converted into managed authority. Initial construction/configuration through createAgentSession remains the trusted bootstrap boundary.

Managed producer APIs require an explicit Session-local scope. Input/before-agent-start handlers and extension commands receive a `ctx.request` capability and `ctx.signal` is that request's signal. No AsyncLocalStorage or ambient current-request inference is used.

```ts
pi.on("input", async (event, ctx) => {
  const request = ctx.request;
  if (!request) throw new Error("This extension needs request-bound effects");
  await prepare(event.text, request.signal);
  const receipt = request.createMessageReceipt();
  await request.sendMessage(
    { customType: "prepared", content: "context", display: true },
    { deliverAs: "nextTurn", receipt },
  );
  // This is actual SDK evidence, not text/FIFO attribution.
  const delivery = receipt.snapshot().deliveries[0];
});
```

The host issues independent background scopes explicitly. A hook capability cannot mint an independent scope or choose a different Session. `RequestEffects.invalidate()` invalidates future admissions for that scope; it does not recall already accepted deliveries or stop a shared execution.

`ctx.request` is **not automatically attached to shared-run events/tools**. Such an event can involve several requests; attributing it to the initiating scope would be incorrect. Those integrations require an explicitly supplied background/caller capability or a future execution-bound contract, not ambient global pi writers.

## Supported effects and conflict rules

| Effect | Admission / ownership |
| --- | --- |
| prompt, sendUserMessage, sendMessage, steer, followUp | Explicit scope, P1-A admission boundary. Native pending membership/claim/entry evidence remains Q2's responsibility. |
| appendEntry, setSessionName, setLabel | Scope-checked synchronous append lane. May append metadata during an active execution. They do not replace conversation/model state. |
| setModel | Auth preparation outside the lease; scope and conversation/model state revalidated afterward; synchronous configuration commit under the conflicting execution lease. |
| setThinkingLevel, setActiveTools | Scope validation and short configuration lease; reject while conflicting execution/preparation/settlement is active. |

The facade is frozen and closures retain the originating scope/Session. Captured capabilities keep that identity after await; a disposed/invalidated scope cannot bind to a newer request or Session.

Metadata append methods return `EntryMutationReceipt`. A subsequent public event callback failure does not erase the actual entry ID. For setSessionName the asynchronous scoped notification is also awaited and publication failure is returned separately. This is in-memory append evidence, not a disk durability guarantee. Configuration APIs may still fail during post-commit notification; failure does not universally imply no effect. No generic durable operation journal is provided.

Preparation versioning considers conversation entries (message/custom_message/compaction/branch_summary), model, thinking, base prompt, tools and extension runner. Append-only metadata must not invalidate its own before-agent-start preparation. A hook that changes the conversation/configuration while preparing a result can still receive StalePreparationError; use returned before-agent-start messages or nextTurn context instead of silently accepting a stale result.

## Closing legacy extension paths

In managed mode, ambient pi message/metadata/configuration writers and ambient abort/compact/shutdown controls reject. They do not inherit the surrounding request. Use ctx.request where provided, or a host-issued independent effects handle.

The extension SessionManager is an actual frozen read view, not the live writer with a read-only TypeScript annotation. Returned entries/trees/header/model snapshots are cloned. The broad mutable ModelRegistry is unavailable through managed extension contexts. Preflight message/image/system-prompt options are detached at managed boundaries, and custom producer inputs/metadata payloads are cloned before storage.

Handler chains validate a bound request before later handlers and after awaited results. This stops further managed handler dispatch after invalidation; it cannot forcibly interrupt arbitrary code already executing inside a handler.

## Explicitly unsupported in managed mode

Manual compact, tree navigation, reload, session replacement through extension command contexts, ambient whole-queue clear/abort, dynamic provider/tool refresh, queue/retry/compaction/scoped-model settings setters, and Session bash execution/recording are not implicitly made safe by a scope. The relevant legacy Session entrypoints reject before their existing effects. A host may use captured execution IDs for stop and exact queue IDs for Q2 removal; these controls are not exposed as ambient extension authority.

Automatic compaction/retry that belongs to the owned execution continues to use the SDK's protected execution path. Managed mode is an experimental subset, not a drop-in replacement for the entire extension API. Unsupported functionality needs a real ownership contract before enabling it; it is not silently routed through a permissive fallback.

## Boundaries this does not close

- A trusted host that retains raw Agent/SessionManager/SettingsManager/ModelRuntime references can bypass the managed facade. Do not inject those writer references into managed extensions. The experiment does not replace every public SDK object with a private implementation.
- Arbitrary OS/network IO, pi.exec, UI mutation, process-global resources, and deliberately retained raw objects are not sandboxed or rolled back.
- Accepted queues/nextTurn/claimed deliveries, execution participant mapping, atomic cancellation/reconciliation, full generation replacement/cleanup, crash recovery and exactly-once IO remain separate contracts.
- Live scopes are retained until invalidation/disposal; tracked SDK call counts are not an automatic memory bound or proof that all extension resources stopped.
- Application decisions (restoration, terminal/phone separation, admission UX, job policy) remain outside the SDK. No new product Program or replay is introduced here.

Legacy mode remains available only as the unchanged comparison path for these experiments. Enabling this mode in a product, deciding compatibility, publishing packages, and changing dependencies require a separate integration decision.
