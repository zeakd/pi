import type { AgentSession, AgentSessionEventListener, ExtensionBindings, PromptOptions } from "./agent-session.ts";
import type { MessageObservation, RequestDeliveryRecord, RequestMessageRecord } from "./message-evidence.ts";
import type { RequestEffects } from "./request-effects.ts";
import type {
	DeliveryId,
	EntryId,
	ExecutionId,
	InvocationId,
	MessageInvocationResult,
	RequestId,
} from "./request-ids.ts";
import type { ExecutionSnapshot, RequestScope, RequestScopeSnapshot } from "./request-lifetime.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "./sdk.ts";

export interface RequestLifetimeSnapshot extends Omit<RequestScopeSnapshot, "id"> {
	readonly id: RequestId;
}
export interface ManagedExecutionSnapshot extends Omit<ExecutionSnapshot, "id" | "initiatingScopeId"> {
	readonly id: ExecutionId;
	/** Initiator only, NOT a complete participant list. */
	readonly initiatingScopeId?: RequestId;
}
export interface DeliverySnapshot
	extends Omit<RequestDeliveryRecord, "id" | "queueItemId" | "entryId" | "executionId"> {
	readonly id: DeliveryId;
	readonly entryId?: EntryId;
	readonly executionId?: ExecutionId;
}
export interface InvocationSnapshot extends Omit<RequestMessageRecord, "id" | "scopeId" | "deliveries"> {
	readonly id: InvocationId;
	readonly scopeId: RequestId;
	readonly deliveries: readonly DeliverySnapshot[];
}
export interface RequestMessagesSnapshot {
	readonly coverage: "scoped-session-message-producers";
	readonly tracking: "active" | "session-closed";
	readonly scopes: readonly (RequestLifetimeSnapshot & { readonly parentId?: RequestId })[];
	readonly records: readonly {
		readonly scopeId: RequestId;
		readonly history: "retained" | "forgotten";
		readonly invocations: readonly InvocationSnapshot[];
	}[];
}
export interface RequestSelection {
	/** Explicit invalidation dependents only; independent producers are excluded. Default false. */
	readonly includeDependents?: boolean;
}
export type RemoveMessagesResult =
	| {
			readonly kind: "rejected";
			readonly reason: "delivery-not-in-selected-history";
			readonly deliveryIds: readonly DeliveryId[];
	  }
	| {
			readonly kind: "attempted";
			/** Per unique requested ID. not-removed makes no claim about past removal or processing. */
			readonly deliveries: readonly { readonly id: DeliveryId; readonly kind: "removed" | "not-removed" }[];
			/** Subsequent publication failures do not undo the exact removal facts. */
			readonly publicationErrors: readonly string[];
	  };
export type ForgetBlocker = "scope-active" | "invocations-pending" | "execution-active" | "delivery-unresolved";
export type ForgetMessagesResult =
	| { readonly kind: "forgotten" }
	| { readonly kind: "blocked"; readonly reasons: readonly ForgetBlocker[] };
export type StopExecutionResult = {
	/** settled is not rollback; target-not-active says nothing about past effects. */
	readonly kind: "settled" | "target-not-active";
	readonly executionId: ExecutionId;
};
export interface RequestMessages {
	snapshot(selection?: RequestSelection): RequestMessagesSnapshot;
	/** Non-atomic across queues. Checks ALL selected IDs before attempting any removal. */
	remove(options: RequestSelection & { readonly deliveryIds: readonly DeliveryId[] }): RemoveMessagesResult;
	/** History retirement only, never cancellation. Unknown delivery disposition blocks forgetting. */
	forget(selection?: RequestSelection): ForgetMessagesResult;
}
export interface PromptInvocationSnapshot {
	readonly id: InvocationId;
	readonly requestId: RequestId;
	readonly tracking: "active" | "session-closed";
	readonly history: "retained" | "forgotten";
	/** Absent after explicit history retirement; absence never proves no effects. */
	readonly invocation?: InvocationSnapshot;
}
export interface PromptInvocation {
	readonly id: InvocationId;
	readonly requestId: RequestId;
	/** Actual producer return/rejection, not message or shared-execution completion. */
	readonly result: Promise<MessageInvocationResult>;
	snapshot(): PromptInvocationSnapshot;
	/** Initial + latest-state notifications in microtasks; not a journal of every transition. */
	observe(listener: (snapshot: PromptInvocationSnapshot) => void): MessageObservation;
}
export type RequestPromptOptions = Omit<PromptOptions, "scope" | "receipt" | "preflightResult">;
export interface RequestHandle {
	readonly id: RequestId;
	readonly signal: AbortSignal;
	readonly effects: RequestEffects;
	readonly messages: RequestMessages;
	snapshot(): RequestLifetimeSnapshot;
	/** Blocks future effects for this request and dependents; does not remove or stop accepted work. */
	invalidate(): RequestLifetimeSnapshot;
	createDependent(): RequestHandle;
	/** Starts host input with immediate identity. Invalid creation throws; producer errors reject result. */
	prompt(text: string, options?: RequestPromptOptions): PromptInvocation;
}
export interface ManagedSession {
	readonly requests: { create(): RequestHandle };
	readonly executions: {
		snapshot(): ManagedExecutionSnapshot | undefined;
		/** Only the selected execution; never reselects the current run after an await/callback. */
		stop(options: { readonly executionId: ExecutionId }): Promise<StopExecutionResult>;
	};
	/** Host listener receives a detached event. Exceptions may fail native processing. */
	subscribe(listener: AgentSessionEventListener): () => void;
	/** Existing SDK dispose boundary; NOT a proof of complete IO/resource settlement. */
	dispose(): { readonly kind: "tracking-closed" };
}
export interface CreateManagedSessionOptions extends CreateAgentSessionOptions {
	bindings?: Pick<ExtensionBindings, "uiContext" | "mode" | "onError">;
}
export interface CreateManagedSessionResult {
	readonly session: ManagedSession;
	readonly modelFallbackMessage?: string;
}

/** Internal adapter. Not exported from the package entrypoint; public creation has one ordered factory. */
export function bindManagedSession(session: AgentSession): ManagedSession {
	if (!session.hasManagedEffects) throw new Error("Managed effects must be enabled before creating handles");
	const makeRequest = (scope: RequestScope): RequestHandle => {
		const effects = session.requestEffects(scope);
		const lifetime = (): RequestLifetimeSnapshot => Object.freeze({ ...scope.snapshot(), id: scope.id as RequestId });
		const snapshot = (selection?: RequestSelection): RequestMessagesSnapshot => {
			const source = session.getRequestMessages(scope, selection);
			return Object.freeze({
				coverage: source.coverage,
				tracking: source.tracking,
				scopes: Object.freeze(
					source.scopes.map(({ id, parentId, ...rest }) =>
						Object.freeze({
							...rest,
							id: id as RequestId,
							...(parentId ? { parentId: parentId as RequestId } : {}),
						}),
					),
				),
				records: Object.freeze(
					source.records.map((record) =>
						Object.freeze({
							...record,
							scopeId: record.scopeId as RequestId,
							invocations: Object.freeze(
								record.invocations.map((invocation) =>
									Object.freeze({
										...invocation,
										id: invocation.id as InvocationId,
										scopeId: invocation.scopeId as RequestId,
										deliveries: Object.freeze(
											invocation.deliveries.map(
												({ queueItemId: _nativeId, id, entryId, executionId, ...facts }) =>
													Object.freeze({
														...facts,
														id: id as DeliveryId,
														...(entryId ? { entryId: entryId as EntryId } : {}),
														...(executionId ? { executionId: executionId as ExecutionId } : {}),
													}),
											),
										),
									}),
								),
							),
						}),
					),
				),
			});
		};
		const messages: RequestMessages = Object.freeze({
			snapshot,
			remove: (
				options: RequestSelection & { readonly deliveryIds: readonly DeliveryId[] },
			): RemoveMessagesResult => {
				const ids = [...new Set(options.deliveryIds)];
				const source = session.getRequestMessages(scope, { includeDependents: options.includeDependents });
				const owned = new Map(
					source.records.flatMap((record) =>
						record.invocations.flatMap((invocation) =>
							invocation.deliveries.map((delivery) => [delivery.id, delivery] as const),
						),
					),
				);
				const unknown = ids.filter((id) => !owned.has(id));
				if (unknown.length)
					return Object.freeze({
						kind: "rejected",
						reason: "delivery-not-in-selected-history",
						deliveryIds: Object.freeze(unknown),
					});
				const selected = ids.map((id) => owned.get(id)!);
				const nativeIds = selected.flatMap((item) => (item.queueItemId === undefined ? [] : [item.queueItemId]));
				const removed = new Set<string>();
				const publicationErrors: string[] = [];
				if (nativeIds.length) {
					const actual = session.removeQueuedMessages(nativeIds);
					for (const item of [...actual.removed.steering, ...actual.removed.followUp]) {
						if (item.deliveryId) removed.add(item.deliveryId);
					}
					if (actual.displayError !== undefined) publicationErrors.push(actual.displayError);
				}
				// A synchronous native publication callback may have changed nextTurn ownership.
				// Only the following actual receipt counts, never the earlier snapshot.
				const nextTurnIds = selected.filter((item) => item.placement === "nextTurn").map((item) => item.id);
				if (nextTurnIds.length) for (const id of session.removeNextTurnMessages(nextTurnIds)) removed.add(id);
				return Object.freeze({
					kind: "attempted",
					publicationErrors: Object.freeze(publicationErrors),
					deliveries: Object.freeze(
						ids.map((id) =>
							Object.freeze({ id, kind: removed.has(id) ? ("removed" as const) : ("not-removed" as const) }),
						),
					),
				});
			},
			forget: (selection?: RequestSelection): ForgetMessagesResult => {
				// Freeze selection before checking. No await/publication between checks and backend forget.
				const includeDependents = selection?.includeDependents === true;
				const source = session.getRequestMessages(scope, { includeDependents });
				const reasons: ForgetBlocker[] = [];
				if (source.scopes.some((item) => !item.invalidated)) reasons.push("scope-active");
				if (
					source.scopes.some((item) => item.pendingInvocations > 0) ||
					source.records.some((record) => record.invocations.some((item) => !item.returned))
				)
					reasons.push("invocations-pending");
				if (session.getExecutionSnapshot()) reasons.push("execution-active");
				if (
					source.records.some((record) =>
						record.invocations.some((item) =>
							item.deliveries.some((delivery) => delivery.disposition === "unresolved"),
						),
					)
				)
					reasons.push("delivery-unresolved");
				if (reasons.length) return Object.freeze({ kind: "blocked", reasons: Object.freeze(reasons) });
				session.forgetRequestMessages(scope, { includeDependents });
				return Object.freeze({ kind: "forgotten" });
			},
		});
		return Object.freeze({
			id: scope.id as RequestId,
			signal: scope.signal,
			effects,
			messages,
			snapshot: lifetime,
			invalidate: () => {
				session.invalidateRequestScope(scope);
				return lifetime();
			},
			createDependent: () => makeRequest(session.createRequestScope(scope)),
			prompt: (text: string, options?: RequestPromptOptions): PromptInvocation => {
				const input = {
					expandPromptTemplates: options?.expandPromptTemplates,
					images: structuredClone(options?.images),
					streamingBehavior: options?.streamingBehavior,
					source: options?.source,
				};
				const receipt = effects.createMessageReceipt();
				const id = receipt.id as InvocationId;
				const requestId = scope.id as RequestId;
				const current = (): PromptInvocationSnapshot => {
					const source = snapshot();
					const record = source.records[0];
					const invocation = record.invocations.find((item) => item.id === id);
					return Object.freeze({
						id,
						requestId,
						tracking: source.tracking,
						history: record.history,
						...(invocation ? { invocation } : {}),
					});
				};
				const result = session
					.prompt(text, { ...input, scope, receipt })
					.then((): MessageInvocationResult => Object.freeze({ kind: "returned", invocationId: id }))
					.finally(() => receipt.release());
				// A handle may be observed before its completion is awaited; preserve rejection for that await.
				void result.catch(() => {});
				return Object.freeze({
					id,
					requestId,
					result,
					snapshot: current,
					observe: (listener: (value: PromptInvocationSnapshot) => void) =>
						session.observeRequestMessages(scope, () => listener(current())),
				});
			},
		});
	};
	return Object.freeze({
		requests: Object.freeze({ create: () => makeRequest(session.createRequestScope()) }),
		executions: Object.freeze({
			snapshot: (): ManagedExecutionSnapshot | undefined => {
				const current = session.getExecutionSnapshot();
				if (!current) return undefined;
				const { initiatingScopeId, ...rest } = current;
				return Object.freeze({
					...rest,
					id: current.id as ExecutionId,
					...(initiatingScopeId ? { initiatingScopeId: initiatingScopeId as RequestId } : {}),
				});
			},
			stop: async ({ executionId }: { readonly executionId: ExecutionId }): Promise<StopExecutionResult> =>
				Object.freeze({
					kind: (await session.stopExecution(executionId)) ? "settled" : "target-not-active",
					executionId,
				}),
		}),
		subscribe: (listener: AgentSessionEventListener) =>
			session.subscribe((event) => listener(structuredClone(event))),
		dispose: () => {
			session.dispose();
			return Object.freeze({ kind: "tracking-closed" as const });
		},
	});
}

/** One recommended managed entrypoint: activate BEFORE publishing extension contexts or the host handle. */
export async function createManagedSession(
	options: CreateManagedSessionOptions = {},
): Promise<CreateManagedSessionResult> {
	const { session, extensionsResult, modelFallbackMessage } = await createAgentSession(options);
	try {
		session.enableManagedEffects();
		if (extensionsResult.errors.length)
			throw new Error(`Extension loading failed: ${JSON.stringify(extensionsResult.errors)}`);
		await session.bindExtensions(options.bindings ?? {});
		return Object.freeze({
			session: bindManagedSession(session),
			...(modelFallbackMessage ? { modelFallbackMessage } : {}),
		});
	} catch (error) {
		session.dispose();
		throw error;
	}
}
