/**
 * T-C6 / A4 / D-4 — sender_presets CRUD route (account-scoped・4 verb guard・値検証が正典)。
 *
 *  - GET/POST/PATCH/DELETE すべて accountId 必須 (欠落 400) / account-scope (別 account は見えない/触れない)
 *  - 値検証 (正典): name 必須・20 文字以内 / iconUrl は https + 許可ドメイン (WORKER_URL ホスト)
 *  - LINE API outbound ゼロ (route は LineClient を import すらしない = 構造的にゼロ)
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  listSenderPresets: vi.fn(),
  createSenderPreset: vi.fn(),
  getSenderPresetById: vi.fn(),
  updateSenderPreset: vi.fn(),
  deleteSenderPreset: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { senderPresets } = await import('./sender-presets.js');

type TestEnv = { Bindings: { DB: D1Database; WORKER_URL: string } };

function setupApp() {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: {} as D1Database, WORKER_URL: 'https://worker.example.com' } as never;
    await next();
  });
  app.route('/', senderPresets);
  return app;
}

const preset = (over: Record<string, unknown> = {}) => ({
  id: 'sp-1', line_account_id: 'acc-1', name: '担当A', icon_url: null, created_at: '2026-07-04T00:00:00.000', ...over,
});

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

async function req(path: string, method: string, body?: unknown) {
  return setupApp().request(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('T-C6 GET/POST account scope + value validation', () => {
  test('GET without accountId → 400', async () => {
    expect((await req('/api/sender-presets', 'GET')).status).toBe(400);
  });
  test('GET with accountId lists account-scoped presets', async () => {
    dbMocks.listSenderPresets.mockResolvedValue([preset()]);
    const res = await req('/api/sender-presets?accountId=acc-1', 'GET');
    expect(res.status).toBe(200);
    expect(dbMocks.listSenderPresets).toHaveBeenCalledWith(expect.anything(), 'acc-1');
  });
  test('POST without accountId → 400', async () => {
    expect((await req('/api/sender-presets', 'POST', { name: 'X' })).status).toBe(400);
  });
  test('POST valid → 201', async () => {
    dbMocks.createSenderPreset.mockResolvedValue(preset({ name: '春担当' }));
    const res = await req('/api/sender-presets?accountId=acc-1', 'POST', { name: '春担当' });
    expect(res.status).toBe(201);
    expect(dbMocks.createSenderPreset).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: 'acc-1', name: '春担当' }));
  });
  test('POST missing name → 400', async () => {
    const res = await req('/api/sender-presets?accountId=acc-1', 'POST', { name: '  ' });
    expect(res.status).toBe(400);
    expect(dbMocks.createSenderPreset).not.toHaveBeenCalled();
  });
  test('POST name 21 chars → 400 (日本語エラー)', async () => {
    const res = await req('/api/sender-presets?accountId=acc-1', 'POST', { name: 'あ'.repeat(21) });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: string };
    expect(b.error).not.toMatch(/[a-zA-Z]{6,}/);
  });
  test('POST iconUrl http (non-https) → 400', async () => {
    const res = await req('/api/sender-presets?accountId=acc-1', 'POST', { name: 'X', iconUrl: 'http://worker.example.com/media/a.png' });
    expect(res.status).toBe(400);
  });
  test('POST iconUrl on a foreign domain → 400 (許可ドメイン外)', async () => {
    const res = await req('/api/sender-presets?accountId=acc-1', 'POST', { name: 'X', iconUrl: 'https://evil.example.net/logo.png' });
    expect(res.status).toBe(400);
    expect(dbMocks.createSenderPreset).not.toHaveBeenCalled();
  });
  test('POST iconUrl on the app own media host → 201', async () => {
    dbMocks.createSenderPreset.mockResolvedValue(preset({ icon_url: 'https://worker.example.com/media/a.png' }));
    const res = await req('/api/sender-presets?accountId=acc-1', 'POST', { name: 'X', iconUrl: 'https://worker.example.com/media/a.png' });
    expect(res.status).toBe(201);
  });
});

describe('T-C6 PATCH/DELETE account scope (別 account 不可)', () => {
  test('PATCH foreign id (account-scoped lookup null) → 404', async () => {
    dbMocks.getSenderPresetById.mockResolvedValue(null);
    const res = await req('/api/sender-presets/sp-1?accountId=acc-2', 'PATCH', { name: '書換' });
    expect(res.status).toBe(404);
    expect(dbMocks.updateSenderPreset).not.toHaveBeenCalled();
    // account-scoped lookup が request accountId で呼ばれる (別 account の id を引けない)。
    expect(dbMocks.getSenderPresetById).toHaveBeenCalledWith(expect.anything(), 'sp-1', 'acc-2');
  });
  test('PATCH own preset with valid name → 200', async () => {
    dbMocks.getSenderPresetById.mockResolvedValue(preset());
    dbMocks.updateSenderPreset.mockResolvedValue(preset({ name: '新担当' }));
    const res = await req('/api/sender-presets/sp-1?accountId=acc-1', 'PATCH', { name: '新担当' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateSenderPreset).toHaveBeenCalledWith(expect.anything(), 'sp-1', 'acc-1', expect.objectContaining({ name: '新担当' }));
  });
  test('PATCH without accountId → 400', async () => {
    expect((await req('/api/sender-presets/sp-1', 'PATCH', { name: 'X' })).status).toBe(400);
  });
  test('DELETE foreign id → 404, own → 200', async () => {
    dbMocks.getSenderPresetById.mockResolvedValueOnce(null);
    expect((await req('/api/sender-presets/sp-1?accountId=acc-2', 'DELETE')).status).toBe(404);
    dbMocks.getSenderPresetById.mockResolvedValueOnce(preset());
    const res = await req('/api/sender-presets/sp-1?accountId=acc-1', 'DELETE');
    expect(res.status).toBe(200);
    expect(dbMocks.deleteSenderPreset).toHaveBeenCalledWith(expect.anything(), 'sp-1', 'acc-1');
  });
});
