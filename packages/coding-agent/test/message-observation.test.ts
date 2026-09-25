import { expect, it } from "vitest";
import { MessageEvidence } from "../src/core/message-evidence.ts";

it("coalesces committed facts and publishes an initial snapshot without inline reentrancy", async () => {
	const evidence = new MessageEvidence();
	const invocation = evidence.begin(undefined, "scope")!;
	let calls = 0;
	let resolve!: () => void;
	const observed = new Promise<void>((done) => {
		resolve = done;
	});
	const subscription = evidence.observe("scope", () => {
		calls++;
		resolve();
	});
	const id = evidence.register(invocation, "user", "followUp")!;
	evidence.update(id, { queueItemId: 1 });
	evidence.finish(invocation);
	expect(calls).toBe(0);
	await observed;
	expect(calls).toBe(1);
	expect(evidence.forScopes(["scope"])[0].invocations[0]).toMatchObject({
		returned: true,
		deliveries: [{ admission: "session-accepted" }],
	});
	subscription.release();
	expect(await subscription.closed).toEqual({ kind: "released" });
});

it("an observer failure closes only that subscription and is inspectable", async () => {
	const evidence = new MessageEvidence();
	const invocation = evidence.begin(undefined, "scope")!;
	const bad = evidence.observe("scope", () => {
		throw new Error("observer");
	});
	let resolve!: () => void;
	const observed = new Promise<void>((done) => {
		resolve = done;
	});
	const good = evidence.observe("scope", resolve);
	evidence.finish(invocation);
	await observed;
	expect(await bad.closed).toEqual({ kind: "failed", error: "Error: observer" });
	expect(bad.snapshot()).toEqual(await bad.closed);
	expect(evidence.forScopes(["scope"])[0].invocations[0].returned).toBe(true);
	expect(good.snapshot()).toEqual({ kind: "observing" });
	good.release();
});

it("diagnoses async callbacks and consumes their rejected Promise", async () => {
	const evidence = new MessageEvidence();
	const subscription = evidence.observe("scope", async () => {
		throw new Error("async error");
	});
	expect(await subscription.closed).toEqual({ kind: "failed", error: "Error: Message observers must be synchronous" });
});

for (const boundary of ["forget", "close"] as const)
	it(`publishes a boundary caused by its own observer (${boundary}) before ending`, async () => {
		const evidence = new MessageEvidence();
		const invocation = evidence.begin(undefined, "scope")!;
		evidence.finish(invocation);
		const seen: string[] = [];
		const observation = evidence.observe("scope", () => {
			seen.push(boundary === "forget" ? evidence.forScopes(["scope"])[0].history : evidence.tracking);
			if (seen.length === 1) {
				if (boundary === "forget") evidence.forget(["scope"]);
				else evidence.close();
			}
		});
		expect(await observation.closed).toEqual({
			kind: boundary === "forget" ? "history-forgotten" : "tracking-closed",
		});
		expect(seen).toEqual(boundary === "forget" ? ["retained", "forgotten"] : ["active", "session-closed"]);
	});

it("release before initial notification invokes no callback", async () => {
	const evidence = new MessageEvidence();
	let calls = 0;
	const subscription = evidence.observe("scope", () => {
		calls++;
	});
	subscription.release();
	await subscription.closed;
	expect(calls).toBe(0);
});

it("receipt release does not close ledger observation; explicit forgetting does", async () => {
	const evidence = new MessageEvidence();
	const receipt = evidence.create();
	const invocation = evidence.begin(receipt, "scope")!;
	receipt.release();
	const subscription = evidence.observe("scope", () => {});
	evidence.finish(invocation);
	evidence.forget(["scope"]);
	expect(await subscription.closed).toEqual({ kind: "history-forgotten" });
	expect(receipt.snapshot().returned).toBe(false);
	expect(evidence.forScopes(["scope"])[0].history).toBe("forgotten");
});

it("tracking closure publishes its boundary but does not pretend a pending call settled", async () => {
	const evidence = new MessageEvidence();
	const invocation = evidence.begin(undefined, "scope")!;
	let returned: boolean | undefined;
	const subscription = evidence.observe("scope", () => {
		returned = evidence.forScopes(["scope"])[0].invocations[0].returned;
	});
	evidence.close();
	expect(await subscription.closed).toEqual({ kind: "tracking-closed" });
	expect(returned).toBe(false);
	evidence.finish(invocation, "late");
	expect(evidence.forScopes(["scope"])[0].invocations[0].returned).toBe(true);
	expect(returned).toBe(false);
});
