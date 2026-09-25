import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentMessage } from "../src/types.ts";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
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
}
function agent() {
	return new Agent({
		initialState: {
			model: {
				id: "fake",
				name: "fake",
				api: "openai-responses",
				provider: "fixture",
				baseUrl: "http://invalid",
				reasoning: false,
				input: ["text"],
				contextWindow: 10000,
				maxTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		},
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: assistant() });
			stream.end();
			return stream;
		},
	});
}
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });

describe("native queue evidence", () => {
	it("identifies enqueue occurrences, including the same object, and returns exact removals", () => {
		const a = agent(),
			message = user("same");
		a.steer(message);
		a.followUp(message);
		a.followUp(message);
		const snapshot = a.getQueueSnapshot();
		const ids = [...snapshot.steering, ...snapshot.followUp].map((item) => item.id);
		expect(new Set(ids).size).toBe(3);
		expect(snapshot.followUp[0]?.message).toBe(snapshot.followUp[1]?.message);
		expect(a.clearQueuedMessages()).toEqual({ steering: snapshot.steering, followUp: snapshot.followUp });
		expect(a.getQueueSnapshot()).toEqual({ steering: [], followUp: [], claimed: [] });
		expect(snapshot.followUp).toHaveLength(2);
		expect(a.clearQueuedMessages()).toEqual({ steering: [], followUp: [] });
		a.reset();
		a.steer(message);
		expect(a.getQueueSnapshot().steering[0]?.id).toBeGreaterThan(Math.max(...ids));
		expect(message).toEqual(user("same"));
	});

	for (const mode of ["steer", "followUp"] as const) {
		for (const batch of ["all", "one-at-a-time"] as const) {
			it(`${mode}/${batch}: separates claimed items from removable items and links repeated objects`, async () => {
				const a = agent(),
					message = user("same");
				a.steeringMode = batch;
				a.followUpMode = batch;
				a[mode](message);
				a[mode](message);
				const queued = mode === "steer" ? a.getQueueSnapshot().steering : a.getQueueSnapshot().followUp;
				const starts: number[] = [],
					ends: number[] = [];
				a.subscribe((event) => {
					if (event.type === "message_start" && event.message === message) {
						starts.push(event.queueItemId!);
						if (starts.length === 1) {
							expect(
								a
									.getQueueSnapshot()
									.claimed.every((item) => item.queue === (mode === "steer" ? "steering" : "followUp")),
							).toBe(true);
							expect(a.getQueueSnapshot().claimed.map((item) => item.id)).toEqual(
								queued.slice(0, batch === "all" ? 2 : 1).map((item) => item.id),
							);
							const removed = a.clearQueuedMessages();
							expect([...removed.steering, ...removed.followUp].map((item) => item.id)).toEqual(
								batch === "all" ? [] : [queued[1]!.id],
							);
						}
					}
					if (event.type === "message_end" && event.message === message) ends.push(event.queueItemId!);
				});
				await a.prompt("seed");
				expect(starts).toEqual(queued.slice(0, batch === "all" ? 2 : 1).map((item) => item.id));
				expect(ends).toEqual(starts);
				expect(a.getQueueSnapshot()).toEqual({ steering: [], followUp: [], claimed: [] });
				expect(message).toEqual(user("same"));
			});
		}
	}

	it("links the same object across mixed queue modes in actual consumption order", async () => {
		const a = agent(),
			message = user("same");
		a.steeringMode = "all";
		a.followUpMode = "all";
		a.followUp(message);
		a.steer(message);
		a.followUp(message);
		const snapshot = a.getQueueSnapshot();
		const expected = [...snapshot.steering, ...snapshot.followUp].map((item) => item.id);
		const starts: number[] = [],
			ends: number[] = [];
		a.subscribe((event) => {
			if (event.type === "message_start" && event.message === message) starts.push(event.queueItemId!);
			if (event.type === "message_end" && event.message === message) ends.push(event.queueItemId!);
		});
		await a.prompt("seed");
		expect(starts).toEqual(expected);
		expect(ends).toEqual(expected);
	});

	it("synchronous observer enqueue and clear cannot recall the currently claimed occurrence", async () => {
		const a = agent(),
			message = user("same");
		a.steer(message);
		const claimedId = a.getQueueSnapshot().steering[0]!.id;
		const ended: number[] = [];
		a.subscribe((event) => {
			if (event.type === "message_start" && event.queueItemId === claimedId) {
				a.followUp(message);
				const pendingId = a.getQueueSnapshot().followUp[0]!.id;
				expect(a.clearQueuedMessages().followUp.map((item) => item.id)).toEqual([pendingId]);
				expect(a.getQueueSnapshot().claimed.map((item) => item.id)).toEqual([claimedId]);
			}
			if (event.type === "message_end" && event.queueItemId !== undefined) ended.push(event.queueItemId);
		});
		await a.prompt("seed");
		expect(ended).toEqual([claimedId]);
	});

	it("tracks claimed occurrences selected by continue, with no ID reuse on reset", async () => {
		const a = agent(),
			message = user("next");
		a.state.messages = [assistant()];
		a.followUp(message);
		const id = a.getQueueSnapshot().followUp[0]!.id;
		const starts: number[] = [];
		a.subscribe((event) => {
			if (event.type === "message_start" && event.message === message) starts.push(event.queueItemId!);
		});
		await a.continue();
		expect(starts).toEqual([id]);
		a.reset();
		a.followUp(message);
		expect(a.getQueueSnapshot().followUp[0]!.id).toBeGreaterThan(id);
	});

	it("retains claim evidence at failed agent_end but releases it at settlement", async () => {
		const a = agent();
		a.followUp(user("not started"));
		a.state.messages = [assistant()];
		const id = a.getQueueSnapshot().followUp[0]!.id;
		let failed = false;
		const atEnd: number[] = [];
		a.subscribe((event) => {
			if (event.type === "turn_start" && !failed) {
				failed = true;
				throw new Error("fixture failure");
			}
			if (event.type === "agent_end") atEnd.push(...a.getQueueSnapshot().claimed.map((item) => item.id));
		});
		await a.continue();
		expect(atEnd).toEqual([id]);
		expect(a.getQueueSnapshot().claimed).toEqual([]);
		expect(a.state.messages.some((message) => message.role === "user")).toBe(false);
	});
});
