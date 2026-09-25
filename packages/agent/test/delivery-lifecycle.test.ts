import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentMessage } from "../src/types.ts";

const user = (): AgentMessage => ({ role: "user", content: "same", timestamp: 0 });
function agent() {
	return new Agent({
		streamFn: () => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "fixture",
				model: "fake",
				timestamp: 0,
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
			return stream;
		},
	});
}

describe("native delivery settlement without observer inference", () => {
	it("records direct batch abandonment before any message_start", async () => {
		const a = agent();
		a.subscribe((event) => {
			if (event.type === "turn_start") throw new Error("before batch");
		});
		await a.promptWithDelivery([
			{ message: user(), deliveryId: "a" },
			{ message: user(), deliveryId: "b" },
		]);
		expect(a.getLastRunDeliveryReport()).toMatchObject({
			failed: true,
			abortRequested: false,
			deliveries: [
				{ deliveryId: "a", phase: "discarded-before-start" },
				{ deliveryId: "b", phase: "discarded-before-start" },
			],
		});
	});

	it("distinguishes interrupted from unstarted claimed delivery and preserves pending arrivals", async () => {
		const a = agent();
		a.steeringMode = "all";
		const first = a.enqueueMessage(user(), "steering", "a");
		const second = a.enqueueMessage(user(), "steering", "b");
		a.subscribe((event) => {
			if (event.type === "message_start" && event.deliveryId === "a") {
				a.enqueueMessage(user(), "followUp", "later");
				throw new Error("claimed failure");
			}
		});
		await a.prompt("seed");
		expect(a.getLastRunDeliveryReport()?.deliveries).toEqual([
			{ deliveryId: "a", queueItemId: first.id, phase: "interrupted-after-start" },
			{ deliveryId: "b", queueItemId: second.id, phase: "discarded-before-start" },
		]);
		expect(a.getQueueSnapshot().followUp[0]?.deliveryId).toBe("later");
	});

	it("message-ended remains native transcript evidence even when a persistence listener fails", async () => {
		const a = agent();
		a.subscribe((event) => {
			if (event.type === "message_end" && event.deliveryId === "a") throw new Error("listener");
		});
		await a.promptWithDelivery([
			{ message: user(), deliveryId: "a" },
			{ message: user(), deliveryId: "b" },
		]);
		expect(a.getLastRunDeliveryReport()?.deliveries).toEqual([
			{ deliveryId: "a", phase: "message-ended" },
			{ deliveryId: "b", phase: "discarded-before-start" },
		]);
		expect(a.state.messages.some((item) => item.role === "user")).toBe(true);
	});

	it("retains immutable reports, with separate duplicate-object occurrences and no next-run contamination", async () => {
		const a = agent(),
			message = user();
		await a.promptWithDelivery([
			{ message, deliveryId: "a" },
			{ message, deliveryId: "b" },
		]);
		const old = a.getLastRunDeliveryReport()!;
		expect(old.deliveries.map((item) => item.phase)).toEqual(["message-ended", "message-ended"]);
		expect(Object.isFrozen(old.deliveries[0])).toBe(true);
		await a.prompt("raw");
		expect(a.getLastRunDeliveryReport()!.runId).toBeGreaterThan(old.runId);
		expect(a.getLastRunDeliveryReport()!.deliveries).toEqual([]);
		expect(old.deliveries).toHaveLength(2);
	});

	it("records cleanup even when error reporting itself throws", async () => {
		const a = agent();
		a.subscribe(() => {
			throw new Error("always fails");
		});
		await expect(a.promptWithDelivery([{ message: user(), deliveryId: "a" }])).rejects.toThrow("always fails");
		expect(a.getLastRunDeliveryReport()).toMatchObject({
			failed: true,
			deliveries: [{ deliveryId: "a", phase: "discarded-before-start" }],
		});
		expect(a.state.isStreaming).toBe(false);
	});
});
