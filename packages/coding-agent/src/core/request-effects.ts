import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { MessageSubmissionReceipt } from "./message-evidence.ts";
import type { CustomMessage } from "./messages.ts";
import type { EntryId, MessageInvocationResult, RequestId } from "./request-ids.ts";
import type { RequestScopeSnapshot } from "./request-lifetime.ts";

export class ManagedEffectRequiredError extends Error {
	constructor() {
		super(
			"Managed Session effects require an explicit request scope; use ctx.request or a host-issued effects handle",
		);
		this.name = "ManagedEffectRequiredError";
	}
}

export class ManagedEffectUnsupportedError extends Error {
	constructor(operation: string) {
		super(`${operation} is not available through the managed extension/Session interface`);
		this.name = "ManagedEffectUnsupportedError";
	}
}

export interface EntryMutationReceipt {
	readonly entryId: EntryId;
	/** The append already succeeded. This describes subsequent event publication only. */
	readonly publicationError?: string;
}

/** A Session-bound, request-bound effect capability. No independent-scope or ambient-current-request authority. */
export interface RequestEffects {
	readonly scopeId: RequestId;
	readonly signal: AbortSignal;
	assertActive(): void;
	invalidate(): RequestScopeSnapshot;
	createMessageReceipt(): MessageSubmissionReceipt;
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			receipt?: MessageSubmissionReceipt;
		},
	): Promise<MessageInvocationResult>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; receipt?: MessageSubmissionReceipt },
	): Promise<MessageInvocationResult>;
	appendEntry(customType: string, data?: unknown): EntryMutationReceipt;
	setSessionName(name: string): Promise<EntryMutationReceipt>;
	setLabel(entryId: EntryId, label: string | undefined): EntryMutationReceipt;
	setModel(model: Model<Api>): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): void;
	setActiveTools(names: string[]): void;
}
