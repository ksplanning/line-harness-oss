/**
 * Minimal Google Sheets API v4 client for Cloudflare Workers.
 *
 * Service-account credentials are supplied by a Worker secret. The private key
 * is imported with WebCrypto and is never persisted or written to logs.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GOOGLE_SHEETS_API = 'https://sheets.googleapis.com/v4';
const JWT_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  tokenUri: string;
}

export type SheetCellValue = string | number | boolean | null;

export interface SheetsValueRange {
  range?: string;
  majorDimension?: 'ROWS' | 'COLUMNS';
  values?: SheetCellValue[][];
}

export interface AppendValuesResponse {
  spreadsheetId: string;
  tableRange?: string;
  updates?: Record<string, unknown>;
}

export interface UpdateValuesResponse {
  spreadsheetId: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

export type GoogleSheetsOperation = 'token' | 'append' | 'read' | 'update';
export type GoogleSheetsErrorCategory =
  | 'key_format'
  | 'auth_rejected'
  | 'sheet_permission'
  | 'network'
  | 'unknown';

export class GoogleSheetsError extends Error {
  readonly status: number;
  readonly operation: GoogleSheetsOperation;
  readonly category: GoogleSheetsErrorCategory;

  constructor(
    operation: GoogleSheetsOperation,
    status: number,
    category: GoogleSheetsErrorCategory = 'unknown',
  ) {
    super(`Google Sheets ${operation} request failed`);
    this.name = 'GoogleSheetsError';
    this.status = status;
    this.operation = operation;
    this.category = category;
  }
}

interface ServiceAccountJson {
  type?: unknown;
  client_email?: unknown;
  private_key?: unknown;
  private_key_id?: unknown;
  token_uri?: unknown;
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function parseGoogleServiceAccountCredentials(raw: string): GoogleServiceAccountCredentials {
  try {
    const parsed = JSON.parse(raw) as ServiceAccountJson;
    const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
    const privateKey = typeof parsed.private_key === 'string' ? normalizePrivateKey(parsed.private_key) : '';
    const privateKeyId = typeof parsed.private_key_id === 'string' ? parsed.private_key_id.trim() : '';
    const tokenUri = typeof parsed.token_uri === 'string' && parsed.token_uri.trim()
      ? parsed.token_uri.trim()
      : GOOGLE_TOKEN_URL;
    if (
      parsed.type !== 'service_account'
      || !clientEmail
      || !privateKey.startsWith('-----BEGIN PRIVATE KEY-----')
      || !privateKey.endsWith('-----END PRIVATE KEY-----')
      || tokenUri !== GOOGLE_TOKEN_URL
    ) {
      throw new Error('invalid credentials');
    }
    return {
      clientEmail,
      privateKey,
      privateKeyId: privateKeyId || undefined,
      tokenUri,
    };
  } catch {
    // Do not include JSON/parser details because the input contains a private key.
    throw new Error('Google service account credentials are invalid');
  }
}

interface GoogleSheetsClientOptions {
  credentials: GoogleServiceAccountCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
  webCrypto?: Crypto;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function utf8Base64Url(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

function decodePkcs8Pem(pem: string): Uint8Array {
  const match = /^-----BEGIN PRIVATE KEY-----\n([\s\S]+)\n-----END PRIVATE KEY-----$/.exec(
    normalizePrivateKey(pem),
  );
  if (!match) throw new Error('invalid private key');
  const body = match[1].replace(/[\t\n\r ]/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new Error('invalid private key');
  }
  const unpadded = body.replace(/=+$/, '');
  const existingPadding = body.length - unpadded.length;
  if (unpadded.length % 4 === 1) throw new Error('invalid private key');
  const requiredPadding = (4 - (unpadded.length % 4)) % 4;
  if (existingPadding !== 0 && existingPadding !== requiredPadding) {
    throw new Error('invalid private key');
  }
  const binary = atob(`${unpadded}${'='.repeat(requiredPadding)}`);
  if (!binary) throw new Error('invalid private key');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function valueRange(values: SheetCellValue[][]): SheetsValueRange {
  return { majorDimension: 'ROWS', values };
}

export class GoogleSheetsClient {
  private readonly credentials: GoogleServiceAccountCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly webCrypto: Crypto;
  private cachedToken: CachedToken | null = null;

  constructor(options: GoogleSheetsClientOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.webCrypto = options.webCrypto ?? crypto;
  }

  private async createAssertion(): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
    if (this.credentials.privateKeyId) header.kid = this.credentials.privateKeyId;
    const claims = {
      iss: this.credentials.clientEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: this.credentials.tokenUri,
      iat: issuedAt,
      exp: issuedAt + JWT_LIFETIME_SECONDS,
    };
    const unsigned = `${utf8Base64Url(JSON.stringify(header))}.${utf8Base64Url(JSON.stringify(claims))}`;
    try {
      const key = await this.webCrypto.subtle.importKey(
        'pkcs8',
        decodePkcs8Pem(this.credentials.privateKey),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = await this.webCrypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        key,
        new TextEncoder().encode(unsigned),
      );
      return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
    } catch {
      throw new GoogleSheetsError('token', 0, 'key_format');
    }
  }

  async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.cachedToken && now < this.cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.cachedToken.value;
    }

    const assertion = await this.createAssertion();
    let response: Response;
    try {
      response = await this.fetchImpl(this.credentials.tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });
    } catch {
      throw new GoogleSheetsError('token', 0);
    }
    if (!response.ok) throw new GoogleSheetsError('token', response.status);

    const body = await response.json().catch(() => null) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new GoogleSheetsError('token', response.status);
    }
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? Math.max(1, body.expires_in)
      : JWT_LIFETIME_SECONDS;
    this.cachedToken = { value: body.access_token, expiresAt: now + expiresIn * 1000 };
    return body.access_token;
  }

  private async request<T>(operation: Exclude<GoogleSheetsOperation, 'token'>, url: string, init: RequestInit): Promise<T> {
    const accessToken = await this.getAccessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
      });
    } catch {
      throw new GoogleSheetsError(operation, 0);
    }
    if (!response.ok) throw new GoogleSheetsError(operation, response.status);
    const body = await response.json().catch(() => null);
    if (body === null) throw new GoogleSheetsError(operation, response.status);
    return body as T;
  }

  appendValues(spreadsheetId: string, range: string, values: SheetCellValue[][]): Promise<AppendValuesResponse> {
    const url = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}/values/${encodePathPart(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    return this.request('append', url, {
      method: 'POST',
      body: JSON.stringify(valueRange(values)),
    });
  }

  readValues(spreadsheetId: string, range: string): Promise<SheetsValueRange> {
    const url = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}/values/${encodePathPart(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
    return this.request('read', url, { method: 'GET' });
  }

  updateValues(spreadsheetId: string, range: string, values: SheetCellValue[][]): Promise<UpdateValuesResponse> {
    const url = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}/values/${encodePathPart(range)}?valueInputOption=RAW`;
    return this.request('update', url, {
      method: 'PUT',
      body: JSON.stringify(valueRange(values)),
    });
  }
}
