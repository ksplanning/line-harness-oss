/**
 * T-C7 / A9 — message-templates の flex 保存前検証 (JSON.parse → guardFlexContent 横展開)。
 *
 *  - POST/PUT が不正 flex (構造違反) を保存時 400 で弾く (broadcasts と同一 guardFlexContent = drift なし)
 *  - 既存の正当な flex は 201/200 (後方互換 audit fixture)
 *  - content 未変更 update (name だけ) は再検証しない (broadcast PUT partial-update パターン)
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  listMessageTemplates: vi.fn(),
  getMessageTemplateById: vi.fn(),
  createMessageTemplate: vi.fn(),
  updateMessageTemplate: vi.fn(),
  deleteMessageTemplate: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { messageTemplates } = await import('./message-templates.js');

function setupApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { c.env = { DB: {} as unknown } as never; await next(); });
  app.route('/', messageTemplates);
  return app;
}

// broadcasts の flex-validate.test.ts と同一の fixture (同じ guardFlexContent を共有する証)。
const okBubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'hi', wrap: true }] } };
const emptyCarousel = { type: 'carousel', contents: [] };
const httpImageBubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'image', url: 'http://ex.com/a.jpg' }] } };

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.createMessageTemplate.mockResolvedValue({ id: 't1', name: 'n', message_type: 'flex', message_content: '{}' });
  dbMocks.updateMessageTemplate.mockResolvedValue({ id: 't1', name: 'n', message_type: 'flex', message_content: '{}' });
});

async function post(body: unknown) {
  return setupApp().request('/api/message-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function put(id: string, body: unknown) {
  return setupApp().request(`/api/message-templates/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('T-C7 message-templates POST flex guard', () => {
  test('valid flex → 201', async () => {
    const res = await post({ name: 'ok', messageType: 'flex', messageContent: JSON.stringify(okBubble) });
    expect(res.status).toBe(201);
    expect(dbMocks.createMessageTemplate).toHaveBeenCalledOnce();
  });
  test('invalid flex (empty carousel) → 400, not saved (同じ fixture を broadcasts も弾く)', async () => {
    const res = await post({ name: 'x', messageType: 'flex', messageContent: JSON.stringify(emptyCarousel) });
    expect(res.status).toBe(400);
    expect(dbMocks.createMessageTemplate).not.toHaveBeenCalled();
  });
  test('invalid flex (http image) → 400', async () => {
    const res = await post({ name: 'x', messageType: 'flex', messageContent: JSON.stringify(httpImageBubble) });
    expect(res.status).toBe(400);
  });
  test('non-json flex → 400', async () => {
    const res = await post({ name: 'x', messageType: 'flex', messageContent: '{broken' });
    expect(res.status).toBe(400);
  });
  test('text type skips flex validation → 201', async () => {
    dbMocks.createMessageTemplate.mockResolvedValue({ id: 't1', name: 'n', message_type: 'text', message_content: 'hi' });
    const res = await post({ name: 't', messageType: 'text', messageContent: 'ただのテキスト' });
    expect(res.status).toBe(201);
  });
});

describe('T-C7 message-templates PUT flex guard (partial-update 後方互換)', () => {
  const existingFlex = { id: 't1', name: 'n', message_type: 'flex', message_content: JSON.stringify(okBubble) };
  test('name-only update (no messageContent) is NOT re-validated → 200', async () => {
    dbMocks.getMessageTemplateById.mockResolvedValue(existingFlex);
    dbMocks.updateMessageTemplate.mockResolvedValue({ ...existingFlex, name: '新名' });
    const res = await put('t1', { name: '新名' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateMessageTemplate).toHaveBeenCalledOnce();
  });
  test('invalid flex content update → 400', async () => {
    dbMocks.getMessageTemplateById.mockResolvedValue(existingFlex);
    const res = await put('t1', { messageContent: JSON.stringify(emptyCarousel) });
    expect(res.status).toBe(400);
    expect(dbMocks.updateMessageTemplate).not.toHaveBeenCalled();
  });
  test('valid flex content update → 200', async () => {
    dbMocks.getMessageTemplateById.mockResolvedValue(existingFlex);
    dbMocks.updateMessageTemplate.mockResolvedValue(existingFlex);
    const res = await put('t1', { messageContent: JSON.stringify(okBubble) });
    expect(res.status).toBe(200);
  });
});
