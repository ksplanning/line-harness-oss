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

async function readPutValue(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value && typeof (value as { getReader?: unknown }).getReader === 'function') {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  throw new TypeError('Unsupported R2 put test value');
}

// R2 .list({prefix, cursor, limit}) をサポートする stub。
function makeR2Stub(seed: Record<string, { size?: number }> = {}): {
  r2: R2Bucket;
  store: Map<string, StoredObj>;
  putValues: unknown[];
} {
  const store = new Map<string, StoredObj>();
  const putValues: unknown[] = [];
  for (const [key, meta] of Object.entries(seed)) {
    store.set(key, {
      body: new Uint8Array(meta.size ?? 4),
      contentType: 'image/png',
      uploaded: new Date('2026-07-03T00:00:00.000Z'),
      etag: 'etag-' + key,
    });
  }
  const r2 = {
    async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      putValues.push(value);
      const bytes = await readPutValue(value);
      store.set(key, { body: bytes, contentType: options?.httpMetadata?.contentType, customMetadata: options?.customMetadata, uploaded: new Date('2026-07-03T00:00:00.000Z'), etag: 'etag-' + key });
      return { size: bytes.byteLength } as never;
    },
    async head(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return {
        size: item.body.byteLength,
        httpMetadata: { contentType: item.contentType },
        etag: item.etag,
        httpEtag: `"${item.etag}"`,
      } as never;
    },
    async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
      const item = store.get(key);
      if (!item) return null;
      const fullSize = item.body.byteLength;
      const requested = options?.range;
      let offset = 0;
      let length = fullSize;
      if (requested) {
        if (requested.suffix !== undefined) {
          length = Math.min(requested.suffix, fullSize);
          offset = fullSize - length;
        } else {
          offset = requested.offset ?? 0;
          length = Math.min(requested.length ?? fullSize - offset, fullSize - offset);
        }
      }
      return {
        body: item.body.slice(offset, offset + length),
        size: fullSize,
        range: requested ? { offset, length } : undefined,
        httpMetadata: { contentType: item.contentType },
        etag: item.etag,
        httpEtag: `"${item.etag}"`,
      } as never;
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
  return { r2, store, putValues };
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
      headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
      body: new Uint8Array([1, 2, 3, 4]).buffer,
    });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { data: { key: string; url: string } };
    expect(b.data.key.startsWith('media/')).toBe(true);
    expect(b.data.url).toContain('/images/media/');
    expect([...store.keys()][0].startsWith('media/')).toBe(true);
  });

  test('10MiB exactly is accepted and stored (message image original boundary)', async () => {
    const { r2, store } = makeR2Stub({});
    const app = setupApp(r2);
    const tenMiB = 10 * 1024 * 1024;
    const res = await app.request('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(tenMiB) },
      body: new Uint8Array(tenMiB).buffer,
    });

    expect(res.status).toBe(201);
    const body = await res.json<{ data: { size: number } }>();
    expect(body.data.size).toBe(tenMiB);
    expect([...store.values()][0]?.body.byteLength).toBe(tenMiB);
  });

  test('10MiB + 1 byte is rejected loudly and never stored', async () => {
    const { r2, store } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(10 * 1024 * 1024 + 1) },
      body: new Uint8Array(10 * 1024 * 1024 + 1).buffer,
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/10\s*MB/i);
    expect(store.size).toBe(0);
  });
});

describe('POST /api/images direct media uploads (D-2)', () => {
  test('video/mp4 is streamed to R2 under a non-library prefix', async () => {
    const { r2, store, putValues } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request('/api/images?kind=video', {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' },
      body: new Uint8Array([1, 2, 3, 4]).buffer,
    });

    expect(res.status).toBe(201);
    const body = await res.json<{ data: { key: string; mimeType: string; size: number } }>();
    expect(body.data.key).toMatch(/^media-direct\/video\//);
    expect(body.data.mimeType).toBe('video/mp4');
    expect(body.data.size).toBe(4);
    expect([...store.keys()][0]).toBe(body.data.key);
    expect(typeof (putValues[0] as { getReader?: unknown })?.getReader).toBe('function');
  });

  test.each([
    ['audio/mp4', 'm4a'],
    ['audio/mpeg', 'mp3'],
  ] as const)('%s audio is accepted with the truthful extension', async (contentType, extension) => {
    const accepted = makeR2Stub({});
    const app = setupApp(accepted.r2);
    const res = await app.request('/api/images?kind=audio', {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': '2' },
      body: new Uint8Array([1, 2]).buffer,
    });

    expect(res.status).toBe(201);
    expect([...accepted.store.keys()][0]).toMatch(new RegExp(`^media-direct/audio/.+\\.${extension}$`));
  });

  test('unsupported audio content types are rejected before R2', async () => {
    const rejected = makeR2Stub({});
    const rejectedApp = setupApp(rejected.r2);
    const bad = await rejectedApp.request('/api/images?kind=audio', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/ogg' },
      body: new Uint8Array([1]).buffer,
    });
    expect(bad.status).toBe(400);
    expect(rejected.store.size).toBe(0);
  });

  test.each(['image', 'video', 'audio', 'imagemap'] as const)('%s without Content-Length fails loudly before R2 instead of creating an unknown-length stream', async (kind) => {
    const { r2, store, putValues } = makeR2Stub({});
    const suffix = kind === 'imagemap' ? '?kind=imagemap&width=1040' : kind === 'image' ? '' : `?kind=${kind}`;
    const contentType = kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png';
    const res = await setupApp(r2).request(`/api/images${suffix}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array([1]).buffer,
    });

    expect(res.status).toBe(411);
    expect((await res.json<{ error: string }>()).error).toMatch(/Content-Length/);
    expect(store.size).toBe(0);
    expect(putValues).toHaveLength(0);
  });

  test.each(['video', 'audio'] as const)('%s accepts the Cloudflare 100MB request boundary', async (kind) => {
    const { r2, store } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request(`/api/images?kind=${kind}`, {
      method: 'POST',
      headers: {
        'Content-Type': kind === 'video' ? 'video/mp4' : 'audio/mpeg',
        'Content-Length': String(100_000_000),
      },
      // Keep the fixture small: this test pins the preflight boundary while
      // the stream-counting path is covered by the image overage fixture.
      body: new Uint8Array([1]).buffer,
    });

    expect(res.status).toBe(201);
    expect(store.size).toBe(1);
  });

  test.each(['video', 'audio'] as const)('%s rejects Cloudflare 100MB + 1 byte before R2', async (kind) => {
    const { r2, store, putValues } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request(`/api/images?kind=${kind}`, {
      method: 'POST',
      headers: {
        'Content-Type': kind === 'video' ? 'video/mp4' : 'audio/mp4',
        'Content-Length': String(100_000_001),
      },
      body: new Uint8Array([1]).buffer,
    });

    expect(res.status).toBe(413);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/100\s*MB/i);
    expect(store.size).toBe(0);
    expect(putValues).toHaveLength(0);
  });

  test('imagemap accepts an official width and returns a shared baseUrl', async () => {
    const { r2, store } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request('/api/images?kind=imagemap&width=1040', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '3' },
      body: new Uint8Array([1, 2, 3]).buffer,
    });

    expect(res.status).toBe(201);
    const body = await res.json<{ data: { id: string; key: string; url: string; baseUrl: string; width: number } }>();
    expect(body.data.key).toBe(`imagemaps/${body.data.id}/1040`);
    expect(body.data.url).toBe(`${body.data.baseUrl}/1040`);
    expect(body.data.width).toBe(1040);
    expect(store.has(body.data.key)).toBe(true);
  });

  test('all five imagemap variants share one validated id and baseUrl', async () => {
    const { r2, store } = makeR2Stub({});
    const app = setupApp(r2);
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const widths = [240, 300, 460, 700, 1040];
    const baseUrls: string[] = [];

    for (const width of widths) {
      const res = await app.request(`/api/images?kind=imagemap&width=${width}&id=${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '1' },
        body: new Uint8Array([width % 256]).buffer,
      });
      expect(res.status).toBe(201);
      const body = await res.json<{ data: { id: string; key: string; baseUrl: string } }>();
      expect(body.data.id).toBe(id);
      expect(body.data.key).toBe(`imagemaps/${id}/${width}`);
      baseUrls.push(body.data.baseUrl);
    }

    expect(new Set(baseUrls)).toEqual(new Set([`https://w.example.com/images/imagemaps/${id}`]));
    expect([...store.keys()].sort()).toEqual(widths.map((width) => `imagemaps/${id}/${width}`).sort());
  });

  test.each([240, 300, 460, 700, 1040])(
    'imagemap refuses to overwrite an existing %i-width variant',
    async (width) => {
      const id = '123e4567-e89b-42d3-a456-426614174000';
      const key = `imagemaps/${id}/${width}`;
      const { r2, store, putValues } = makeR2Stub({ [key]: { size: 4 } });
      const originalBody = store.get(key)!.body.slice();
      const app = setupApp(r2);

      const res = await app.request(`/api/images?kind=imagemap&width=${width}&id=${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '1' },
        body: new Uint8Array([255]).buffer,
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ success: false, error: 'Imagemap variant already exists' });
      expect(putValues).toHaveLength(0);
      expect(store.get(key)?.body).toEqual(originalBody);
    },
  );

  test('imagemap rejects an unsafe shared upload id before R2', async () => {
    const { r2, store } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request('/api/images?kind=imagemap&width=1040&id=../../media/escape', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([1]).buffer,
    });

    expect(res.status).toBe(400);
    expect(store.size).toBe(0);
  });

  test('imagemap rejects a non-official width before R2', async () => {
    const { r2, store } = makeR2Stub({});
    const app = setupApp(r2);
    const res = await app.request('/api/images?kind=imagemap&width=999', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([1]).buffer,
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/240.*300.*460.*700.*1040/);
    expect(store.size).toBe(0);
  });

  test('direct media is publicly served but never leaks into the image library list', async () => {
    const { r2 } = makeR2Stub({});
    const app = setupApp(r2);
    const requests = [
      ['/api/images?kind=video', 'video/mp4'],
      ['/api/images?kind=audio', 'audio/mpeg'],
      ['/api/images?kind=imagemap&width=1040', 'image/png'],
    ] as const;
    const uploaded: Array<{ key: string; mimeType: string }> = [];

    for (const [path, contentType] of requests) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': '1' },
        body: new Uint8Array([1]).buffer,
      });
      expect(res.status).toBe(201);
      const body = await res.json<{ data: { key: string; mimeType: string } }>();
      uploaded.push(body.data);
    }

    const list = await app.request('/api/images');
    const listBody = await list.json<{ data: { items: unknown[] } }>();
    expect(listBody.data.items).toEqual([]);

    for (const item of uploaded) {
      const served = await app.request(`/images/${item.key}`);
      expect(served.status).toBe(200);
      expect(served.headers.get('Content-Type')).toBe(item.mimeType);
    }
  });
});

describe('serve / delete slash key (T-M3)', () => {
  test('回答添付の private prefix は公開画像 route から取得できない', async () => {
    const key = 'internal-form-submissions/form/field/secret.pdf';
    const { r2 } = makeR2Stub({ [key]: { size: 8 } });
    const app = setupApp(r2);
    const res = await app.request(`/images/${key}`);
    expect(res.status).toBe(404);
  });

  test('GET /images/media/xxx.png (slash key) が serve できる', async () => {
    const { r2 } = makeR2Stub({ 'media/pic.png': { size: 8 } });
    const app = setupApp(r2);
    const res = await app.request('/images/media/pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe('8');
  });

  test.each([
    ['bytes=2-5', 'bytes 2-5/10', 4],
    ['bytes=7-', 'bytes 7-9/10', 3],
    ['bytes=-3', 'bytes 7-9/10', 3],
  ])('動画用 Range %s を R2 部分取得し 206 で返す', async (range, expectedContentRange, expectedLength) => {
    const { r2 } = makeR2Stub({ 'media-direct/video/sample.mp4': { size: 10 } });
    const app = setupApp(r2);
    const res = await app.request('/images/media-direct/video/sample.mp4', {
      headers: { Range: range },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Range')).toBe(expectedContentRange);
    expect(res.headers.get('Content-Length')).toBe(String(expectedLength));
    expect((await res.arrayBuffer()).byteLength).toBe(expectedLength);
  });

  test.each(['bytes=10-', 'bytes=5-3', 'bytes=0-1,4-5', 'items=0-1'])(
    '不正または未対応 Range %s は 416 と全体サイズを返す',
    async (range) => {
      const { r2 } = makeR2Stub({ 'media-direct/video/sample.mp4': { size: 10 } });
      const app = setupApp(r2);
      const res = await app.request('/images/media-direct/video/sample.mp4', {
        headers: { Range: range },
      });

      expect(res.status).toBe(416);
      expect(res.headers.get('Accept-Ranges')).toBe('bytes');
      expect(res.headers.get('Content-Range')).toBe('bytes */10');
    },
  );

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
