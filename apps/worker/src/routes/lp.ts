import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  getLpPageBySlug,
  recordLpView,
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

export { lp };
