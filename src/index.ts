import { Hono } from "hono";
import type { AdaConversationMessageEvent, Env, LiveConversation, VonageStatus } from "./types";
import { verifySvixSignature } from "./crypto";
import { getEndUserPhone, postSmsReply } from "./ada";
import { vonage as provider } from "./providers/vonage";
import { digitsOnly, log } from "./log";

const OPT_OUT_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "ARRET"]);
const OPT_IN_WORDS = new Set(["START", "UNSTOP", "YES"]);

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ service: "ada-sms-relay", ok: true }));
app.get("/health", (c) => c.json({ ok: true }));

function renderText(content: AdaConversationMessageEvent["data"]["content"]): string {
  switch (content.type) {
    case "text":
      return content.body;
    case "link":
      return content.link_text ? `${content.link_text} ${content.url}` : content.url;
    case "file":
      return `${content.filename}: ${content.url}`;
    default:
      return "";
  }
}

/** Ada → relay: a text the AI Agent wants delivered to the caller. */
app.post("/webhooks/ada", async (c) => {
  const env = c.env;
  const body = await c.req.text();

  if (env.ADA_WEBHOOK_SECRET) {
    const check = await verifySvixSignature(env.ADA_WEBHOOK_SECRET, c.req.raw.headers, body);
    if (!check.ok) {
      log("ada.webhook.rejected", { reason: check.reason }, "warn");
      return c.json({ error: "invalid signature" }, 401);
    }
  } else {
    log("ada.webhook.unverified", { hint: "set ADA_WEBHOOK_SECRET" }, "warn");
  }

  let event: AdaConversationMessageEvent;
  try {
    event = JSON.parse(body) as AdaConversationMessageEvent;
  } catch {
    return c.json({ error: "body is not json" }, 400);
  }

  if (event.type !== "v1.conversation.message") return c.json({ ignored: "event type" });
  const { data } = event;
  if (data.channel?.modality !== "sms") return c.json({ ignored: "not an sms channel message" });
  if (data.author?.role !== "ai_agent") return c.json({ ignored: `author role ${data.author?.role}` });

  const dedupeKey = `dedupe:ada:${data.message_id}`;
  if (await env.RELAY_KV.get(dedupeKey)) {
    log("ada.message.duplicate", { message_id: data.message_id });
    return c.json({ ignored: "duplicate" });
  }

  const { phone, status } = await getEndUserPhone(env, data.end_user_id);
  if (!phone) {
    if (status >= 500 || status === 429) return c.json({ error: "end user lookup unavailable" }, 503);
    log("ada.message.no_phone", { message_id: data.message_id, end_user_id: data.end_user_id, status }, "error");
    return c.json({ dropped: "end user has no phone number" });
  }
  const to = digitsOnly(phone);

  if (await env.RELAY_KV.get(`optout:${to}`)) {
    log("ada.message.suppressed_opt_out", { message_id: data.message_id, to_suffix: to.slice(-4) });
    await env.RELAY_KV.put(dedupeKey, "1", { expirationTtl: 86400 });
    return c.json({ dropped: "recipient opted out" });
  }

  const text = renderText(data.content);
  if (!text) return c.json({ dropped: "empty content" });

  const outcome = await provider.sendSms(env, to, text, data.message_id);
  if (outcome.kind === "retry") {
    log("provider.send.retry_later", { message_id: data.message_id, status: outcome.status }, "warn");
    return c.json({ error: "provider unavailable" }, 503);
  }
  await env.RELAY_KV.put(dedupeKey, "1", { expirationTtl: 86400 });
  if (outcome.kind === "rejected") {
    log("provider.send.rejected", { message_id: data.message_id, status: outcome.status, detail: outcome.detail }, "error");
    return c.json({ dropped: "provider rejected the message", status: outcome.status });
  }

  const live: LiveConversation = {
    conversation_id: data.conversation_id,
    end_user_id: data.end_user_id,
    channel_id: data.channel.id,
    last_ada_message_id: data.message_id,
    updated_at: new Date().toISOString(),
  };
  const ttl = Number(env.CONVERSATION_TTL_SECONDS) || 3600;
  await env.RELAY_KV.put(`live:${to}`, JSON.stringify(live), { expirationTtl: ttl });
  await env.RELAY_KV.put(`provider:${outcome.provider_message_id}`, data.message_id, { expirationTtl: 86400 });

  log("provider.send.accepted", {
    message_id: data.message_id,
    conversation_id: data.conversation_id,
    provider_message_id: outcome.provider_message_id,
    to_suffix: to.slice(-4),
    chars: text.length,
  });
  return c.json({ relayed: true, provider_message_id: outcome.provider_message_id });
});

async function readVonageBody(c: { req: { text(): Promise<string>; header(name: string): string | undefined } }): Promise<{ raw: string; json: Record<string, unknown> }> {
  const raw = await c.req.text();
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return { raw, json: Object.fromEntries(new URLSearchParams(raw)) };
  }
  try {
    return { raw, json: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { raw, json: {} };
  }
}


/**
 * Ada only accepts texted replies while the call is live. When the caller texts after the call
 * (or with no call at all) there is no conversation to post into, so the relay answers with a
 * static message if ENDED_REPLY_TEXT is set, at most once per number per hour.
 */
async function sendEndedReply(env: Env, to: string, reason: string): Promise<void> {
  const text = env.ENDED_REPLY_TEXT?.trim();
  if (!text) return;
  const throttleKey = `endedreply:${to}`;
  if (await env.RELAY_KV.get(throttleKey)) return;
  await env.RELAY_KV.put(throttleKey, "1", { expirationTtl: 3600 });
  const outcome = await provider.sendSms(env, to, text, `ended-${Date.now()}`);
  log("provider.ended_reply", { to_suffix: to.slice(-4), reason, outcome: outcome.kind }, outcome.kind === "sent" ? "info" : "warn");
}

/** Provider → relay: the caller texted back. Post it into the live call. */
app.post("/webhooks/vonage/inbound", async (c) => {
  const env = c.env;
  const { raw, json } = await readVonageBody(c);

  const check = await provider.verifyWebhook(env, c.req.raw.headers, raw);
  if (!check.ok) {
    log("vonage.inbound.rejected", { reason: check.reason }, "warn");
    return c.json({ error: "invalid signature" }, 401);
  }

  const inbound = provider.parseInbound(json);
  if (!inbound) return c.json({ error: "unrecognised payload" }, 400);

  const dedupeKey = `dedupe:vonage:${inbound.message_uuid}`;
  if (await env.RELAY_KV.get(dedupeKey)) return c.json({ ignored: "duplicate" });
  await env.RELAY_KV.put(dedupeKey, "1", { expirationTtl: 86400 });

  const from = digitsOnly(inbound.from);
  const text = (inbound.text ?? "").trim();
  const keyword = text.toUpperCase().replace(/[^A-Z]/g, "");

  if (OPT_OUT_WORDS.has(keyword)) {
    await env.RELAY_KV.put(`optout:${from}`, new Date().toISOString());
    log("vonage.inbound.opt_out", { from_suffix: from.slice(-4) });
    return c.json({ handled: "opt-out recorded, not forwarded" });
  }
  if (OPT_IN_WORDS.has(keyword) && (await env.RELAY_KV.get(`optout:${from}`))) {
    await env.RELAY_KV.delete(`optout:${from}`);
    log("vonage.inbound.opt_in", { from_suffix: from.slice(-4) });
    return c.json({ handled: "opt-in recorded" });
  }
  if (!text) return c.json({ ignored: "empty text" });

  const liveRaw = await env.RELAY_KV.get(`live:${from}`);
  if (!liveRaw) {
    log("vonage.inbound.no_live_call", { from_suffix: from.slice(-4) }, "warn");
    await sendEndedReply(env, from, "no live conversation");
    return c.json({ ignored: "no live conversation for this number" });
  }
  const live = JSON.parse(liveRaw) as LiveConversation;

  const outcome = await postSmsReply(env, live.conversation_id, live.end_user_id, text);
  if (outcome.kind === "retry") {
    log("ada.reply.retry_later", { conversation_id: live.conversation_id, status: outcome.status }, "warn");
    return c.json({ error: "ada unavailable" }, 503);
  }
  if (outcome.kind === "rejected") {
    log("ada.reply.rejected", { conversation_id: live.conversation_id, status: outcome.status, detail: outcome.detail }, "warn");
    if (outcome.status === 422) {
      await env.RELAY_KV.delete(`live:${from}`);
      await sendEndedReply(env, from, "ada 422");
    }
    return c.json({ dropped: "ada rejected the reply", status: outcome.status });
  }
  log("ada.reply.accepted", { conversation_id: live.conversation_id, chars: text.length });
  return c.json({ relayed: true });
});

/** Provider → relay: delivery receipts. Ada has no delivery signal of its own, so this is where it lives. */
app.post("/webhooks/vonage/status", async (c) => {
  const env = c.env;
  const { raw, json } = await readVonageBody(c);
  const check = await provider.verifyWebhook(env, c.req.raw.headers, raw);
  if (!check.ok) return c.json({ error: "invalid signature" }, 401);
  const status = json as unknown as VonageStatus;
  if (!status.message_uuid) return c.json({ ignored: "no message_uuid" });
  const adaMessageId = await env.RELAY_KV.get(`provider:${status.message_uuid}`);
  await env.RELAY_KV.put(`status:${status.message_uuid}`, JSON.stringify({ status: status.status, at: status.timestamp, error: status.error ?? null }), { expirationTtl: 86400 });
  log("provider.status", { provider_message_id: status.message_uuid, ada_message_id: adaMessageId, status: status.status, error: status.error ?? null }, status.status === "rejected" || status.status === "undeliverable" ? "error" : "info");
  return c.json({ ok: true });
});

export default app;
