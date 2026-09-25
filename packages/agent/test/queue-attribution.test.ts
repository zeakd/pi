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

describe("Q2 occurrence targeting and delivery tags", () => {
	it("removes only selected occurrences, including duplicated targets and identical objects", () => {
		const a = agent(),
			message = user();
		const old = a.enqueueMessage(message, "steering", "old");
		const newer = a.enqueueMessage(message, "steering", "new");
		const phone = a.enqueueMessage(message, "followUp", "phone");
		expect(a.removeQueuedMessages([old.id, old.id, 999])).toEqual({ steering: [old], followUp: [] });
		expect(a.getQueueSnapshot().steering).toEqual([newer]);
		expect(a.getQueueSnapshot().followUp).toEqual([phone]);
		expect(a.removeQueuedMessages([old.id])).toEqual({ steering: [], followUp: [] });
		expect(message).toEqual(user());
	});

	it("cannot remove a claimed item, and does not sweep a later enqueue", async () => {
		const a = agent(),
			message = user();
		const old = a.enqueueMessage(message, "steering", "old");
		const ended: (string | undefined)[] = [];
		a.subscribe((event) => {
			if (event.type === "message_start" && event.deliveryId === "old") {
				const newer = a.enqueueMessage(message, "followUp", "new");
				expect(a.removeQueuedMessages([old.id])).toEqual({ steering: [], followUp: [] });
				expect(a.getQueueSnapshot().followUp).toEqual([newer]);
			}
			if (event.type === "message_end" && event.message === message) ended.push(event.deliveryId);
		});
		await a.prompt("seed");
		expect(ended).toEqual(["old", "new"]);
	});

	it("direct duplicate objects have distinct tags; later raw reuse does not inherit either", async () => {
		const a = agent(),
			message = user();
		const started: (string | undefined)[] = [],
			ended: (string | undefined)[] = [];
		a.subscribe((event) => {
			if ((event.type === "message_start" || event.type === "message_end") && event.message === message) {
				if (event.type === "message_start") started.push(event.deliveryId);
				if (event.type === "message_end") ended.push(event.deliveryId);
			}
		});
		await a.promptWithDelivery([
			{ message, deliveryId: "a" },
			{ message, deliveryId: "b" },
		]);
		await a.prompt(message);
		a.steer(message);
		await a.prompt("seed");
		expect(started).toEqual(["a", "b", undefined, undefined]);
		expect(ended).toEqual(started);
		expect(message).toEqual(user());
	});

	it("a failed tagged run releases tags without claiming delivery success", async () => {
		const a = agent(),
			message = user();
		let fail = true;
		const seen: (string | undefined)[] = [];
		a.subscribe((event) => {
			if (event.type === "turn_start" && fail) {
				fail = false;
				throw new Error("barrier failed");
			}
			if (event.type === "message_start" && event.message === message) seen.push(event.deliveryId);
		});
		await a.promptWithDelivery([{ message, deliveryId: "never-delivered" }]);
		await a.prompt(message);
		expect(seen).toEqual([undefined]);
	});
});
