import type { Env, VonageInbound } from "../types";
import { verifyVonageJwt } from "../crypto";
import type { SendOutcome, SmsProvider } from "./types";

/**
 * Vonage Messages API. Swap this file to relay through another provider: the rest of the
 * relay only needs `sendSms` and `parseInbound`.
 */
async function sendSms(env: Env, to: string, text: string, clientRef: string): Promise<SendOutcome> {
  const auth = btoa(`${env.VONAGE_API_KEY}:${env.VONAGE_API_SECRET}`);
  const res = await fetch(`${env.VONAGE_API_BASE}/v1/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message_type: "text", channel: "sms", to, from: env.VONAGE_FROM_NUMBER, text, client_ref: clientRef.slice(0, 100) }),
  });
  if (res.status === 202) {
    const json = (await res.json()) as { message_uuid: string };
    return { kind: "sent", provider_message_id: json.message_uuid };
  }
  const detail = (await res.text()).slice(0, 500);
  if (res.status === 429 || res.status >= 500) return { kind: "retry", status: res.status };
  return { kind: "rejected", status: res.status, detail };
}

/** Accepts Messages API JSON and, as a fallback, the legacy SMS API shape (`msisdn`, `messageId`). */
function parseInbound(raw: Record<string, unknown>): VonageInbound | null {
  if (typeof raw.from === "string" && typeof raw.message_uuid === "string") {
    return {
      from: raw.from,
      to: String(raw.to ?? ""),
      channel: String(raw.channel ?? "sms"),
      message_uuid: raw.message_uuid,
      timestamp: String(raw.timestamp ?? ""),
      message_type: String(raw.message_type ?? "text"),
      text: typeof raw.text === "string" ? raw.text : undefined,
    };
  }
  if (typeof raw.msisdn === "string") {
    return {
      from: raw.msisdn,
      to: String(raw.to ?? ""),
      channel: "sms",
      message_uuid: String(raw.messageId ?? crypto.randomUUID()),
      timestamp: String(raw["message-timestamp"] ?? ""),
      message_type: "text",
      text: typeof raw.text === "string" ? raw.text : undefined,
    };
  }
  return null;
}

async function verifyWebhook(env: Env, headers: Headers, rawBody: string): Promise<{ ok: boolean; reason?: string }> {
  if (!env.VONAGE_SIGNATURE_SECRET) return { ok: true };
  return verifyVonageJwt(env.VONAGE_SIGNATURE_SECRET, headers, rawBody);
}

export const vonage: SmsProvider = { sendSms, parseInbound, verifyWebhook };
