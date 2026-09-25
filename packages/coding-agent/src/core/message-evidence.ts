import { randomUUID } from "node:crypto";
import type { NativeDeliveryOutcome, NativeRunDeliveryReport } from "@earendil-works/pi-agent-core";

export interface MessageDeliveryEvidence {
	readonly id: string;
	readonly kind: "user" | "custom" | "before-agent-start";
	readonly placement: "direct" | "steering" | "followUp" | "nextTurn";
	readonly queueItemId?: number;
	readonly started: boolean;
	readonly entryId?: string;
	readonly removed: boolean;
}

export interface MessageSubmissionSnapshot {
	readonly id: string;
	readonly outcome: "pending" | "handled" | "submitted" | "failed";
	readonly returned: boolean;
	readonly error?: string;
	readonly observing: boolean;
	readonly deliveries: readonly MessageDeliveryEvidence[];
}

/** Single-use, Session-local observation handle. Releasing observation does not cancel execution. */
export interface MessageSubmissionReceipt {
	readonly id: string;
	snapshot(): MessageSubmissionSnapshot;
	release(): void;
}

export type MessageObservationEnd =
	| { readonly kind: "released" | "tracking-closed" | "history-forgotten" }
	| { readonly kind: "failed"; readonly error: string };

export interface MessageObservation {
	/** Ends only this subscription, never the request or its retained message history. */
	release(): void;
	snapshot(): { readonly kind: "observing" } | MessageObservationEnd;
	readonly closed: Promise<MessageObservationEnd>;
}

export interface RequestDeliveryRecord extends MessageDeliveryEvidence {
	readonly admission: "registered" | "session-accepted";
	readonly disposition: "unresolved" | "entry-recorded" | "removed" | "discarded-before-start";
	readonly executionId?: string;
	readonly native?: {
		readonly runId: number;
		readonly phase: NativeDeliveryOutcome["phase"];
		readonly failed: boolean;
		readonly abortRequested: boolean;
	};
}

export interface RequestMessageRecord {
	readonly id: string;
	readonly scopeId: string;
	readonly outcome: MessageSubmissionSnapshot["outcome"];
	readonly returned: boolean;
	readonly error?: string;
	readonly deliveries: readonly RequestDeliveryRecord[];
}

export interface ScopeMessageRecords {
	readonly scopeId: string;
	readonly history: "retained" | "forgotten";
	readonly invocations: readonly RequestMessageRecord[];
}

type DeliveryRecord = {
	-readonly [K in keyof Omit<RequestDeliveryRecord, keyof MessageDeliveryEvidence>]: RequestDeliveryRecord[K];
};
type MutableDelivery = { -readonly [K in keyof MessageDeliveryEvidence]: MessageDeliveryEvidence[K] } & {
	record?: DeliveryRecord;
};
export interface EvidenceInvocation {
	id: string;
	used: boolean;
	released: boolean;
	scopeId?: string;
	outcome: MessageSubmissionSnapshot["outcome"];
	returned: boolean;
	error?: string;
	deliveries: MutableDelivery[];
	frozenObservation?: MessageSubmissionSnapshot;
}

/** SDK facts only: optional observation and explicit scoped ownership have independent retention. */
export class MessageEvidence {
	private readonly generation = randomUUID();
	private nextInvocation = 0;
	private nextDelivery = 0;
	private closed = false;
	private readonly receipts = new WeakMap<MessageSubmissionReceipt, EvidenceInvocation>();
	private readonly observations = new Set<EvidenceInvocation>();
	private readonly deliveries = new Map<string, MutableDelivery>();
	private readonly ownedDeliveries = new Map<string, MutableDelivery>();
	private readonly owned = new Map<string, EvidenceInvocation[]>();
	private readonly forgotten = new Set<string>();
	private readonly deliveryOwners = new WeakMap<MutableDelivery, EvidenceInvocation>();
	private readonly listeners = new Map<string, Set<() => void>>();

	/** Latest-state notifications, never callbacks inside an admission/mutation boundary. */
	private changed(scopeId?: string): void {
		if (scopeId) for (const schedule of this.listeners.get(scopeId) ?? []) schedule();
	}

	observe(scopeId: string, listener: () => void): MessageObservation {
		let state: { readonly kind: "observing" } | MessageObservationEnd = Object.freeze({ kind: "observing" });
		let queued = false;
		let resolve!: (end: MessageObservationEnd) => void;
		const closed = new Promise<MessageObservationEnd>((done) => {
			resolve = done;
		});
		const end = (result: MessageObservationEnd): void => {
			if (state.kind !== "observing") return;
			state = Object.freeze(result);
			const listeners = this.listeners.get(scopeId);
			listeners?.delete(schedule);
			if (listeners?.size === 0) this.listeners.delete(scopeId);
			resolve(result);
		};
		const schedule = (): void => {
			if (queued || state.kind !== "observing") return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				if (state.kind !== "observing") return;
				try {
					// The callback may itself close tracking or forget history. Publish that new boundary
					// in the scheduled next snapshot before ending, not against this older snapshot.
					const terminal = this.closed
						? "tracking-closed"
						: this.forgotten.has(scopeId)
							? "history-forgotten"
							: undefined;
					const returned: unknown = listener();
					if (
						returned !== null &&
						(typeof returned === "object" || typeof returned === "function") &&
						"then" in returned
					) {
						// Consume an untyped async callback rejection, but do not await it or call it again.
						void Promise.resolve(returned).catch(() => {});
						throw new Error("Message observers must be synchronous");
					}
					if (terminal) end({ kind: terminal });
				} catch (error) {
					let message = "Message observer failed";
					try {
						message = String(error);
					} catch {
						/* Untrusted thrown values may reject stringification. */
					}
					end({ kind: "failed", error: message });
				}
			});
		};
		const listeners = this.listeners.get(scopeId) ?? new Set<() => void>();
		listeners.add(schedule);
		this.listeners.set(scopeId, listeners);
		schedule(); // subscribe + current snapshot, no missed registration window
		return Object.freeze({ release: () => end({ kind: "released" }), snapshot: () => state, closed });
	}

	private newInvocation(): EvidenceInvocation {
		return {
			id: `${this.generation}:submission:${++this.nextInvocation}`,
			used: false,
			released: false,
			outcome: "pending",
			returned: false,
			deliveries: [],
		};
	}

	private observation(invocation: EvidenceInvocation): MessageSubmissionSnapshot {
		return Object.freeze({
			id: invocation.id,
			outcome: invocation.outcome,
			returned: invocation.returned,
			...(invocation.error ? { error: invocation.error } : {}),
			observing: !this.closed && !invocation.released,
			deliveries: Object.freeze(invocation.deliveries.map(({ record: _record, ...facts }) => Object.freeze(facts))),
		});
	}

	create(): MessageSubmissionReceipt {
		if (this.closed) throw new Error("Message evidence is closed");
		const invocation = this.newInvocation();
		this.observations.add(invocation);
		const receipt = Object.freeze({
			id: invocation.id,
			snapshot: () => invocation.frozenObservation ?? this.observation(invocation),
			release: () => {
				if (invocation.released) return;
				invocation.released = true;
				invocation.frozenObservation ??= this.observation(invocation);
				this.observations.delete(invocation);
				for (const item of invocation.deliveries) this.deliveries.delete(item.id);
			},
		});
		this.receipts.set(receipt, invocation);
		return receipt;
	}

	begin(receipt?: MessageSubmissionReceipt, scopeId?: string): EvidenceInvocation | undefined {
		if (!receipt && !scopeId) return undefined;
		const invocation = receipt ? this.receipts.get(receipt) : this.newInvocation();
		if (!invocation || invocation.used || invocation.released || this.closed) {
			throw new Error("Receipt must be unused, observing, and belong to this Session");
		}
		if (scopeId && this.forgotten.has(scopeId)) throw new Error("Scope message history was forgotten");
		invocation.used = true;
		if (scopeId) {
			invocation.scopeId = scopeId;
			const records = this.owned.get(scopeId) ?? [];
			records.push(invocation);
			this.owned.set(scopeId, records);
			this.changed(scopeId);
		}
		return invocation;
	}

	outcome(invocation: EvidenceInvocation | undefined, outcome: MessageSubmissionSnapshot["outcome"]): void {
		if (invocation && (invocation.scopeId || (!invocation.released && !this.closed))) {
			invocation.outcome = outcome;
			this.changed(invocation.scopeId);
		}
	}

	finish(invocation: EvidenceInvocation | undefined, error?: unknown): void {
		if (!invocation || (!invocation.scopeId && (invocation.released || this.closed))) return;
		invocation.returned = true;
		if (error !== undefined) {
			invocation.outcome = "failed";
			invocation.error = String(error);
		}
		this.changed(invocation.scopeId);
	}

	register(
		invocation: EvidenceInvocation | undefined,
		kind: MessageDeliveryEvidence["kind"],
		placement: MessageDeliveryEvidence["placement"],
	): string | undefined {
		if (!invocation || (!invocation.scopeId && (invocation.released || this.closed))) return undefined;
		const item: MutableDelivery = {
			id: `${this.generation}:delivery:${++this.nextDelivery}`,
			kind,
			placement,
			started: false,
			removed: false,
			...(invocation.scopeId
				? { record: { admission: "registered" as const, disposition: "unresolved" as const } }
				: {}),
		};
		invocation.deliveries.push(item);
		this.deliveryOwners.set(item, invocation);
		this.changed(invocation.scopeId);
		if (!invocation.released && !this.closed) this.deliveries.set(item.id, item);
		if (invocation.scopeId) this.ownedDeliveries.set(item.id, item);
		return item.id;
	}

	accept(id: string | undefined, executionId?: string): void {
		const record = id ? this.ownedDeliveries.get(id)?.record : undefined;
		if (!record) return;
		record.admission = "session-accepted";
		if (executionId) record.executionId = executionId;
		this.changed(this.deliveryOwners.get(this.ownedDeliveries.get(id!)!)?.scopeId);
	}

	update(id: string | undefined, facts: Partial<Omit<MessageDeliveryEvidence, "id" | "kind">>): void {
		const item = id ? (this.ownedDeliveries.get(id) ?? this.deliveries.get(id)) : undefined;
		if (!item) return;
		Object.assign(item, facts);
		if (item.record) {
			if (facts.queueItemId !== undefined || facts.started || facts.entryId || facts.removed) this.accept(id);
			if (facts.entryId !== undefined) item.record.disposition = "entry-recorded";
			else if (facts.removed) item.record.disposition = "removed";
		}
		if (facts.entryId !== undefined || facts.removed) this.deliveries.delete(item.id);
		this.changed(this.deliveryOwners.get(item)?.scopeId);
	}

	settleRun(report: NativeRunDeliveryReport, executionId: string): void {
		for (const native of report.deliveries) {
			const item = this.ownedDeliveries.get(native.deliveryId);
			if (!item?.record) continue;
			this.accept(item.id, executionId);
			item.record.native = Object.freeze({
				runId: report.runId,
				phase: native.phase,
				failed: report.failed,
				abortRequested: report.abortRequested,
			});
			if (item.record.disposition === "unresolved" && native.phase === "discarded-before-start") {
				item.record.disposition = "discarded-before-start";
			}
		}
	}

	get tracking(): "active" | "session-closed" {
		return this.closed ? "session-closed" : "active";
	}

	forScopes(scopeIds: readonly string[]): readonly ScopeMessageRecords[] {
		return Object.freeze(
			scopeIds.map((scopeId) =>
				Object.freeze({
					scopeId,
					history: this.forgotten.has(scopeId) ? ("forgotten" as const) : ("retained" as const),
					invocations: Object.freeze(
						(this.owned.get(scopeId) ?? []).map(
							(invocation): RequestMessageRecord =>
								Object.freeze({
									id: invocation.id,
									scopeId,
									outcome: invocation.outcome,
									returned: invocation.returned,
									...(invocation.error ? { error: invocation.error } : {}),
									deliveries: Object.freeze(
										invocation.deliveries.map(({ record, ...facts }) =>
											Object.freeze({ ...facts, ...record! }),
										),
									),
								}),
						),
					),
				}),
			),
		);
	}

	/** Caller must first validate invalidation and all selected scope lifetimes. No partial deletion. */
	forget(scopeIds: readonly string[]): void {
		for (const scopeId of scopeIds) {
			for (const invocation of this.owned.get(scopeId) ?? []) {
				if (
					!invocation.returned ||
					invocation.deliveries.some((item) => item.record?.disposition === "unresolved")
				) {
					throw new Error("Cannot forget unsettled or unresolved request messages");
				}
			}
		}
		for (const scopeId of scopeIds) {
			for (const invocation of this.owned.get(scopeId) ?? []) {
				for (const item of invocation.deliveries) this.ownedDeliveries.delete(item.id);
				this.observations.delete(invocation);
			}
			this.owned.delete(scopeId);
			this.forgotten.add(scopeId);
			this.changed(scopeId);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const invocation of this.observations) invocation.frozenObservation = this.observation(invocation);
		this.observations.clear();
		this.deliveries.clear();
		for (const scopeId of this.listeners.keys()) this.changed(scopeId);
	}
}
