import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  createLpPage,
  getLpPageBySlug,
  listLpPages,
  updateLpPageStatus,
  setLpPageEntryKey,
  deleteLpPage,
  recordLpView,
  getLpViews,
  countLpViews,
  getFriendById,
} from '@line-crm/db';
import { verifyLpViewToken } from '../services/lp-view-token.js';

// =============================================================================
// LP hosting route (harness-lp-hosting / Phase 1)
// -----------------------------------------------------------------------------
// 公開 (無認証): GET /lp/:slug (index) / GET /lp/:slug/:asset{.+} (asset)。
//   authMiddleware は非 /api かつ内部除外リスト非該当のパスを公開扱いにする (/lp は無改変で公開)。
// admin (認証): /api/lp/* (C4) は permissionMiddleware で 'analytics' feature gate。
//
// 安全 (§spec 5.2 / D-4): LP レスポンスに厳格 CSP (connect-src 'none' 等) を付与し、同一オリジンの
//   admin API への session-riding (毒 LP JS の credentialed fetch) を構造的に遮断する。
// R2 実体は既存 IMAGES バケットの lp/<slug>/ prefix に置く (媒体 bytes は public repo に置かない / D-1)。
// =============================================================================

/** LP 用の厳格 CSP。connect-src 'none' で LP から admin API への fetch を遮断 (session-riding 無効化)。 */
const LP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: https:",
  "font-src 'self' data: https:",
  "media-src 'self' https:",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** 公開 slug の許可形: 先頭英数字 + [a-z0-9-] 1..64 文字 (大文字/記号/'..'/'_' を拒否 = R2 key 脱出防止の 1 次防御)。 */
export const LP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isValidLpSlug(slug: string): boolean {
  return LP_SLUG_RE.test(slug);
}

/** R2 key prefix。 */
export function lpPrefix(slug: string): string {
  return `lp/${slug}/`;
}

/**
 * asset path を安全な R2 key に正規化。'..'/'.'/空/絶対/バックスラッシュ セグメントは null で拒否
 * (lp/<slug>/ prefix を脱出できない)。呼び出し側は null を 404 にする。
 */
export function safeAssetKey(slug: string, assetPath: string): string | null {
  if (!isValidLpSlug(slug) || !assetPath) return null;
  const parts = assetPath.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.includes('\\')) return null;
  }
  const key = `${lpPrefix(slug)}${parts.join('/')}`;
  // 防御的再確認: 正規化後も prefix 内に留まる
  return key.startsWith(lpPrefix(slug)) ? key : null;
}

const EXT_CONTENT_TYPE: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

export function contentTypeForKey(key: string, fallback = 'application/octet-stream'): string {
  const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXT_CONTENT_TYPE[ext] ?? fallback;
}

/** upload 許可拡張子 (LP に必要な静的アセットのみ / 実行系・任意 binary を拒否 / GAP-4)。 */
export const ALLOWED_UPLOAD_EXT = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'map', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
  'woff', 'woff2', 'ttf', 'otf',
]);

/** 1 ファイル上限 (images.ts の 10MB より厳しめ・LP アセット想定)。 */
export const MAX_LP_FILE_BYTES = 5 * 1024 * 1024;

/** R2 object を LP 用 CSP ヘッダ付きで配信する Response を組む。 */
function serveObject(object: R2ObjectBody, contentType: string): Response {
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || contentType);
  headers.set('Content-Security-Policy', LP_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'public, max-age=300');
  if (object.etag) headers.set('ETag', object.etag);
  return new Response(object.body, { headers });
}

const lp = new Hono<Env>();

// ── 公開 asset serve: GET /lp/:slug/:asset{.+} (:slug より前に登録して 3+ セグメントを拾う) ──
lp.get('/lp/:slug/:asset{.+}', async (c) => {
  const slug = c.req.param('slug');
  const assetPath = c.req.param('asset');
  const key = safeAssetKey(slug, assetPath);
  if (!key) return c.notFound();

  const page = await getLpPageBySlug(c.env.DB, slug);
  if (!page || page.status !== 'active') return c.notFound();

  const object = await c.env.IMAGES.get(key);
  if (!object) return c.notFound();
  return serveObject(object as R2ObjectBody, contentTypeForKey(key));
});

// ── 公開 index serve + 閲覧記録: GET /lp/:slug ──
lp.get('/lp/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidLpSlug(slug)) return c.notFound();

  const page = await getLpPageBySlug(c.env.DB, slug);
  if (!page || page.status !== 'active') return c.notFound();

  const key = page.entry_key || `${lpPrefix(slug)}index.html`;
  const object = await c.env.IMAGES.get(key);
  if (!object) return c.notFound();

  // ── 閲覧記録 (§spec J・T-C1/T-C2/D-5): 匿名は必ず記録・有効トークン時のみ friend 紐付き ──
  // ?v=<token> は AES-GCM opaque envelope (生 friendId を URL に載せない / PII ゼロ)。
  // 検証失敗・別 slug 向け・friend 不在 = すべて匿名 degrade (誤 attribution を作らない / fail-closed)。
  let friendId: string | null = null;
  let friendName: string | null = null;
  const token = c.req.query('v');
  if (token) {
    const secret = c.env.FORMALOO_FRIEND_TOKEN_SECRET; // OD-LP-3 推奨: 既存 secret 派生 (AES-GCM 鍵は別導出)
    const claims = await verifyLpViewToken(token, secret);
    if (claims && claims.lpSlug === slug) {
      try {
        const fr = await getFriendById(c.env.DB, claims.friendId);
        if (fr) {
          friendId = fr.id;
          friendName = fr.display_name ?? null;
        }
        // fr 不在 = 未検証 ID を紐付けない (匿名 degrade / T-C2)
      } catch (err) {
        // transient D1 等は fail-closed で匿名 (誤 attribution を作らない)
        console.error(`/lp/${slug} friend resolve failed (non-blocking):`, err);
        friendId = null;
        friendName = null;
      }
    }
  }

  // 記録は best-effort (transient 失敗は配信を止めない) が、成功経路は test が D1 実測で assert (soft-200 禁止)。
  try {
    await recordLpView(c.env.DB, {
      lpSlug: slug,
      friendId,
      friendName,
      referrer: c.req.header('Referer') ?? null,
    });
  } catch (err) {
    console.error(`/lp/${slug} lp_views insert failed (non-blocking):`, err);
  }

  return serveObject(object as R2ObjectBody, 'text/html; charset=utf-8');
});

// =============================================================================
// admin CRUD (認証必須 / permissionMiddleware で 'analytics' gate / T-A2/A3/A5/A6/A9・T-C3)
// =============================================================================

/** 公開 URL (owner がコピーして配布する) = worker origin + /lp/<slug>。 */
function lpPublicUrl(c: { env: Env['Bindings']; req: { url: string } }, slug: string): string {
  const origin = c.env.WORKER_URL || new URL(c.req.url).origin;
  return `${origin}/lp/${slug}`;
}

/** R2 prefix の全 object を cursor pagination で削除 (1000 件 cutoff を跨いで orphan bytes を残さない / T-A6・GAP-3)。 */
async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

// POST /api/lp — LP を登録 (slug + title)。公開 URL を返す。
lp.post('/api/lp', async (c) => {
  const body = await c.req.json<{ slug?: string; title?: string }>().catch(() => ({}));
  const slug = (body.slug ?? '').trim().toLowerCase();
  const title = (body.title ?? '').trim();
  if (!isValidLpSlug(slug)) {
    return c.json({ success: false, error: 'slug は英小文字・数字・ハイフンのみ (先頭は英数字・64 文字以内)' }, 400);
  }
  if (!title) return c.json({ success: false, error: 'title は必須です' }, 400);
  if (await getLpPageBySlug(c.env.DB, slug)) {
    return c.json({ success: false, error: 'この slug は既に使われています' }, 409);
  }
  const page = await createLpPage(c.env.DB, { slug, title });
  return c.json({ success: true, data: { ...page, url: lpPublicUrl(c, slug) } }, 201);
});

// GET /api/lp — 一覧 (?status=active で公開中のみ = route-phase2 picker が消費する形 / T-B1)。
//   各行に公開 URL + 閲覧数 (総数/紐付き) を含める (admin 最小ビュー / T-C3・K)。
lp.get('/api/lp', async (c) => {
  const statusFilter = c.req.query('status');
  const pages = await listLpPages(c.env.DB);
  const filtered = statusFilter ? pages.filter((p) => p.status === statusFilter) : pages;
  const items = await Promise.all(
    filtered.map(async (p) => ({
      slug: p.slug,
      title: p.title,
      status: p.status,
      entry_key: p.entry_key,
      created_at: p.created_at,
      updated_at: p.updated_at,
      url: lpPublicUrl(c, p.slug),
      views: await countLpViews(c.env.DB, p.slug),
    })),
  );
  return c.json({ success: true, data: { items } });
});

// GET /api/lp/:slug — 単体 (+ 閲覧数)。
lp.get('/api/lp/:slug', async (c) => {
  const slug = c.req.param('slug');
  const page = await getLpPageBySlug(c.env.DB, slug);
  if (!page) return c.json({ success: false, error: '見つかりません' }, 404);
  return c.json({
    success: true,
    data: { ...page, url: lpPublicUrl(c, slug), views: await countLpViews(c.env.DB, slug) },
  });
});

// GET /api/lp/:slug/views — 直近閲覧 (friend 名/時刻) + count (総数/紐付き)。admin 詳細ビュー (T-C3)。
lp.get('/api/lp/:slug/views', async (c) => {
  const slug = c.req.param('slug');
  const page = await getLpPageBySlug(c.env.DB, slug);
  if (!page) return c.json({ success: false, error: '見つかりません' }, 404);
  const views = await getLpViews(c.env.DB, slug);
  const counts = await countLpViews(c.env.DB, slug);
  return c.json({ success: true, data: { views, counts } });
});

// PATCH /api/lp/:slug — 公開停止/再開 (status flip が serve を制御 / T-A5)。
lp.patch('/api/lp/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<{ status?: string }>().catch(() => ({}));
  const page = await getLpPageBySlug(c.env.DB, slug);
  if (!page) return c.json({ success: false, error: '見つかりません' }, 404);
  if (body.status !== 'active' && body.status !== 'stopped') {
    return c.json({ success: false, error: 'status は active か stopped です' }, 400);
  }
  const updated = await updateLpPageStatus(c.env.DB, slug, body.status);
  return c.json({ success: true, data: { ...updated, url: lpPublicUrl(c, slug) } });
});

// DELETE /api/lp/:slug — registry 削除 + R2 prefix 実体を全削除 (dangling bytes を残さない / T-A6)。
lp.delete('/api/lp/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidLpSlug(slug)) return c.json({ success: false, error: '不正な slug' }, 400);
  await deleteR2Prefix(c.env.IMAGES, lpPrefix(slug));
  await deleteLpPage(c.env.DB, slug);
  return c.json({ success: true, data: null });
});

// POST /api/lp/:slug/files — LP ファイルを R2 lp/<slug>/ prefix に upload (multipart form-data)。
//   size 上限 + 拡張子 allowlist gate (任意巨大/実行系 binary を拒否 / T-A3・GAP-4)。
//   index.html は entry_key に記録 (公開 serve が参照)。path フィールドでネスト配置可 (img/hero.png)。
lp.post('/api/lp/:slug/files', async (c) => {
  const slug = c.req.param('slug');
  if (!isValidLpSlug(slug)) return c.json({ success: false, error: '不正な slug' }, 400);
  const page = await getLpPageBySlug(c.env.DB, slug);
  if (!page) return c.json({ success: false, error: '先に LP を登録してください' }, 404);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ success: false, error: 'multipart form-data が必要です' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ success: false, error: 'file フィールドが必要です' }, 400);

  const relPath = (typeof form.get('path') === 'string' ? (form.get('path') as string) : '') || file.name;
  const key = safeAssetKey(slug, relPath);
  if (!key) return c.json({ success: false, error: '不正なファイル名 (traversal 不可)' }, 400);

  const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!ALLOWED_UPLOAD_EXT.has(ext)) {
    return c.json({ success: false, error: `許可されていない拡張子: .${ext}` }, 400);
  }
  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_LP_FILE_BYTES) {
    return c.json({ success: false, error: 'ファイルが大きすぎます (上限 5MB)' }, 400);
  }

  await c.env.IMAGES.put(key, buf, { httpMetadata: { contentType: contentTypeForKey(key) } });
  if (key === `${lpPrefix(slug)}index.html`) {
    await setLpPageEntryKey(c.env.DB, slug, key);
  }
  return c.json({ success: true, data: { key, size: buf.byteLength } }, 201);
});

export { lp };
