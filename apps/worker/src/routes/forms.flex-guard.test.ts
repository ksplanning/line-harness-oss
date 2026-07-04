/**
 * T-C7 / A9 — forms の送信後アクション flex 保存前検証 (guardFlexContent 横展開)。
 *  - POST/PUT が不正 flex を 400・正当 flex は 201/200・content 未変更は再検証しない (partial-update)
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getForms: vi.fn(),
  getFormsWithStats: vi.fn(),
  getFormById: vi.fn(),
  createForm: vi.fn(),
  updateForm: vi.fn(),
  deleteForm: vi.fn(),
  getFormSubmissions: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getFriendById: vi.fn(),
  addTagToFriend: vi.fn(),
  enrollFriendInScenario: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { forms } = await import('./forms.js');

function setupApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { c.env = { DB: {} as unknown } as never; await next(); });
  app.route('/', forms);
  return app;
}

const okBubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'ありがとうございました', wrap: true }] } };
const emptyCarousel = { type: 'carousel', contents: [] };

function formRow(over: Record<string, unknown> = {}) {
  return {
    id: 'form-1', name: 'n', description: null, fields: '[]',
    on_submit_tag_id: null, on_submit_scenario_id: null,
    on_submit_message_type: 'flex', on_submit_message_content: JSON.stringify(okBubble),
    on_submit_webhook_url: null, on_submit_webhook_headers: null, on_submit_webhook_fail_message: null,
    is_active: 1, created_at: '2026-07-04T00:00:00.000', updated_at: '2026-07-04T00:00:00.000', ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.createForm.mockResolvedValue(formRow());
  dbMocks.updateForm.mockResolvedValue(formRow());
});

async function post(body: unknown) {
  return setupApp().request('/api/forms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function put(id: string, body: unknown) {
  return setupApp().request(`/api/forms/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('T-C7 forms onSubmit flex guard', () => {
  test('POST valid onSubmit flex → 201', async () => {
    const res = await post({ name: 'f', onSubmitMessageType: 'flex', onSubmitMessageContent: JSON.stringify(okBubble) });
    expect(res.status).toBe(201);
    expect(dbMocks.createForm).toHaveBeenCalledOnce();
  });
  test('POST invalid onSubmit flex → 400, not saved', async () => {
    const res = await post({ name: 'f', onSubmitMessageType: 'flex', onSubmitMessageContent: JSON.stringify(emptyCarousel) });
    expect(res.status).toBe(400);
    expect(dbMocks.createForm).not.toHaveBeenCalled();
  });
  test('POST text onSubmit skips flex validation → 201', async () => {
    dbMocks.createForm.mockResolvedValue(formRow({ on_submit_message_type: 'text', on_submit_message_content: 'ありがとう' }));
    const res = await post({ name: 'f', onSubmitMessageType: 'text', onSubmitMessageContent: 'ありがとう' });
    expect(res.status).toBe(201);
  });
  test('PUT invalid onSubmit flex content (existing type flex) → 400', async () => {
    dbMocks.getFormById.mockResolvedValue(formRow());
    const res = await put('form-1', { onSubmitMessageContent: JSON.stringify(emptyCarousel) });
    expect(res.status).toBe(400);
    expect(dbMocks.updateForm).not.toHaveBeenCalled();
  });
  test('PUT name-only (no onSubmitMessageContent) is not re-validated → 200', async () => {
    dbMocks.updateForm.mockResolvedValue(formRow({ name: '新名' }));
    const res = await put('form-1', { name: '新名' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateForm).toHaveBeenCalledOnce();
  });
});
