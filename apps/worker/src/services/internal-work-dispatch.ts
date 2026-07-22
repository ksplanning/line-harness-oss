interface InternalWorkProtocol {
  path: string;
  signaturePrefix: string;
  headerPrefix: string;
  label: string;
}

interface DispatchInternalWorkOptions extends InternalWorkProtocol {
  publicUrl?: string;
  secret: string;
  userAgent: string;
}

const SIGNATURE_MAX_AGE_MS = 60_000;

function signaturePayload(
  protocol: InternalWorkProtocol,
  origin: string,
  timestamp: string,
  nonce: string,
): Uint8Array {
  return new TextEncoder().encode([
    protocol.signaturePrefix,
    'POST',
    protocol.path,
    origin,
    timestamp,
    nonce,
  ].join('\n'));
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

async function signature(
  secret: string,
  protocol: InternalWorkProtocol,
  origin: string,
  timestamp: string,
  nonce: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign(
    'HMAC',
    key,
    signaturePayload(protocol, origin, timestamp, nonce),
  ));
}

export async function dispatchInternalWork(options: DispatchInternalWorkOptions): Promise<void> {
  if (!options.publicUrl) throw new Error(`${options.label} worker public URL is not configured`);
  if (!options.secret) throw new Error(`${options.label} worker signature key is not configured`);
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.protocol !== 'https:') throw new Error(`${options.label} worker public URL must use HTTPS`);
  const target = new URL(options.path, publicUrl.origin);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signed = await signature(options.secret, options, target.origin, timestamp, nonce);
  const response = await fetch(target.toString(), {
    method: 'POST',
    headers: {
      'User-Agent': options.userAgent,
      [`${options.headerPrefix}-timestamp`]: timestamp,
      [`${options.headerPrefix}-nonce`]: nonce,
      [`${options.headerPrefix}-signature`]: signed,
    },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`isolated ${options.label} worker returned ${response.status}`);
}

export async function verifyInternalWork(
  request: Request,
  secret: string,
  protocol: InternalWorkProtocol,
): Promise<boolean> {
  if (!secret) return false;
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.pathname !== protocol.path) return false;
  const timestamp = request.headers.get(`${protocol.headerPrefix}-timestamp`) ?? '';
  const nonce = request.headers.get(`${protocol.headerPrefix}-nonce`) ?? '';
  const signed = hexToBytes(request.headers.get(`${protocol.headerPrefix}-signature`) ?? '');
  const timestampMs = Number(timestamp);
  if (
    !Number.isInteger(timestampMs)
    || Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_AGE_MS
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
    || !signed
  ) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    signed,
    signaturePayload(protocol, url.origin, timestamp, nonce),
  );
}
