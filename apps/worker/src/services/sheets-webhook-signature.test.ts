import { describe, expect, test } from 'vitest';
import {
  deriveSheetsWebhookSecret,
  SHEETS_WEBHOOK_TIMESTAMP_WINDOW_MS,
  verifySheetsWebhookSignature,
} from './sheets-webhook-signature.js';

const SECRET = 'sheets-webhook-test-secret-at-least-32-characters';
const NOW_MS = Date.UTC(2026, 6, 21, 3, 0, 0);

async function hmacHex(rawBody: string, timestamp: string, secret = SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('verifySheetsWebhookSignature', () => {
  test('derives isolated connection keys and never falls back to the deployment master', async () => {
    const connectionA = await deriveSheetsWebhookSecret(SECRET, 'conn-a');
    const connectionB = await deriveSheetsWebhookSecret(SECRET, 'conn-b');

    expect(connectionA).toMatch(/^[0-9a-f]{64}$/);
    expect(connectionB).toMatch(/^[0-9a-f]{64}$/);
    expect(connectionA).not.toBe(connectionB);
    await expect(deriveSheetsWebhookSecret(undefined, 'conn-a')).resolves.toBeNull();
    await expect(deriveSheetsWebhookSecret(SECRET, '')).resolves.toBeNull();

    const timestamp = new Date(NOW_MS).toISOString();
    const rawBody = JSON.stringify({ connectionId: 'conn-a' });
    const signature = await hmacHex(rawBody, timestamp, connectionA!);
    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp,
      signature,
      secret: connectionA,
      nowMs: NOW_MS,
    })).resolves.toBe(true);
    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp,
      signature,
      secret: connectionB,
      nowMs: NOW_MS,
    })).resolves.toBe(false);
  });

  test('accepts HMAC-SHA256 hex over `${timestamp}.${rawBody}` inside the five-minute window', async () => {
    const timestamp = new Date(NOW_MS).toISOString();
    const rawBody = JSON.stringify({ connectionId: 'conn-a', range: 'D2:D2' });
    const signature = await hmacHex(rawBody, timestamp);

    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp,
      signature,
      secret: SECRET,
      nowMs: NOW_MS,
    })).resolves.toBe(true);
  });

  test('requires a timestamp and rejects malformed or replayed requests fail-closed', async () => {
    const timestamp = new Date(NOW_MS).toISOString();
    const rawBody = '{}';
    const signature = await hmacHex(rawBody, timestamp);

    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp: '',
      signature,
      secret: SECRET,
      nowMs: NOW_MS,
    })).resolves.toBe(false);
    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp: 'not-a-date',
      signature,
      secret: SECRET,
      nowMs: NOW_MS,
    })).resolves.toBe(false);

    const expiredTimestamp = new Date(NOW_MS - SHEETS_WEBHOOK_TIMESTAMP_WINDOW_MS - 1).toISOString();
    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp: expiredTimestamp,
      signature: await hmacHex(rawBody, expiredTimestamp),
      secret: SECRET,
      nowMs: NOW_MS,
    })).resolves.toBe(false);
  });

  test('accepts the exact window boundary but rejects body tampering, malformed hex, and missing secret', async () => {
    const boundaryTimestamp = new Date(NOW_MS - SHEETS_WEBHOOK_TIMESTAMP_WINDOW_MS).toISOString();
    const rawBody = JSON.stringify({ connectionId: 'conn-a' });
    const signature = await hmacHex(rawBody, boundaryTimestamp);

    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp: boundaryTimestamp,
      signature,
      secret: SECRET,
      nowMs: NOW_MS,
    })).resolves.toBe(true);
    await expect(verifySheetsWebhookSignature({
      rawBody: `${rawBody} `,
      timestamp: boundaryTimestamp,
      signature,
      secret: SECRET,
      nowMs: NOW_MS,
    })).resolves.toBe(false);
    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp: boundaryTimestamp,
      signature: 'not-hex',
      secret: SECRET,
      nowMs: NOW_MS,
    })).resolves.toBe(false);
    await expect(verifySheetsWebhookSignature({
      rawBody,
      timestamp: boundaryTimestamp,
      signature,
      secret: undefined,
      nowMs: NOW_MS,
    })).resolves.toBe(false);
  });
});
