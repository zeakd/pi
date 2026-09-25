import { randomUUID } from "node:crypto";

export interface RequestScopeSnapshot {
	readonly id: string;
	readonly invalidated: boolean;
	/** Tracked SDK calls, not arbitrary extension IO or accepted delivery completion. */
	readonly pendingInvocations: number;
}

/** Session-local authority for future producer effects, independent of observation receipts. */
export interface RequestScope {
	readonly id: string;
	readonly signal: AbortSignal;
	snapshot(): RequestScopeSnapshot;
}

export interface ExecutionSnapshot {
	readonly id: string;
	readonly initiatingScopeId?: string;
	readonly phase: "preparing" | "running" | "settling";
	readonly stopRequested: boolean;
}

export class RequestInvalidatedError extends Error {
	constructor() {
		super("Request scope is invalidated");
		this.name = "RequestInvalidatedError";
	}
}

export class ExecutionStoppedError extends Error {
	constructor() {
		super("Session execution was stopped before this continuation");
		this.name = "ExecutionStoppedError";
	}
}

export class SessionExecutionBusyError extends Error {
	constructor() {
		super("Session execution is owned by another operation");
		this.name = "SessionExecutionBusyError";
	}
}

export class StalePreparationError extends Error {
	constructor() {
		super("Session changed during request preparation; resubmit explicitly");
		this.name = "StalePreparationError";
	}
}

interface ScopeState {
	id: string;
	controller: AbortController;
	invalidated: boolean;
	pendingInvocations: number;
	parent?: ScopeState;
	children: Set<ScopeState>;
	/** Historical cancellation dependency, retained through invalidation while this scope handle lives. */
	dependents: Set<ScopeState>;
}

export interface ExecutionLease {
	readonly id: string;
	readonly initiatingScopeId?: string;
	phase: ExecutionSnapshot["phase"];
	stopRequested: boolean;
	readonly done: Promise<void>;
	readonly resolve: () => void;
}

/** Synchronous ownership decisions only. Never holds an async callback or an admission queue. */
export class RequestLifetimes {
	private readonly generation = randomUUID();
	private sequence = 0;
	private closed = false;
	private activeInvocations = 0;
	private readonly scopes = new WeakMap<RequestScope, ScopeState>();
	private readonly liveScopes = new Set<ScopeState>();
	private execution?: ExecutionLease;

	create(parent?: RequestScope): RequestScope {
		if (this.closed) throw new RequestInvalidatedError();
		this.check(parent);
		const parentState = parent ? this.scopes.get(parent) : undefined;
		const state: ScopeState = {
			id: `${this.generation}:scope:${++this.sequence}`,
			controller: new AbortController(),
			invalidated: false,
			pendingInvocations: 0,
			parent: parentState,
			children: new Set(),
			dependents: new Set(),
		};
		const scope: RequestScope = Object.freeze({
			id: state.id,
			signal: state.controller.signal,
			snapshot: () =>
				Object.freeze({
					id: state.id,
					invalidated: state.invalidated,
					pendingInvocations: state.pendingInvocations,
				}),
		});
		parentState?.children.add(state);
		parentState?.dependents.add(state);
		this.scopes.set(scope, state);
		this.liveScopes.add(state);
		return scope;
	}

	describe(
		scope: RequestScope,
		includeDependents = false,
	): readonly (RequestScopeSnapshot & { readonly parentId?: string })[] {
		const root = this.scopes.get(scope);
		if (!root) throw new Error("Request scope belongs to another Session");
		const selected: ScopeState[] = [];
		const visit = (state: ScopeState): void => {
			selected.push(state);
			if (includeDependents) for (const child of state.dependents) visit(child);
		};
		visit(root);
		return Object.freeze(
			selected.map((state) =>
				Object.freeze({
					id: state.id,
					invalidated: state.invalidated,
					pendingInvocations: state.pendingInvocations,
					...(state.parent ? { parentId: state.parent.id } : {}),
				}),
			),
		);
	}

	check(scope?: RequestScope): void {
		if (!scope) return;
		const state = this.scopes.get(scope);
		if (!state) throw new Error("Request scope belongs to another Session");
		if (state.invalidated || this.closed) throw new RequestInvalidatedError();
	}

	get hasInvocations(): boolean {
		return this.activeInvocations > 0;
	}

	/** Synchronous append lane; caller publishes callbacks only after the mutation returns. */
	commit<T>(scope: RequestScope, mutation: () => T): T {
		this.check(scope);
		return mutation();
	}

	enter(scope?: RequestScope): () => void {
		this.check(scope);
		this.activeInvocations++;
		const state = scope ? this.scopes.get(scope) : undefined;
		if (state) state.pendingInvocations++;
		let finished = false;
		return () => {
			if (finished) return;
			finished = true;
			this.activeInvocations--;
			if (state) state.pendingInvocations--;
		};
	}

	invalidate(scope: RequestScope): RequestScopeSnapshot {
		const state = this.scopes.get(scope);
		if (!state) throw new Error("Request scope belongs to another Session");
		this.invalidateStates([state]);
		return scope.snapshot();
	}

	private invalidateStates(roots: ScopeState[]): void {
		const selected = new Set<ScopeState>();
		const visit = (state: ScopeState): void => {
			if (selected.has(state)) return;
			selected.add(state);
			for (const child of state.children) visit(child);
		};
		for (const root of roots) visit(root);
		// Mark the whole subtree before invoking any synchronous abort listener.
		for (const state of selected) {
			state.invalidated = true;
			this.liveScopes.delete(state);
			state.parent?.children.delete(state);
			state.children.clear();
		}
		for (const state of selected) state.controller.abort();
	}

	closeScopes(): void {
		this.closed = true;
		this.invalidateStates([...this.liveScopes]);
	}

	reserve(scope?: RequestScope): ExecutionLease {
		this.check(scope);
		if (this.execution) throw new SessionExecutionBusyError();
		let resolve!: () => void;
		const done = new Promise<void>((complete) => {
			resolve = complete;
		});
		const lease: ExecutionLease = {
			id: `${this.generation}:execution:${++this.sequence}`,
			initiatingScopeId: scope?.id,
			phase: "preparing",
			stopRequested: false,
			done,
			resolve,
		};
		this.execution = lease;
		return lease;
	}

	assertOwner(lease: ExecutionLease): void {
		if (this.execution !== lease) throw new Error("Stale session execution owner");
		if (lease.stopRequested) throw new ExecutionStoppedError();
	}

	requestStop(id: string): ExecutionLease | undefined {
		if (this.execution?.id !== id) return undefined;
		this.execution.stopRequested = true;
		return this.execution;
	}

	release(lease: ExecutionLease): void {
		if (this.execution !== lease) return;
		this.execution = undefined;
		lease.resolve();
	}

	snapshot(): ExecutionSnapshot | undefined {
		const lease = this.execution;
		return lease
			? Object.freeze({
					id: lease.id,
					initiatingScopeId: lease.initiatingScopeId,
					phase: lease.phase,
					stopRequested: lease.stopRequested,
				})
			: undefined;
	}
}
