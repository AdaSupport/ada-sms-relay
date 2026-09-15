import type { Env, VonageInbound } from "../types";

export type SendOutcome =
  | { kind: "sent"; provider_message_id: string }
  | { kind: "rejected"; status: number; detail: string }
  | { kind: "retry"; status: number };

export type InboundText = VonageInbound;

/** Implement these three functions to relay through a different SMS provider. */
export interface SmsProvider {
  /** Send one text. Return `retry` for 429/5xx so Ada re-delivers, `rejected` for anything you should not retry. */
  sendSms(env: Env, to: string, text: string, clientRef: string): Promise<SendOutcome>;
  /** Turn the provider's inbound webhook body into a normalized text, or null if it is not one. */
  parseInbound(raw: Record<string, unknown>): InboundText | null;
  /** Verify the provider's webhook signature. Return ok when the provider has no secret configured. */
  verifyWebhook(env: Env, headers: Headers, rawBody: string): Promise<{ ok: boolean; reason?: string }>;
}
