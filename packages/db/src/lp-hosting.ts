import { jstNow } from './utils.js';
// =============================================================================
// LP hosting — LP 置き場 registry (lp_pages) + 閲覧計測 (lp_views) の D1 accessor。
// -----------------------------------------------------------------------------
// LP 実体 (HTML/asset bytes) は R2 (lp/<slug>/ prefix)・ここは metadata と閲覧イベントのみ (D-1)。
// 記録は soft に消さない: recordLpView は必ず 1 行 INSERT する (匿名も含む / §spec J・D-5)。
// =============================================================================

export type LpPageStatus = 'active' | 'stopped';

export interface LpPage {
  slug: string;
  title: string;
  status: LpPageStatus;
  /** index.html の R2 key (未 upload は null)。 */
  entry_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface LpView {
  id: string;
  lp_slug: string;
  friend_id: string | null;
  friend_name: string | null;
  referrer: string | null;
  viewed_at: string;
}

export interface LpViewCounts {
  /** 総閲覧数 (匿名 + 紐付き)。 */
  total: number;
  /** friend 紐付き閲覧数 (friend_id NOT NULL)。 */
  friendBound: number;
}

// ── lp_pages CRUD ─────────────────────────────────────────────────────────────

export interface CreateLpPageInput {
  slug: string;
  title: string;
  entryKey?: string | null;
}

export async function createLpPage(db: D1Database, input: CreateLpPageInput): Promise<LpPage> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO lp_pages (slug, title, status, entry_key, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
    )
    .bind(input.slug, input.title, input.entryKey ?? null, now, now)
    .run();
  return (await getLpPageBySlug(db, input.slug))!;
}

export async function getLpPageBySlug(db: D1Database, slug: string): Promise<LpPage | null> {
  return db.prepare(`SELECT * FROM lp_pages WHERE slug = ?`).bind(slug).first<LpPage>();
}

export async function listLpPages(db: D1Database): Promise<LpPage[]> {
  const result = await db
    .prepare(`SELECT * FROM lp_pages ORDER BY created_at DESC`)
    .all<LpPage>();
  return result.results;
}

export async function updateLpPageStatus(
  db: D1Database,
  slug: string,
  status: LpPageStatus,
): Promise<LpPage | null> {
  const existing = await getLpPageBySlug(db, slug);
  if (!existing) return null;
  await db
    .prepare(`UPDATE lp_pages SET status = ?, updated_at = ? WHERE slug = ?`)
    .bind(status, jstNow(), slug)
    .run();
  return getLpPageBySlug(db, slug);
}

/** index.html upload 時に entry_key を記録 (public serve が参照する)。 */
export async function setLpPageEntryKey(
  db: D1Database,
  slug: string,
  entryKey: string,
): Promise<LpPage | null> {
  const existing = await getLpPageBySlug(db, slug);
  if (!existing) return null;
  await db
    .prepare(`UPDATE lp_pages SET entry_key = ?, updated_at = ? WHERE slug = ?`)
    .bind(entryKey, jstNow(), slug)
    .run();
  return getLpPageBySlug(db, slug);
}

/** registry 行を削除 (R2 実体の削除は route 側で prefix 全 object を消す / T-A6)。 */
export async function deleteLpPage(db: D1Database, slug: string): Promise<void> {
  await db.prepare(`DELETE FROM lp_pages WHERE slug = ?`).bind(slug).run();
}

// ── lp_views 記録 ─────────────────────────────────────────────────────────────

export interface RecordLpViewInput {
  lpSlug: string;
  friendId?: string | null;
  friendName?: string | null;
  referrer?: string | null;
}

export async function recordLpView(db: D1Database, input: RecordLpViewInput): Promise<LpView> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO lp_views (id, lp_slug, friend_id, friend_name, referrer, viewed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.lpSlug, input.friendId ?? null, input.friendName ?? null, input.referrer ?? null, now)
    .run();
  return (await db.prepare(`SELECT * FROM lp_views WHERE id = ?`).bind(id).first<LpView>())!;
}

/** 直近閲覧を new→old で返す (admin 詳細ビュー / K)。 */
export async function getLpViews(db: D1Database, slug: string, limit = 50): Promise<LpView[]> {
  const result = await db
    .prepare(`SELECT * FROM lp_views WHERE lp_slug = ? ORDER BY viewed_at DESC LIMIT ?`)
    .bind(slug, limit)
    .all<LpView>();
  return result.results;
}

/** 総閲覧数と friend 紐付き閲覧数を分離して返す (admin 最小ビュー / K・T-C3)。 */
export async function countLpViews(db: D1Database, slug: string): Promise<LpViewCounts> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN friend_id IS NOT NULL THEN 1 ELSE 0 END) AS friendBound
       FROM lp_views WHERE lp_slug = ?`,
    )
    .bind(slug)
    .first<{ total: number; friendBound: number | null }>();
  return { total: row?.total ?? 0, friendBound: row?.friendBound ?? 0 };
}
