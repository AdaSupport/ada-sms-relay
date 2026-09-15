const enc = new TextEncoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function bytesToB64Url(bytes: ArrayBuffer): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacSha256(key: Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Ada delivers webhooks through Svix. Signed content is `${id}.${timestamp}.${body}`,
 * HMAC-SHA256 with the base64-decoded secret (after the `whsec_` prefix), compared against
 * the `v1,<base64>` entries in the signature header. Headers come in Svix and
 * Standard Webhooks spellings; both are accepted.
 */
export async function verifySvixSignature(
  secret: string,
  headers: Headers,
  body: string,
  toleranceSeconds = 300,
): Promise<{ ok: boolean; reason?: string }> {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const ts = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const sig = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !ts || !sig) return { ok: false, reason: "missing signature headers" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(skew) || skew > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };
  const key = b64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const expected = bytesToB64(await hmacSha256(key, `${id}.${ts}.${body}`));
  const matched = sig.split(" ").some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && value !== undefined && timingSafeEqual(value, expected);
  });
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/**
 * Vonage signs Messages API webhooks with a JWT (HS256, the account's signature secret)
 * in the Authorization header. The payload carries `payload_hash`, the SHA-256 of the raw body.
 */
export async function verifyVonageJwt(
  secret: string,
  headers: Headers,
  body: string,
): Promise<{ ok: boolean; reason?: string }> {
  const auth = headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "missing or malformed bearer token" };
  const [h, p, s] = parts;
  const expected = bytesToB64Url(await hmacSha256(enc.encode(secret), `${h}.${p}`));
  if (!timingSafeEqual(s, expected)) return { ok: false, reason: "jwt signature mismatch" };
  let payload: { payload_hash?: string; exp?: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(b64ToBytes(p)));
  } catch {
    return { ok: false, reason: "jwt payload not json" };
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "jwt expired" };
  if (payload.payload_hash) {
    const hash = await sha256Hex(body);
    if (!timingSafeEqual(hash, payload.payload_hash)) return { ok: false, reason: "payload hash mismatch" };
  }
  return { ok: true };
}
