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
const MAX_FETCH_ERROR_DETAIL_LENGTH = 160;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const COLUMN_CAPACITY_HEADROOM = 4;

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

export interface SheetsDataUpdate {
  range: string;
  values: SheetCellValue[][];
}

export interface BatchUpdateValuesResponse {
  spreadsheetId: string;
  totalUpdatedRows?: number;
  totalUpdatedColumns?: number;
  totalUpdatedCells?: number;
}

export type GoogleSheetsOperation =
  | 'token'
  | 'metadata'
  | 'append'
  | 'read'
  | 'update'
  | 'batch_update';
export type GoogleSheetsErrorCategory =
  | 'key_format'
  | 'auth_rejected'
  | 'sheet_permission'
  | 'network';

export class GoogleSheetsError extends Error {
  readonly status: number;
  readonly operation: GoogleSheetsOperation;
  readonly category: GoogleSheetsErrorCategory;
  readonly detail?: string;

  constructor(
    operation: GoogleSheetsOperation,
    status: number,
    category: GoogleSheetsErrorCategory,
    detail?: string,
  ) {
    super(`Google Sheets ${operation} request failed`);
    this.name = 'GoogleSheetsError';
    this.status = status;
    this.operation = operation;
    this.category = category;
    if (detail) this.detail = detail;
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
  requestTimeoutMs?: number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface SheetsMetadataResponse {
  sheets?: Array<{
    properties?: {
      sheetId?: unknown;
      title?: unknown;
      gridProperties?: { columnCount?: unknown };
    };
  }>;
}

interface SheetsBatchUpdateResponse {
  spreadsheetId?: unknown;
  replies?: unknown[];
}

export interface DeleteRowsResponse {
  spreadsheetId: string;
  deletedRows: number;
}

export interface EnsureColumnCapacityResponse {
  spreadsheetId: string;
  appendedColumns: number;
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

function tokenFailureCategory(status: number): GoogleSheetsErrorCategory {
  return status === 429 || status >= 500 ? 'network' : 'auth_rejected';
}

function sheetsFailureCategory(status: number): GoogleSheetsErrorCategory {
  if (status === 401) return 'auth_rejected';
  if (status === 429 || status >= 500) return 'network';
  return 'sheet_permission';
}

function fetchErrorDetail(cause: unknown): string {
  const error = typeof cause === 'object' && cause !== null
    ? cause as { name?: unknown; message?: unknown }
    : null;
  const rawName = typeof error?.name === 'string' && error.name.trim() ? error.name : 'Error';
  const name = rawName.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'Error';
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message
    : 'Fetch failed';
  const redactedMessage = message
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
  return `${name}: ${redactedMessage}`
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FETCH_ERROR_DETAIL_LENGTH);
}

export class GoogleSheetsClient {
  private readonly credentials: GoogleServiceAccountCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly webCrypto: Crypto;
  private readonly requestTimeoutMs: number;
  private cachedToken: CachedToken | null = null;
  private readonly sheetIds = new Map<string, number>();

  constructor(options: GoogleSheetsClientOptions) {
    if (options.credentials.tokenUri !== GOOGLE_TOKEN_URL) {
      throw new Error('Google service account credentials are invalid');
    }
    this.credentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.webCrypto = options.webCrypto ?? crypto;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(1, Math.min(120_000, Math.trunc(options.requestTimeoutMs!)))
      : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async createAssertion(): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
    if (this.credentials.privateKeyId) header.kid = this.credentials.privateKeyId;
    const claims = {
      iss: this.credentials.clientEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
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
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });
    } catch (error) {
      throw new GoogleSheetsError('token', 0, 'network', fetchErrorDetail(error));
    }
    if (!response.ok) {
      throw new GoogleSheetsError('token', response.status, tokenFailureCategory(response.status));
    }

    const body = await response.json().catch(() => null) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new GoogleSheetsError('token', response.status, 'auth_rejected');
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
        redirect: 'manual',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new GoogleSheetsError(operation, 0, 'network', fetchErrorDetail(error));
    }
    if (!response.ok) {
      throw new GoogleSheetsError(operation, response.status, sheetsFailureCategory(response.status));
    }
    const body = await response.json().catch(() => null);
    if (body === null) throw new GoogleSheetsError(operation, response.status, 'network');
    return body as T;
  }

  async listSheetTitles(spreadsheetId: string): Promise<string[]> {
    const url = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}?fields=sheets.properties(title)`;
    const metadata = await this.request<SheetsMetadataResponse>('metadata', url, { method: 'GET' });
    if (!Array.isArray(metadata.sheets)) return [];
    return metadata.sheets.flatMap((sheet) => {
      const title = sheet.properties?.title;
      return typeof title === 'string' && title.length > 0 ? [title] : [];
    });
  }

  async resolveSheetId(spreadsheetId: string, sheetName: string): Promise<number> {
    const cacheKey = `${spreadsheetId}\u0000${sheetName}`;
    const cached = this.sheetIds.get(cacheKey);
    if (cached !== undefined) return cached;
    const metadataUrl = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}?fields=sheets.properties(sheetId%2Ctitle)`;
    const metadata = await this.request<SheetsMetadataResponse>('metadata', metadataUrl, { method: 'GET' });
    const sheetId = metadata.sheets?.find((sheet) => sheet.properties?.title === sheetName)
      ?.properties?.sheetId;
    if (typeof sheetId !== 'number' || !Number.isInteger(sheetId)) {
      throw new GoogleSheetsError('metadata', 404, 'sheet_permission');
    }
    this.sheetIds.set(cacheKey, sheetId);
    return sheetId;
  }

  async ensureColumnCapacity(
    spreadsheetId: string,
    sheetName: string,
    requiredColumnCount: number,
  ): Promise<EnsureColumnCapacityResponse> {
    if (!Number.isInteger(requiredColumnCount) || requiredColumnCount < 1) {
      throw new Error('Google Sheets column capacity requires a positive integer');
    }
    const metadataUrl = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}?fields=sheets.properties(sheetId%2Ctitle%2CgridProperties(columnCount))`;
    const metadata = await this.request<SheetsMetadataResponse>('metadata', metadataUrl, { method: 'GET' });
    const properties = metadata.sheets?.find((sheet) => sheet.properties?.title === sheetName)
      ?.properties;
    const sheetId = properties?.sheetId;
    const columnCount = properties?.gridProperties?.columnCount;
    if (
      typeof sheetId !== 'number'
      || !Number.isInteger(sheetId)
      || typeof columnCount !== 'number'
      || !Number.isInteger(columnCount)
      || columnCount < 1
    ) {
      throw new GoogleSheetsError('metadata', 404, 'sheet_permission');
    }
    this.sheetIds.set(`${spreadsheetId}\u0000${sheetName}`, sheetId);
    if (requiredColumnCount <= columnCount) {
      return { spreadsheetId, appendedColumns: 0 };
    }

    const appendedColumns = requiredColumnCount - columnCount + COLUMN_CAPACITY_HEADROOM;
    const url = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}:batchUpdate`;
    await this.request<SheetsBatchUpdateResponse>('batch_update', url, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          appendDimension: {
            sheetId,
            dimension: 'COLUMNS',
            length: appendedColumns,
          },
        }],
      }),
    });
    return { spreadsheetId, appendedColumns };
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

  batchUpdateValues(spreadsheetId: string, data: SheetsDataUpdate[]): Promise<BatchUpdateValuesResponse> {
    const url = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}/values:batchUpdate`;
    return this.request('batch_update', url, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: data.map((entry) => ({
          range: entry.range,
          ...valueRange(entry.values),
        })),
      }),
    });
  }

  async deleteRows(
    spreadsheetId: string,
    sheetName: string,
    rowNumbers: number[],
  ): Promise<DeleteRowsResponse> {
    const rows = [...new Set(rowNumbers)]
      .filter((rowNumber) => Number.isInteger(rowNumber) && rowNumber > 1)
      .sort((left, right) => right - left);
    if (rows.length !== rowNumbers.length) {
      throw new Error('Google Sheets row deletion requires unique data-row numbers');
    }
    if (rows.length === 0) return { spreadsheetId, deletedRows: 0 };

    const sheetId = await this.resolveSheetId(spreadsheetId, sheetName);

    const url = `${GOOGLE_SHEETS_API}/spreadsheets/${encodePathPart(spreadsheetId)}:batchUpdate`;
    await this.request<SheetsBatchUpdateResponse>('batch_update', url, {
      method: 'POST',
      body: JSON.stringify({
        requests: rows.map((rowNumber) => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        })),
      }),
    });
    return { spreadsheetId, deletedRows: rows.length };
  }
}
