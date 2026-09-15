# ada-sms-relay

**A reference relay that lets an Ada voice AI Agent send and receive texts through your own SMS provider.** This copy talks to Vonage and runs on Cloudflare Workers. Swap `src/providers/vonage.ts` for another provider; run it anywhere Hono runs (Workers, Node, Deno, Bun).

Ada publishes each text the AI Agent wants to send as a `v1.conversation.message` webhook. The relay looks up the caller's number, sends the text through your provider, and remembers which live call the number belongs to. When the caller texts back, the provider calls the relay, which posts the reply into the live call so the AI Agent can answer by voice.

```
caller ──voice──▶ Ada AI Agent ──webhook /webhooks/ada──▶ relay ──Messages API──▶ Vonage ──SMS──▶ caller
caller ──SMS──▶ Vonage ──/webhooks/vonage/inbound──▶ relay ──POST /conversations/{id}/sms/──▶ Ada ──voice──▶ caller
```

---

## What you need

- An Ada AI Agent with **Allow AI Agent to send and receive SMS** on (Config > CHANNELS > Voice > Configuration), and a Platform API key.
- A Vonage account with a number that can send and receive SMS, and an Application with the Messages capability.
- A Cloudflare account and `npx wrangler login`.

## Setup

1. **Deploy the relay.**
   ```bash
   npm install
   npx wrangler kv namespace create RELAY_KV   # paste the id into wrangler.toml
   npx wrangler deploy                          # note the https://….workers.dev URL
   ```
   Set `ADA_API_BASE` in `wrangler.toml` to your AI Agent's handle.

2. **Point Vonage at the relay.** In the Vonage Application, Messages capability:
   - Inbound URL: `https://<worker>/webhooks/vonage/inbound`
   - Status URL: `https://<worker>/webhooks/vonage/status`
   Link your number to the Application. In Settings, set the default SMS setting to **Messages API**.

3. **Store secrets** (each command prompts; nothing is written to disk):
   ```bash
   npx wrangler secret put VONAGE_API_KEY
   npx wrangler secret put VONAGE_API_SECRET
   npx wrangler secret put VONAGE_FROM_NUMBER        # digits only, e.g. 12045550123
   npx wrangler secret put VONAGE_SIGNATURE_SECRET   # optional, verifies Vonage webhooks
   npx wrangler secret put ADA_API_KEY
   ```

4. **Create the Ada side.** This creates the `sms` channel, the webhook endpoint, and stores the endpoint's signing secret:
   ```bash
   ADA_API_KEY=… ADA_API_BASE=https://<handle>.ada.support/api/v2 RELAY_URL=https://<worker> ./scripts/setup-ada.sh
   ```

5. **Scope the endpoint.** In the Ada dashboard, set the webhook endpoint's **Channels** field to the channel id the script printed. An unscoped endpoint receives every conversation message on every channel. A wrongly scoped one silently receives nothing.

6. **Turn it on.** Config > CHANNELS > Voice > Configuration > **Use your own SMS channel**. Turning it off returns texts to Ada's Twilio.

## Test

Call the AI Agent and trigger a Speech + SMS capture, or ask it to text you the steps. Watch `npx wrangler tail`. You should see `provider.send.accepted`, the text on your phone, then `ada.reply.accepted` when you text back and the AI Agent answers by voice.

## What the relay handles for you

| Concern | How |
|---|---|
| Duplicate webhooks | Ada retries unacknowledged events; the relay dedupes on `message_id` for 24h |
| Which call a reply belongs to | The caller's number maps to the live conversation for `CONVERSATION_TTL_SECONDS` |
| STOP / START | Recorded in KV, never forwarded to Ada, future sends suppressed |
| Texts after the call ended | Ada returns 422; the relay sends `ENDED_REPLY_TEXT` once per number per hour, or nothing if unset |
| Delivery receipts | Vonage status webhooks are logged with the Ada `message_id`. Ada itself has no delivery signal |
| Signatures | Ada (Svix) and Vonage (JWT) webhooks are verified when the secrets are set |
| Retries | Provider or Ada 429/5xx return 503 so the sender retries; 4xx are logged and dropped |

## What Ada expects of you

- Return 2xx within 15 seconds. The relay does the provider call inline, so keep the provider fast.
- Post replies immediately. The caller is on a live call and the AI Agent moves on after the configured silence limit.
- Never post STOP as a reply. Handle opt-out yourself.
- Ada sends each text as one body. Your provider handles segmentation. Ada does not track delivery.

## Using another provider

Implement the three functions in `src/providers/types.ts` (`sendSms`, `parseInbound`, `verifyWebhook`) for your provider and point the import in `src/index.ts` at it. `src/providers/vonage.ts` is the worked example. Everything else in the relay is provider-agnostic.

## Support

This is a reference implementation, not a supported Ada product. Open an issue for bugs in the sample. For the Ada APIs it calls, see the docs below.

Docs: [Relaying voice texts through your own SMS provider](https://docs.ada.cx/reference/conversations/developer-guides/relaying-voice-texts-through-your-own-sms-provider).
