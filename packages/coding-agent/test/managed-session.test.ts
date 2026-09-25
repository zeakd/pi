import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { createManagedSession, type ManagedSession } from "../src/core/managed-session.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { ManagedEffectRequiredError } from "../src/core/request-effects.ts";
import type { DeliveryId } from "../src/core/request-ids.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
async function fixture(extensions: ExtensionFactory[] = []): Promise<ManagedSession> {
	const home = mkdtempSync(join(tmpdir(), "managed-interface-"));
	cleanup.push(() => rmSync(home, { recursive: true, force: true }));
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: home,
		agentDir: home,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: extensions,
	});
	await resourceLoader.reload();
	const { session } = await createManagedSession({
		cwd: home,
		agentDir: home,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(home),
		tools: [],
	});
	cleanup.push(() => session.dispose());
	return session;
}

it("activates before startup contexts and exposes no raw Session or extension runtime", async () => {
	let startup = false;
	let requestPublished = false;
	let ambientError: unknown;
	const session = await fixture([
		(pi) => {
			pi.on("session_start", (_event, ctx) => {
				startup = true;
				requestPublished = ctx.request !== undefined;
				try {
					pi.sendMessage({ customType: "ambient", content: "blocked", display: true });
				} catch (error) {
					ambientError = error;
				}
			});
		},
	]);
	expect(startup).toBe(true);
	expect(requestPublished).toBe(false);
	expect(ambientError).toBeInstanceOf(ManagedEffectRequiredError);
	expect(Object.keys(session).sort()).toEqual(["dispose", "executions", "requests", "subscribe"]);
	expect(Object.isFrozen(session.requests)).toBe(true);
});

it("rejects creation when an extension failed loading instead of publishing a partly configured handle", async () => {
	await expect(
		fixture([
			() => {
				throw new Error("extension bootstrap failed");
			},
		]),
	).rejects.toThrow("Extension loading failed");
});

it("uses one invocation identity through effects and ledger without exposing native queue numbers", async () => {
	const session = await fixture();
	const request = session.requests.create();
	const result = await request.effects.sendMessage(
		{ customType: "aside", content: "payload", display: true },
		{ deliverAs: "nextTurn" },
	);
	const snapshot = request.messages.snapshot();
	expect(result.kind).toBe("returned");
	expect(snapshot.records[0].invocations[0].id).toBe(result.invocationId);
	expect(snapshot.records[0].invocations[0].deliveries[0].disposition).toBe("unresolved");
	expect(snapshot.records[0].invocations[0].deliveries[0]).not.toHaveProperty("queueItemId");
	expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
});

it("rejects the complete mixed ownership selection before mutation", async () => {
	const session = await fixture();
	const a = session.requests.create(),
		b = session.requests.create();
	for (const request of [a, b])
		await request.effects.sendMessage(
			{ customType: "aside", content: "same", display: true },
			{ deliverAs: "nextTurn" },
		);
	const aId = a.messages.snapshot().records[0].invocations[0].deliveries[0].id;
	const bId = b.messages.snapshot().records[0].invocations[0].deliveries[0].id;
	expect(a.messages.remove({ deliveryIds: [aId, bId] })).toEqual({
		kind: "rejected",
		reason: "delivery-not-in-selected-history",
		deliveryIds: [bId],
	});
	expect(a.messages.snapshot().records[0].invocations[0].deliveries[0].removed).toBe(false);
	expect(a.messages.remove({ deliveryIds: [aId, aId] })).toMatchObject({
		kind: "attempted",
		deliveries: [{ id: aId, kind: "removed" }],
	});
	expect(a.messages.remove({ deliveryIds: [aId] })).toMatchObject({
		kind: "attempted",
		deliveries: [{ id: aId, kind: "not-removed" }],
	});
});

it("retains dependent history and returns actionable forget blockers", async () => {
	const session = await fixture();
	const parent = session.requests.create(),
		child = parent.createDependent();
	await child.effects.sendMessage({ customType: "aside", content: "child", display: true }, { deliverAs: "nextTurn" });
	expect(parent.messages.forget({ includeDependents: true })).toEqual({
		kind: "blocked",
		reasons: ["scope-active", "delivery-unresolved"],
	});
	parent.invalidate();
	expect(child.signal.aborted).toBe(true);
	const id = child.messages.snapshot().records[0].invocations[0].deliveries[0].id;
	expect(parent.messages.remove({ deliveryIds: [id] }).kind).toBe("rejected");
	parent.messages.remove({ deliveryIds: [id], includeDependents: true });
	expect(parent.messages.forget({ includeDependents: true })).toEqual({ kind: "forgotten" });
	expect(parent.messages.snapshot({ includeDependents: true }).records.map((record) => record.history)).toEqual([
		"forgotten",
		"forgotten",
	]);
});

it("rejects untyped foreign IDs and leaves an independent Session intact", async () => {
	const a = await fixture(),
		b = await fixture();
	const request = a.requests.create();
	await request.effects.sendMessage({ customType: "aside", content: "own", display: true }, { deliverAs: "nextTurn" });
	const id = request.messages.snapshot().records[0].invocations[0].deliveries[0].id;
	expect(b.requests.create().messages.remove({ deliveryIds: [id] }).kind).toBe("rejected");
	expect(request.messages.remove({ deliveryIds: ["invented" as DeliveryId] }).kind).toBe("rejected");
	expect(request.messages.snapshot().records[0].invocations[0].deliveries[0].removed).toBe(false);
});

it("reports tracking closure without claiming pending messages were removed", async () => {
	const session = await fixture(),
		request = session.requests.create();
	await request.effects.sendMessage({ customType: "aside", content: "own", display: true }, { deliverAs: "nextTurn" });
	expect(session.dispose()).toEqual({ kind: "tracking-closed" });
	expect(request.messages.snapshot().tracking).toBe("session-closed");
	expect(request.messages.snapshot().records[0].invocations[0].deliveries[0].disposition).toBe("unresolved");
	expect(() => session.requests.create()).toThrow("invalidated");
});
