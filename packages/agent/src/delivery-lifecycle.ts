export interface NativeDeliveryOutcome {
	readonly deliveryId: string;
	readonly queueItemId?: number;
	readonly phase: "message-ended" | "discarded-before-start" | "interrupted-after-start";
}

export interface NativeRunDeliveryReport {
	/** Agent-local run identity, not a Session execution or application request ID. */
	readonly runId: number;
	readonly failed: boolean;
	readonly abortRequested: boolean;
	readonly deliveries: readonly NativeDeliveryOutcome[];
}

type DeliveryInput = { deliveryId?: string; id?: number };
type ActiveDelivery = { deliveryId: string; queueItemId?: number; phase: "claimed" | "started" | "message-ended" };

/** Internal ownership bookkeeping. No user callbacks, message contents, or persistence inference. */
export class DeliveryLifecycle {
	private sequence = 0;
	private active?: Map<string, ActiveDelivery>;
	private report?: NativeRunDeliveryReport;

	start(items: readonly DeliveryInput[]): void {
		this.sequence++;
		this.active = new Map();
		this.claim(items);
	}

	claim(items: readonly DeliveryInput[]): void {
		if (!this.active) return;
		for (const item of items) {
			if (!item.deliveryId) continue;
			this.active.set(item.deliveryId, {
				deliveryId: item.deliveryId,
				...(item.id === undefined ? {} : { queueItemId: item.id }),
				phase: "claimed",
			});
		}
	}

	started(id: string | undefined): void {
		const item = id ? this.active?.get(id) : undefined;
		if (item) item.phase = "started";
	}

	ended(id: string | undefined): void {
		const item = id ? this.active?.get(id) : undefined;
		if (item) item.phase = "message-ended";
	}

	settle(failed: boolean, abortRequested: boolean): void {
		this.report = Object.freeze({
			runId: this.sequence,
			failed,
			abortRequested,
			deliveries: Object.freeze(
				[...(this.active?.values() ?? [])].map(
					(item): NativeDeliveryOutcome =>
						Object.freeze({
							...item,
							phase:
								item.phase === "claimed"
									? "discarded-before-start"
									: item.phase === "started"
										? "interrupted-after-start"
										: "message-ended",
						}),
				),
			),
		});
		this.active = undefined;
	}

	lastReport(): NativeRunDeliveryReport | undefined {
		return this.report;
	}
}
