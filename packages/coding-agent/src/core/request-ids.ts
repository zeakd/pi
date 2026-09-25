/** Identifier kinds only. Runtime ownership checks remain necessary; casts are not authority. */
declare const identityKind: unique symbol;
type Id<Kind extends string> = string & { readonly [identityKind]: Kind };
export type RequestId = Id<"request">;
export type InvocationId = Id<"invocation">;
export type DeliveryId = Id<"delivery">;
export type ExecutionId = Id<"execution">;
export type EntryId = Id<"entry">;

/** The producer call returned. This does NOT assert delivery completion or persistence. */
export interface MessageInvocationResult {
	readonly kind: "returned";
	readonly invocationId: InvocationId;
}
