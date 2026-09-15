import type { Env } from "./types";
import { log } from "./log";

function adaHeaders(env: Env): HeadersInit {
  return { Authorization: `Bearer ${env.ADA_API_KEY}`, "Content-Type": "application/json" };
}

/** Ada's webhook carries no phone number; read it from the end user the event names. */
export async function getEndUserPhone(env: Env, endUserId: string): Promise<{ phone: string | null; status: number }> {
  const cacheKey = `enduser:${endUserId}`;
  const cached = await env.RELAY_KV.get(cacheKey);
  if (cached) return { phone: cached, status: 200 };

  const res = await fetch(`${env.ADA_API_BASE}/end-users/${encodeURIComponent(endUserId)}`, { headers: adaHeaders(env) });
  if (!res.ok) {
    log("ada.end_user.lookup_failed", { end_user_id: endUserId, status: res.status }, "warn");
    return { phone: null, status: res.status };
  }
  const json = (await res.json()) as Record<string, unknown>;
  const root = (json.data as Record<string, unknown> | undefined) ?? json;
  const profile = (root.profile as Record<string, unknown> | undefined) ?? {};
  const metadata = (profile.metadata as Record<string, unknown> | undefined) ?? {};
  const phone = (metadata.phone_number ?? profile.phone_number ?? root.phone_number) as string | undefined;
  if (!phone) return { phone: null, status: 200 };
  await env.RELAY_KV.put(cacheKey, phone, { expirationTtl: 3600 });
  return { phone, status: 200 };
}

export type ReplyOutcome = { kind: "accepted" } | { kind: "rejected"; status: number; detail: string } | { kind: "retry"; status: number };

/** Post the caller's texted reply into the live voice conversation. */
export async function postSmsReply(env: Env, conversationId: string, endUserId: string, text: string): Promise<ReplyOutcome> {
  const res = await fetch(`${env.ADA_API_BASE}/conversations/${encodeURIComponent(conversationId)}/sms/`, {
    method: "POST",
    headers: adaHeaders(env),
    body: JSON.stringify({ author: { role: "end_user", id: endUserId }, content: { type: "text", body: text } }),
  });
  if (res.status === 201) return { kind: "accepted" };
  const detail = await res.text();
  if (res.status === 429 || res.status === 503) return { kind: "retry", status: res.status };
  return { kind: "rejected", status: res.status, detail: detail.slice(0, 500) };
}
