import { describe, expect, it } from "vitest";
import {
	ExecutionStoppedError,
	RequestInvalidatedError,
	RequestLifetimes,
	SessionExecutionBusyError,
} from "../src/core/request-lifetime.ts";

describe("request lifetime and execution ownership", () => {
	it("separates invalidation from actual invocation settlement", () => {
		const owner = new RequestLifetimes();
		const scope = owner.create();
		const leave = owner.enter(scope);
		expect(owner.invalidate(scope)).toMatchObject({ invalidated: true, pendingInvocations: 1 });
		expect(scope.signal.aborted).toBe(true);
		expect(() => owner.enter(scope)).toThrow(RequestInvalidatedError);
		leave();
		leave();
		expect(scope.snapshot().pendingInvocations).toBe(0);
	});

	it("marks all descendants before abort listeners can reenter; independent scopes survive", () => {
		const owner = new RequestLifetimes();
		const parent = owner.create();
		const child = owner.create(parent);
		const independent = owner.create();
		let observed = false;
		parent.signal.addEventListener("abort", () => {
			observed = child.snapshot().invalidated;
			expect(() => owner.enter(child)).toThrow(RequestInvalidatedError);
		});
		owner.invalidate(parent);
		expect(observed).toBe(true);
		expect(child.signal.aborted).toBe(true);
		expect(() => owner.create(parent)).toThrow(RequestInvalidatedError);
		expect(() => owner.check(independent)).not.toThrow();
	});

	it("rejects foreign scopes even if their public ID is copied", () => {
		const a = new RequestLifetimes();
		const b = new RequestLifetimes();
		const scope = a.create();
		expect(() => b.enter(scope)).toThrow("another Session");
		expect(() => a.enter({ ...scope })).toThrow("another Session");
		expect(() => b.invalidate(scope)).toThrow("another Session");
	});

	it("closing invalidates issued scopes and rejects creation, without pretending all calls returned", () => {
		const owner = new RequestLifetimes();
		const scope = owner.create();
		const leave = owner.enter(scope);
		owner.closeScopes();
		expect(scope.snapshot()).toMatchObject({ invalidated: true, pendingInvocations: 1 });
		expect(() => owner.create()).toThrow(RequestInvalidatedError);
		leave();
	});

	it("owns shared execution without equating initiating scope with all participants", async () => {
		const owner = new RequestLifetimes();
		const a = owner.create();
		const b = owner.create();
		const lease = owner.reserve(a);
		expect(() => owner.reserve(b)).toThrow(SessionExecutionBusyError);
		owner.invalidate(a);
		// Invalidation of one request does not silently stop a possibly shared execution.
		expect(owner.snapshot()).toMatchObject({ initiatingScopeId: a.id, stopRequested: false });
		expect(owner.requestStop(lease.id)).toBe(lease);
		expect(() => owner.assertOwner(lease)).toThrow(ExecutionStoppedError);
		owner.release(lease);
		await lease.done;
		const next = owner.reserve(b);
		owner.release(lease);
		expect(owner.snapshot()?.id).toBe(next.id);
		expect(owner.requestStop(lease.id)).toBeUndefined();
		owner.release(next);
	});

	it("counts unscoped producers too so mode activation cannot race an old call", () => {
		const owner = new RequestLifetimes();
		const leave = owner.enter();
		expect(owner.hasInvocations).toBe(true);
		leave();
		expect(owner.hasInvocations).toBe(false);
	});

	it("append commits validate scope without stealing the conflicting execution lease", () => {
		const owner = new RequestLifetimes();
		const scope = owner.create();
		const execution = owner.reserve(scope);
		let mutations = 0;
		expect(owner.commit(scope, () => ++mutations)).toBe(1);
		expect(owner.snapshot()?.id).toBe(execution.id);
		owner.invalidate(scope);
		expect(() => owner.commit(scope, () => ++mutations)).toThrow(RequestInvalidatedError);
		expect(mutations).toBe(1);
		owner.release(execution);
	});

	it("snapshots cannot mutate execution authority", () => {
		const owner = new RequestLifetimes();
		const scope = owner.create();
		const lease = owner.reserve(scope);
		expect(Object.isFrozen(scope)).toBe(true);
		expect(Object.isFrozen(scope.snapshot())).toBe(true);
		expect(Object.isFrozen(owner.snapshot())).toBe(true);
		owner.release(lease);
	});
});
