import { describe, expect, test, vi } from 'vitest';
import {
  ensureFormalooInstantWebhook,
  removeFormalooInstantWebhook,
  type FormalooWebhookApi,
} from './formaloo-instant-webhook.js';

function ok(data: unknown = {}): { ok: true; status: number; data: unknown } {
  return { ok: true, status: 200, data };
}

function fail(status: number): { ok: false; status: number; error: string } {
  return { ok: false, status, error: `HTTP ${status}` };
}

function client(input?: {
  gets?: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>;
  posts?: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>;
  requests?: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>;
  deletes?: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>;
}) {
  const gets = [...(input?.gets ?? [])];
  const posts = [...(input?.posts ?? [])];
  const requests = [...(input?.requests ?? [])];
  const deletes = [...(input?.deletes ?? [])];
  const api: FormalooWebhookApi = {
    get: vi.fn(async () => gets.shift() ?? fail(500)),
    post: vi.fn(async () => posts.shift() ?? fail(500)),
    request: vi.fn(async () => requests.shift() ?? fail(500)),
    delete: vi.fn(async () => deletes.shift() ?? fail(500)),
  };
  return api;
}

const formSlug = 'safe-disposable-form';
const callbackUrl = 'https://worker.example/formaloo/instant/fa_safe/callback-secret';
const collectionPath = `/v3.0/forms/${formSlug}/webhooks/`;

describe('ensureFormalooInstantWebhook', () => {
  test('存在しない時だけ POST し、submit event=true の read-back 後に成功する', async () => {
    const api = client({
      gets: [
        ok({ data: { webhooks: [] } }),
        ok({ data: { webhooks: [{ slug: 'wh_1', url: callbackUrl, form_submit_events: true }] } }),
      ],
      posts: [ok({ data: { webhook: { slug: 'wh_1' } } })],
    });

    await expect(ensureFormalooInstantWebhook(api, { formSlug, callbackUrl })).resolves.toEqual({
      ok: true,
      webhookId: 'wh_1',
      created: true,
    });
    expect(api.get).toHaveBeenNthCalledWith(1, collectionPath);
    expect(api.post).toHaveBeenCalledWith(collectionPath, {
      url: callbackUrl,
      form_submit_events: true,
      form_update_events: false,
    });
    expect(api.get).toHaveBeenNthCalledWith(2, collectionPath);
  });

  test('同じ URL + submit=true の既存登録を採用し、再登録を重複させない', async () => {
    const api = client({
      gets: [ok({ data: [{ id: 'wh_existing', webhook_url: callbackUrl, events: { form_submit_events: true } }] })],
    });

    await expect(ensureFormalooInstantWebhook(api, { formSlug, callbackUrl })).resolves.toEqual({
      ok: true,
      webhookId: 'wh_existing',
      created: false,
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  test('POST 201 でも read-back の submit flag が false なら soft-201 として失敗する', async () => {
    const api = client({
      gets: [
        ok({ data: { webhooks: [] } }),
        ok({ data: { webhooks: [{ slug: 'wh_soft', url: callbackUrl, form_submit_events: false }] } }),
      ],
      posts: [{ ok: true, status: 201, data: { data: { webhook: { slug: 'wh_soft' } } } }],
      requests: [ok()],
    });

    await expect(ensureFormalooInstantWebhook(api, { formSlug, callbackUrl })).resolves.toMatchObject({
      ok: false,
      reason: 'read_back_failed',
    });
    expect(api.request).toHaveBeenCalledWith('DELETE', collectionPath, {
      id: 'wh_soft',
      url: callbackUrl,
    });
  });

  test('事前 GET に失敗した時は重複を避けるため POST しない', async () => {
    const api = client({ gets: [fail(503)] });
    await expect(ensureFormalooInstantWebhook(api, { formSlug, callbackUrl })).resolves.toMatchObject({
      ok: false,
      reason: 'read_failed',
    });
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('removeFormalooInstantWebhook', () => {
  test('保存済み id と URL を form-scoped collection DELETE に渡す', async () => {
    const api = client({ requests: [ok()] });
    await expect(removeFormalooInstantWebhook(api, {
      formSlug,
      webhookId: 'wh_delete',
      callbackUrl,
    })).resolves.toEqual({ ok: true });
    expect(api.request).toHaveBeenCalledWith('DELETE', collectionPath, {
      id: 'wh_delete',
      url: callbackUrl,
    });
    expect(api.delete).not.toHaveBeenCalled();
  });

  test('collection 形式が非対応なら id path へ bounded fallback し、404 も解除済み成功扱い', async () => {
    const api = client({ requests: [fail(405)], deletes: [fail(404)] });
    await expect(removeFormalooInstantWebhook(api, {
      formSlug,
      webhookId: 'wh_gone',
      callbackUrl,
    })).resolves.toEqual({ ok: true });
    expect(api.delete).toHaveBeenCalledWith(`${collectionPath}wh_gone/`);
  });
});
