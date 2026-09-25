import { describe, expect, it } from "vitest";
import { MessageEvidence } from "../src/core/message-evidence.ts";

describe("submission evidence handles", () => {
	it("rejects foreign and reused handles before producer invocation", () => {
		const a = new MessageEvidence(),
			b = new MessageEvidence();
		const receipt = a.create();
		expect(() => b.begin(receipt)).toThrow("belong to this Session");
		a.begin(receipt);
		expect(() => a.begin(receipt)).toThrow("unused");
	});

	it("preserves separate invocation return, delivery, removal and entry facts", () => {
		const a = new MessageEvidence(),
			receipt = a.create();
		const invocation = a.begin(receipt);
		const first = a.register(invocation, "user", "steering");
		const second = a.register(invocation, "before-agent-start", "direct");
		a.update(first, { queueItemId: 4 });
		a.outcome(invocation, "submitted");
		a.finish(invocation);
		const before = receipt.snapshot();
		a.update(first, { removed: true });
		a.update(second, { started: true, entryId: "entry" });
		expect(before.deliveries.every((item) => !item.removed && !item.entryId)).toBe(true);
		expect(receipt.snapshot()).toMatchObject({
			returned: true,
			outcome: "submitted",
			deliveries: [
				{ queueItemId: 4, removed: true, started: false },
				{ entryId: "entry", started: true },
			],
		});
		expect(Object.isFrozen(before.deliveries)).toBe(true);
		expect(Object.isFrozen(before.deliveries[0])).toBe(true);
	});

	it("release and close stop observation without inventing cancellation or removal", () => {
		const a = new MessageEvidence(),
			receipt = a.create();
		const invocation = a.begin(receipt);
		const id = a.register(invocation, "custom", "nextTurn");
		receipt.release();
		a.update(id, { removed: true });
		expect(a.register(invocation, "user", "direct")).toBeUndefined();
		expect(receipt.snapshot()).toMatchObject({ observing: false, returned: false, deliveries: [{ removed: false }] });
		const other = a.create();
		a.close();
		expect(other.snapshot().observing).toBe(false);
		expect(() => a.begin(other)).toThrow();
		expect(() => a.create()).toThrow();
	});

	it("failure does not erase a previously recorded native insertion", () => {
		const a = new MessageEvidence(),
			receipt = a.create();
		const invocation = a.begin(receipt);
		const id = a.register(invocation, "user", "followUp");
		a.update(id, { queueItemId: 9 });
		a.finish(invocation, "display failed");
		expect(receipt.snapshot()).toMatchObject({
			outcome: "failed",
			returned: true,
			deliveries: [{ queueItemId: 9, removed: false }],
		});
	});
});
