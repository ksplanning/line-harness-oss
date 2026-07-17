/**
 * lp route mount (harness-lp-hosting / T-A8) — index.ts の app に lp route が登録され、
 * ASSETS/not-found catch-all より前に処理されることを app.routes 静的検査で固定する。
 * (Hono は登録済み route を notFound より先に評価する = 登録されていれば catch-all に食われない。)
 * /api/lp の permission-map 網羅 (M-15) は permission-map.test.ts が app 全体で担保する。
 */
import { describe, expect, test } from 'vitest';
import { app } from '../index.js';

describe('lp route が app に mount されている (T-A8)', () => {
  const paths = new Set(app.routes.map((r) => r.path));

  test('公開 serve route (/lp/:slug, /lp/:slug/:asset{.+}) が登録済み', () => {
    expect(paths.has('/lp/:slug')).toBe(true);
    expect(paths.has('/lp/:slug/:asset{.+}')).toBe(true);
  });

  test('admin API route (/api/lp, /api/lp/:slug 系) が登録済み', () => {
    expect(paths.has('/api/lp')).toBe(true);
    expect(paths.has('/api/lp/:slug')).toBe(true);
    expect(paths.has('/api/lp/:slug/files')).toBe(true);
    expect(paths.has('/api/lp/:slug/views')).toBe(true);
  });
});
