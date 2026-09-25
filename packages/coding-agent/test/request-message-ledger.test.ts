import { describe, expect, it } from "vitest";
import { MessageEvidence } from "../src/core/message-evidence.ts";
import { RequestLifetimes } from "../src/core/request-lifetime.ts";

describe("request message ownership independent of observation", () => {
	it("auto-registers scoped calls and preserves ledger updates after observation release", () => {
		const a = new MessageEvidence(),
			receipt = a.create();
		const observed = a.begin(receipt, "scope");
		receipt.release();
		const id = a.register(observed, "user", "followUp")!;
		a.update(id, { queueItemId: 7, removed: true });
		a.finish(observed);
		const automatic = a.begin(undefined, "scope");
		const other = a.register(automatic, "custom", "nextTurn")!;
		a.accept(other);
		a.finish(automatic);
		expect(receipt.snapshot()).toMatchObject({ observing: false, returned: false, deliveries: [] });
		const records = a.forScopes(["scope"])[0]!.invocations;
		expect(records).toHaveLength(2);
		expect(records[0]!.deliveries[0]).toMatchObject({ disposition: "removed", admission: "session-accepted" });
		expect(records[1]!.deliveries[0]).toMatchObject({ disposition: "unresolved", admission: "session-accepted" });
		expect(records[0]!.id).toBe(receipt.id);
	});

	it("native message-ended does not manufacture entry commit; unstarted cleanup is positive evidence", () => {
		const a = new MessageEvidence(),
			invocation = a.begin(undefined, "scope");
		const first = a.register(invocation, "user", "direct")!;
		const second = a.register(invocation, "custom", "direct")!;
		a.settleRun(
			{
				runId: 1,
				failed: true,
				abortRequested: false,
				deliveries: [
					{ deliveryId: first, phase: "message-ended" },
					{ deliveryId: second, phase: "discarded-before-start" },
				],
			},
			"execution",
		);
		const deliveries = a.forScopes(["scope"])[0]!.invocations[0]!.deliveries;
		expect(deliveries[0]).toMatchObject({ disposition: "unresolved", executionId: "execution" });
		expect(deliveries[1]).toMatchObject({ disposition: "discarded-before-start", executionId: "execution" });
		expect(deliveries[0]!.entryId).toBeUndefined();
	});

	it("forget validates the entire selection first and keeps explicit history tombstones", () => {
		const a = new MessageEvidence();
		const done = a.begin(undefined, "done"),
			pending = a.begin(undefined, "pending");
		const id = a.register(done, "user", "steering");
		a.update(id, { removed: true });
		a.finish(done);
		expect(() => a.forget(["done", "pending"])).toThrow("unsettled");
		expect(a.forScopes(["done"])[0]!.history).toBe("retained");
		a.finish(pending);
		a.forget(["done", "pending"]);
		a.forget(["done", "pending"]);
		expect(a.forScopes(["done"])[0]).toMatchObject({ history: "forgotten", invocations: [] });
		expect(() => a.begin(undefined, "done")).toThrow("forgotten");
	});

	it("close freezes observation but does not reinterpret missing ledger facts as cancellation", () => {
		const a = new MessageEvidence(),
			receipt = a.create();
		const invocation = a.begin(receipt, "scope");
		const id = a.register(invocation, "custom", "nextTurn");
		a.close();
		a.update(id, { removed: true });
		a.finish(invocation);
		receipt.release();
		expect(receipt.snapshot()).toMatchObject({ observing: false, returned: false, deliveries: [{ removed: false }] });
		expect(a.tracking).toBe("session-closed");
		expect(a.forScopes(["scope"])[0]!.invocations[0]).toMatchObject({
			returned: true,
			deliveries: [{ removed: true }],
		});
	});

	it("dependent scope enumeration survives invalidation and separates independent scopes and counts", () => {
		const life = new RequestLifetimes(),
			parent = life.create(),
			child = life.create(parent),
			other = life.create();
		const leave = life.enter(child);
		life.invalidate(child);
		life.invalidate(parent);
		expect(life.describe(parent, true)).toEqual([
			{ id: parent.id, invalidated: true, pendingInvocations: 0 },
			{ id: child.id, parentId: parent.id, invalidated: true, pendingInvocations: 1 },
		]);
		expect(life.describe(parent)).toHaveLength(1);
		expect(life.describe(other)[0]!.invalidated).toBe(false);
		expect(() => life.describe({ ...parent })).toThrow("another Session");
		leave();
		expect(life.describe(parent, true)[1]!.pendingInvocations).toBe(0);
	});
});
