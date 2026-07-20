export const SHEETS_WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60_000;
const SHEETS_WEBHOOK_KEY_DOMAIN = 'friend-ledger-webhook:v2\0';

export interface VerifySheetsWebhookSignatureOptions {
  rawBody: string;
  timestamp: string;
  signature: string;
  secret: string | undefined | null;
  nowMs?: number;
  windowMs?: number;
}

function decodeHex(value: string): Uint8Array | null {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) return null;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveSheetsWebhookSecret(
  masterSecret: string | undefined | null,
  connectionId: string,
): Promise<string | null> {
  if (!masterSecret || !/^[A-Za-z0-9_-]{1,200}$/.test(connectionId)) return null;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(masterSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const derived = new Uint8Array(await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${SHEETS_WEBHOOK_KEY_DOMAIN}${connectionId}`),
    ));
    return encodeHex(derived);
  } catch {
    return null;
  }
}

export async function verifySheetsWebhookSignature(
  options: VerifySheetsWebhookSignatureOptions,
): Promise<boolean> {
  if (!options.secret || !options.timestamp || !options.signature) return false;
  const timestampMs = Date.parse(options.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const nowMs = options.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > (options.windowMs ?? SHEETS_WEBHOOK_TIMESTAMP_WINDOW_MS)) {
    return false;
  }
  const provided = decodeHex(options.signature);
  if (!provided) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(options.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const computed = new Uint8Array(await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${options.timestamp}.${options.rawBody}`),
    ));
    if (computed.length !== provided.length) return false;
    let difference = 0;
    for (let index = 0; index < computed.length; index += 1) {
      difference |= computed[index] ^ provided[index];
    }
    return difference === 0;
  } catch {
    return false;
  }
}
