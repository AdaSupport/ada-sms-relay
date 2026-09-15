#!/usr/bin/env bash
# Creates the Ada side of the relay: an `sms` channel and a webhook endpoint subscribed to
# v1.conversation.message, then stores the endpoint's signing secret as a Worker secret.
# Reads ADA_API_KEY from the environment and never prints it.
#
#   Prompts for ADA_API_KEY if it is not already in the environment.
#   ADA_API_BASE=https://<handle>.ada.support/api/v2 RELAY_URL=https://<worker>.workers.dev ./scripts/setup-ada.sh
set -euo pipefail
if [ -z "${ADA_API_KEY:-}" ]; then
  read -rs -p "Ada API key (input hidden): " ADA_API_KEY < /dev/tty; echo
  export ADA_API_KEY
fi
[ -n "$ADA_API_KEY" ] || { echo "no key entered" >&2; exit 1; }
: "${ADA_API_BASE:?e.g. https://<your-ai-agent-handle>.ada.support/api/v2}"
: "${RELAY_URL:?the deployed Worker URL, no trailing slash}"
CHANNEL_NAME="${CHANNEL_NAME:-Vonage SMS relay}"
ADA_API_BASE="${ADA_API_BASE%/}"; RELAY_URL="${RELAY_URL%/}"

# ada <METHOD> <path> [json-body] -> prints body, exits non-zero on non-2xx with status + body shown
ada() {
  local method="$1" path="$2" body="${3:-}" out status
  local attempt
  for attempt in 1 2 3 4; do
    sleep 1.2   # the Conversations API allows one request per second per resource
    out=$(curl -sS -L -X "$method" "${ADA_API_BASE}${path}" \
          -H "Authorization: Bearer ${ADA_API_KEY}" -H "Content-Type: application/json" -H "Accept: application/json" \
          ${body:+-d "$body"} -w $'\n%{http_code}')
    status="${out##*$'\n'}"
    [[ "$status" == "429" ]] || break
    sleep $((attempt * 2))
  done
  body="${out%$'\n'*}"
  if [[ "$status" != 2* ]]; then
    echo "    ${method} ${path} -> HTTP ${status}" >&2
    echo "    ${body:0:400}" >&2
    return 1
  fi
  printf '%s' "$body"
}
json() { python3 -c 'import json,sys; raw=sys.stdin.read(); d=json.loads(raw) if raw.strip() else {}; print(eval(sys.argv[1], {"d": d}))' "$1"; }

echo "0/4 auth check"
ada GET "/webhooks/event-types/" >/dev/null || { echo "    The API key or base URL is wrong. Fix and rerun." >&2; exit 1; }
echo "    ok"

echo "1/4 SMS channel"
channel_id=$(ada GET "/channels/?type=custom&modality=sms" | json 'next((c["id"] for c in d.get("data", []) if c.get("modality") == "sms"), "")')
if [ -z "$channel_id" ]; then
  channel_id=$(ada POST "/channels/" "{\"name\":\"${CHANNEL_NAME}\",\"description\":\"Relays the voice AI Agent's texts through our own SMS provider\",\"modality\":\"sms\"}" \
    | json 'd.get("data", d).get("id", "")')
  echo "    created channel ${channel_id}"
else
  echo "    reusing existing sms channel ${channel_id} (Ada uses the first sms channel; channels cannot be deleted)"
fi
[ -n "$channel_id" ] || { echo "    no channel id in response" >&2; exit 1; }

echo "2/4 webhook endpoint"
endpoint_id=$(ada GET "/webhooks/" | json "next((w['id'] for w in d.get('data', []) if w.get('url') == '${RELAY_URL}/webhooks/ada'), '')")
if [ -z "$endpoint_id" ]; then
  endpoint_id=$(ada POST "/webhooks/" "{\"url\":\"${RELAY_URL}/webhooks/ada\",\"description\":\"SMS relay\",\"event_filters\":[\"v1.conversation.message\"],\"enabled\":true}" \
    | json 'd.get("data", d).get("id", "")')
  echo "    created endpoint ${endpoint_id}"
else
  echo "    reusing endpoint ${endpoint_id}"
fi
[ -n "$endpoint_id" ] || { echo "    no endpoint id in response" >&2; exit 1; }

echo "3/4 signing secret -> Worker secret ADA_WEBHOOK_SECRET"
ada GET "/webhooks/${endpoint_id}/secret/" \
  | json 'next(v for v in [d.get("key"), d.get("secret"), (d.get("data") or {}).get("key"), (d.get("data") or {}).get("secret")] if v)' \
  | npx wrangler secret put ADA_WEBHOOK_SECRET >/dev/null
echo "    stored"

echo "4/4 manual step"
cat <<MSG
    In the Ada dashboard, open the webhook endpoint and set its Channels field to:
        ${channel_id}
    Without it the endpoint receives every conversation message on every channel.
    Then turn on Config > CHANNELS > Voice > Configuration > "Use your own SMS channel".

    channel_id=${channel_id}
    endpoint_id=${endpoint_id}
MSG
