/**
 * images list/serve/delete (batch2 C3 / G15 メディアライブラリ)。
 *
 * - GET /api/images: R2 .list({prefix:'media/'}) で media/ 配下だけ返す。
 *   受信画像 (incoming-*) やリッチメニュー素材 (rich-menus/*) を混入させない (T-M2)。
 * - POST /api/images: 保存 key を media/{uuid}.{ext} に prefix 化 (T-M1)。
 * - GET /images/:key・DELETE /api/images/:key: slash 含み key (media/xxx.png) を扱える (T-M3)。
 */
import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { images } from './images.js';

type StoredObj = { body: Uint8Array; contentType?: string; customMetadata?: Record<string, string>; uploaded: Date; etag: string };

// R2 .list({prefix, cursor, limit}) をサポートする stub。
function makeR2Stub(seed: Record<string, { size?: number }> = {}): { r2: R2Bucket; store: Map<string, StoredObj> } {
  const store = new Map<string, StoredObj>();
  for (const [key, meta] of Object.entries(seed)) {
    store.set(key, {
      body: new Uint8Array(meta.size ?? 4),
      contentType: 'image/png',
      uploaded: new Date('2026-07-03T00:00:00.000Z'),
      etag: 'etag-' + key,
    });
  }
  const r2 = {
    async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      store.set(key, { body: bytes, contentType: options?.httpMetadata?.contentType, customMetadata: options?.customMetadata, uploaded: new Date('2026-07-03T00:00:00.000Z'), etag: 'etag-' + key });
      return {} as never;
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return { body: item.body, httpMetadata: { contentType: item.contentType }, etag: item.etag } as never;
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
      const prefix = opts?.prefix ?? '';
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const limit = opts?.limit ?? 1000;
      const startIdx = opts?.cursor ? all.indexOf(opts.cursor) + 1 : 0;
      const page = all.slice(startIdx, startIdx + limit);
      const lastIdx = startIdx + limit;
      const truncated = lastIdx < all.length;
      return {
        objects: page.map((key) => ({
          key,
          size: store.get(key)!.body.byteLength,
          uploaded: store.get(key)!.uploaded,
          etag: store.get(key)!.etag,
        })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      } as never;
    },
  } as unknown as R2Bucket;
  return { r2, store };
}

function setupApp(r2: R2Bucket, workerUrl = 'https://w.example.com') {
  const app = new Hono<{ Bindings: { IMAGES: R2Bucket; WORKER_URL?: string } }>();
  app.use('*', async (c, next) => {
    c.env = { IMAGES: r2, WORKER_URL: workerUrl } as never;
    await next();
  });
  app.route('/', images);
  return app;
}

describe('GET /api/images list (prefix scope / T-M1/T-M2)', () => {
  test('media/ に 2 件で list は 2 件・url/size/uploaded を返す', async () => {
    const { r2 } = makeR2Stub({ 'media/a.png': { size: 10 }, 'media/b.png': { size: 20 } });
    const app = setupApp(r2);
    const res = await app.request('/api/images');
    expect(res.status).toBe(200);
    const b = (await res.json()) as { success: boolean; data: { items: { key: string; url: string; size: number; uploaded: string }[]; cursor?: string } };
    expect(b.success).toBe(true);
    expect(b.data.items).toHaveLength(2);
    expect(b.data.items.map((i) => i.key).sort()).toEqual(['media/a.png', 'media/b.png']);
    expect(b.data.items[0].url).toContain('/images/media/');
    expect(typeof b.data.items[0].size).toBe('number');
    expect(typeof b.data.items[0].uploaded).toBe('string');
  });

  test('0 件は空配列', async () => {
    const { r2 } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request('/api/images');
    const b = (await res.json()) as { data: { items: unknown[] } };
    expect(b.data.items).toEqual([]);
  });

  test('incoming-* / rich-menus/* を put しても list に出ない (T-M2 混入防止)', async () => {
    const { r2 } = makeR2Stub({
      'media/keep.png': { size: 4 },
      'incoming-acc1-msg1.jpg': { size: 4 },
      'rich-menus/rm1.png': { size: 4 },
      'legacy-flat-uuid.png': { size: 4 },
    });
    const app = setupApp(r2);
    const res = await app.request('/api/images');
    const b = (await res.json()) as { data: { items: { key: string }[] } };
    expect(b.data.items.map((i) => i.key)).toEqual(['media/keep.png']);
  });

  test('1000 件超で cursor が返り、cursor で次ページを取れる', async () => {
    const seed: Record<string, { size?: number }> = {};
    for (let i = 0; i < 1005; i++) seed[`media/${String(i).padStart(5, '0')}.png`] = { size: 1 };
    const { r2 } = makeR2Stub(seed);
    const app = setupApp(r2);
    const res1 = await app.request('/api/images');
    const b1 = (await res1.json()) as { data: { items: unknown[]; cursor?: string } };
    expect(b1.data.items).toHaveLength(1000);
    expect(b1.data.cursor).toBeTruthy();
    const res2 = await app.request(`/api/images?cursor=${encodeURIComponent(b1.data.cursor!)}`);
    const b2 = (await res2.json()) as { data: { items: unknown[]; cursor?: string } };
    expect(b2.data.items).toHaveLength(5);
    expect(b2.data.cursor).toBeFalsy();
  });
});

describe('POST /api/images key prefix (T-M1)', () => {
  test('保存 key が media/ で始まる', async () => {
    const { r2, store } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([1, 2, 3, 4]).buffer,
    });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { data: { key: string; url: string } };
    expect(b.data.key.startsWith('media/')).toBe(true);
    expect(b.data.url).toContain('/images/media/');
    expect([...store.keys()][0].startsWith('media/')).toBe(true);
  });
});

describe('serve / delete slash key (T-M3)', () => {
  test('GET /images/media/xxx.png (slash key) が serve できる', async () => {
    const { r2 } = makeR2Stub({ 'media/pic.png': { size: 8 } });
    const app = setupApp(r2);
    const res = await app.request('/images/media/pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  test('GET /images/legacy-flat.png (既存 flat key) も serve できる', async () => {
    const { r2 } = makeR2Stub({ 'legacy-flat.png': { size: 8 } });
    const app = setupApp(r2);
    const res = await app.request('/images/legacy-flat.png');
    expect(res.status).toBe(200);
  });

  test('DELETE /api/images/media/xxx.png (slash key) が削除できる', async () => {
    const { r2, store } = makeR2Stub({ 'media/del.png': { size: 8 } });
    const app = setupApp(r2);
    const res = await app.request('/api/images/media/del.png', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.has('media/del.png')).toBe(false);
  });

  test('DELETE /api/images/legacy-flat.png (既存 flat key) も削除できる', async () => {
    const { r2, store } = makeR2Stub({ 'legacy-flat.png': { size: 8 } });
    const app = setupApp(r2);
    const res = await app.request('/api/images/legacy-flat.png', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.has('legacy-flat.png')).toBe(false);
  });

  // web api client は key を encodeURIComponent する (slash → %2F)。Hono wildcard がこれを
  // decode して media/xxx.png として削除できることを確認 (ui-design.md §1 の懸念を de-risk)。
  test('DELETE /api/images/media%2Fenc.png (encodeURIComponent 済み slash) が削除できる', async () => {
    const { r2, store } = makeR2Stub({ 'media/enc.png': { size: 8 } });
    const app = setupApp(r2);
    const res = await app.request('/api/images/media%2Fenc.png', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.has('media/enc.png')).toBe(false);
  });
});
