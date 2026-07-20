import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  GoogleSheetsClient,
  GoogleSheetsError,
  parseGoogleServiceAccountCredentials,
} from './google-sheets';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIXED_NOW = Date.UTC(2026, 6, 20, 3, 4, 5);

let privateKeyPem: string;
let publicKey: CryptoKey;

function toPem(bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString('base64');
  const lines = base64.match(/.{1,64}/g)?.join('\n') ?? base64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  privateKeyPem = toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  publicKey = pair.publicKey;
});

afterEach(() => vi.unstubAllGlobals());

function credentialsJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    client_email: 'sheets-test@example.iam.gserviceaccount.com',
    private_key: privateKeyPem,
    private_key_id: 'key-id-1',
    token_uri: TOKEN_URL,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GoogleSheetsClient — WebCrypto service account JWT', () => {
  test('RS256 JWT を署名し OAuth token endpoint へ交換する', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(TOKEN_URL);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('content-type')).toContain('application/x-www-form-urlencoded');

      const params = new URLSearchParams(String(init?.body));
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const assertion = params.get('assertion');
      expect(assertion).toBeTruthy();
      const [headerPart, claimsPart, signaturePart] = assertion!.split('.');
      expect(decodeJwtPart(headerPart)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'key-id-1' });
      expect(decodeJwtPart(claimsPart)).toEqual({
        iss: 'sheets-test@example.iam.gserviceaccount.com',
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: TOKEN_URL,
        iat: Math.floor(FIXED_NOW / 1000),
        exp: Math.floor(FIXED_NOW / 1000) + 3600,
      });
      expect(await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        publicKey,
        Buffer.from(signaturePart, 'base64url'),
        new TextEncoder().encode(`${headerPart}.${claimsPart}`),
      )).toBe(true);
      return jsonResponse({ access_token: 'ACCESS-1', token_type: 'Bearer', expires_in: 3600 });
    }) as unknown as typeof fetch;

    const client = new GoogleSheetsClient({
      credentials: parseGoogleServiceAccountCredentials(credentialsJson()),
      fetchImpl,
      now: () => FIXED_NOW,
    });

    await expect(client.getAccessToken()).resolves.toBe('ACCESS-1');
    await expect(client.getAccessToken()).resolves.toBe('ACCESS-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('Workers の receiver-sensitive な global fetch を正しい receiver で呼ぶ', async () => {
    let receiver: unknown;
    const workerFetch = vi.fn(function (this: unknown) {
      receiver = this;
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(jsonResponse({ access_token: 'ACCESS-WORKER', expires_in: 3600 }));
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', workerFetch);
    const client = new GoogleSheetsClient({
      credentials: parseGoogleServiceAccountCredentials(credentialsJson()),
      now: () => FIXED_NOW,
    });

    await expect(client.getAccessToken()).resolves.toBe('ACCESS-WORKER');
    expect(receiver).toBe(globalThis);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  test('token fetch 例外の name/message を短い network detail に保持する', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`Network connection lost\n${'x'.repeat(200)}`);
    }) as unknown as typeof fetch;
    const client = new GoogleSheetsClient({
      credentials: parseGoogleServiceAccountCredentials(credentialsJson()),
      fetchImpl,
      now: () => FIXED_NOW,
    });

    const error = await client.getAccessToken().catch((cause: unknown) => cause as GoogleSheetsError);
    expect(error).toMatchObject({
      name: 'GoogleSheetsError',
      operation: 'token',
      status: 0,
      category: 'network',
    });
    expect(error.detail).toBe('TypeError: Network connection lost [redacted]');
    expect(error.detail).not.toContain('\n');
    expect(error.detail?.length).toBeLessThanOrEqual(160);
  });

  test('network detail から URL・メール・token らしい値を除く', async () => {
    const sheetUrl = 'https://sheets.googleapis.com/v4/spreadsheets/private-sheet-id/values/A1';
    const email = 'owner@example.com';
    const bearer = 'secret-access-token';
    const opaque = 's'.repeat(48);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`request to ${sheetUrl} failed for ${email} Bearer ${bearer} id ${opaque}`);
    }) as unknown as typeof fetch;
    const client = new GoogleSheetsClient({
      credentials: parseGoogleServiceAccountCredentials(credentialsJson()),
      fetchImpl,
      now: () => FIXED_NOW,
    });

    const error = await client.getAccessToken().catch((cause: unknown) => cause as GoogleSheetsError);
    expect(error.detail).toContain('TypeError: request to [url] failed for [email] Bearer [redacted] id [redacted]');
    for (const secret of [sheetUrl, email, bearer, opaque]) {
      expect(error.detail).not.toContain(secret);
    }
  });

  test('直接組み立てた credentials でも OAuth 宛先の差し替えを拒否する', () => {
    const credentials = {
      ...parseGoogleServiceAccountCredentials(credentialsJson()),
      tokenUri: 'https://attacker.example/token',
    };
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(() => new GoogleSheetsClient({ credentials, fetchImpl }))
      .toThrowError('Google service account credentials are invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('literal \\n の秘密鍵を正規化し Workers 互換経路で JWT を署名する', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const assertion = new URLSearchParams(String(init?.body)).get('assertion');
      expect(assertion).toBeTruthy();
      const [headerPart, claimsPart, signaturePart] = assertion!.split('.');
      expect(await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        publicKey,
        Buffer.from(signaturePart, 'base64url'),
        new TextEncoder().encode(`${headerPart}.${claimsPart}`),
      )).toBe(true);
      return jsonResponse({ access_token: 'ACCESS-LITERAL-NEWLINES', expires_in: 3600 });
    }) as unknown as typeof fetch;
    const credentials = parseGoogleServiceAccountCredentials(credentialsJson({
      private_key: privateKeyPem.replace(/\n/g, '\\n'),
    }));

    expect(credentials.privateKey).toBe(privateKeyPem.trim());
    await expect(new GoogleSheetsClient({
      credentials,
      fetchImpl,
      now: () => FIXED_NOW,
    }).getAccessToken()).resolves.toBe('ACCESS-LITERAL-NEWLINES');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('不正 PEM は token fetch 前に鍵形式エラーとして拒否する', async () => {
    const sentinel = 'NOT-BASE64!';
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new GoogleSheetsClient({
      credentials: parseGoogleServiceAccountCredentials(credentialsJson({
        private_key: `-----BEGIN PRIVATE KEY-----\n${sentinel}\n-----END PRIVATE KEY-----`,
      })),
      fetchImpl,
      now: () => FIXED_NOW,
    });

    const error = await client.getAccessToken().catch((cause: unknown) => cause as GoogleSheetsError);
    expect(error).toMatchObject({
      name: 'GoogleSheetsError',
      operation: 'token',
      status: 0,
      category: 'key_format',
    });
    expect(error.message).not.toContain(sentinel);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('不正な secret JSON は値を露出せず拒否する', () => {
    const sentinel = 'DO-NOT-ECHO-PRIVATE-KEY';
    expect(() => parseGoogleServiceAccountCredentials(JSON.stringify({ private_key: sentinel })))
      .toThrowError('Google service account credentials are invalid');
    try {
      parseGoogleServiceAccountCredentials(JSON.stringify({ private_key: sentinel }));
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });
});

describe('GoogleSheetsClient — Sheets API v4 contracts', () => {
  test('batch update preserves unrelated columns by sending only named ranges', async () => {
    const apiCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input) === TOKEN_URL) {
        return jsonResponse({ access_token: 'ACCESS-BATCH', expires_in: 3600 });
      }
      apiCalls.push({ url: String(input), init });
      return jsonResponse({ spreadsheetId: 'sheet/id', totalUpdatedRows: 2 });
    }) as unknown as typeof fetch;
    const client = new GoogleSheetsClient({
      credentials: parseGoogleServiceAccountCredentials(credentialsJson()),
      fetchImpl,
      now: () => FIXED_NOW,
    });

    await client.batchUpdateValues('sheet/id', [
      { range: "'友だち台帳'!B2", values: [['済']] },
      { range: "'友だち台帳'!E2", values: [['あやこ']] },
    ]);

    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet%2Fid/values:batchUpdate',
    );
    expect(apiCalls[0].init.method).toBe('POST');
    expect(JSON.parse(String(apiCalls[0].init.body))).toEqual({
      valueInputOption: 'RAW',
      data: [
        { range: "'友だち台帳'!B2", majorDimension: 'ROWS', values: [['済']] },
        { range: "'友だち台帳'!E2", majorDimension: 'ROWS', values: [['あやこ']] },
      ],
    });
  });

  test('append/read/update が正しい URL・method・Bearer・ValueRange を送る', async () => {
    const apiCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return jsonResponse({ access_token: 'ACCESS-2', token_type: 'Bearer', expires_in: 3600 });
      }
      apiCalls.push({ url, init });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (init.method === 'GET') return jsonResponse({ range: '回答!A1:B1', majorDimension: 'ROWS', values: [['name', 'email']] });
      if (init.method === 'POST') return jsonResponse({ spreadsheetId: 'sheet/id', tableRange: '回答!A1:B1', updates: { updatedRows: 1 } });
      return jsonResponse({ spreadsheetId: 'sheet/id', updatedRange: '回答!A2:B2', updatedRows: 1 });
    }) as unknown as typeof fetch;
    const client = new GoogleSheetsClient({
      credentials: parseGoogleServiceAccountCredentials(credentialsJson()),
      fetchImpl,
      now: () => FIXED_NOW,
    });

    await client.appendValues('sheet/id', '回答!A:B', [['山田', 'owner@example.com']]);
    await client.readValues('sheet/id', '回答!A1:B1');
    await client.updateValues('sheet/id', '回答!A2:B2', [['佐藤', 'staff@example.com']]);

    expect(apiCalls).toHaveLength(3);
    expect(apiCalls.map((call) => call.init.method)).toEqual(['POST', 'GET', 'PUT']);
    for (const call of apiCalls) {
      expect(new URL(call.url).origin).toBe('https://sheets.googleapis.com');
      expect(call.init.redirect).toBe('manual');
      expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer ACCESS-2');
    }
    expect(apiCalls[0].url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet%2Fid/values/%E5%9B%9E%E7%AD%94%21A%3AB:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    );
    expect(JSON.parse(String(apiCalls[0].init.body))).toEqual({ majorDimension: 'ROWS', values: [['山田', 'owner@example.com']] });
    expect(apiCalls[1].url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet%2Fid/values/%E5%9B%9E%E7%AD%94%21A1%3AB1?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE',
    );
    expect(apiCalls[1].init.body).toBeUndefined();
    expect(apiCalls[2].url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet%2Fid/values/%E5%9B%9E%E7%AD%94%21A2%3AB2?valueInputOption=RAW',
    );
    expect(JSON.parse(String(apiCalls[2].init.body))).toEqual({ majorDimension: 'ROWS', values: [['佐藤', 'staff@example.com']] });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('Google の error body や credential を例外へ含めない', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input) === TOKEN_URL) return jsonResponse({ access_token: 'ACCESS-3', expires_in: 3600 });
      return jsonResponse({ error: { message: 'SENTINEL_GOOGLE_RESPONSE' } }, 403);
    }) as typeof fetch;
    const client = new GoogleSheetsClient({
      credentials: parseGoogleServiceAccountCredentials(credentialsJson()),
      fetchImpl,
      now: () => FIXED_NOW,
    });

    const error = await client.readValues('private-sheet', '秘密!A1').catch((cause: unknown) => cause as GoogleSheetsError);
    expect(error).toMatchObject({
      name: 'GoogleSheetsError',
      status: 403,
      operation: 'read',
    });
    expect(error.message).not.toContain('SENTINEL_GOOGLE_RESPONSE');
  });
});
