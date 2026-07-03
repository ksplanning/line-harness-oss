import { Hono } from 'hono';
import type { Context } from 'hono';
import { toCsv } from '@line-crm/shared';
import type { Env } from '../index.js';

/**
 * CSV エクスポート (batch3 G39 / 友だち・フォーム回答・予約)。
 *
 * - 出力は BOM 付き UTF-8 + CRLF + RFC4180 (packages/shared の toCsv 正典)。
 * - CSV injection は toCsv の sanitize (既定 ON) で無害化 (codex gap-check HIGH-2)。
 * - 収集は全件クエリ。上限 (MAX_ROWS) 超過は 400、生成 byte 超過は 413 で worker OOM を防ぐ
 *   (codex gap-check MED-1)。
 * - route は既存 `/api/friends/:id` 等の dynamic route と衝突しない **`/api/exports/`
 *   専用 namespace** に置く (codex gap-check MED-3)。
 * - account scope: friends / bookings は account 必須 (HIGH-1)。form-submissions は
 *   form が一次スコープ・account は任意の defense-in-depth filter。
 */

const csvExports = new Hono<Env>();

// 1 リクエストで返す最大行数。超過は 400 (絞り込み案内)。TRINA 実データは friends=1 のため実質発火せず。
const MAX_ROWS = 50_000;
// 生成 CSV の byte 上限 (20MB)。form_submissions.data / customer_note は TEXT 無制限のため
// 行数だけでは足りない (MED-1)。
const MAX_BYTES = 20 * 1024 * 1024;

const TOO_MANY_ROWS_MESSAGE =
  '件数が多すぎて一度に出力できません（上限 5万件）。絞り込み（タグ・期間・フォーム）で件数を減らしてから、もう一度お試しください。';
const TOO_LARGE_MESSAGE =
  'データ量が大きすぎて一度に出力できません。絞り込みで対象を減らしてから、もう一度お試しください。';

/** JST の YYYYMMDD (ファイル名用)。 */
function jstDateStamp(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60_000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** ファイル名に使えない文字を全角/削除で無害化 (Content-Disposition 事故防止)。 */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80);
}

/** CSV テキストを attachment レスポンスにして返す (BOM/上限チェック込み)。 */
function csvResponse(
  c: Context<Env>,
  headers: readonly string[],
  rows: unknown[][],
  filename: string,
) {
  if (rows.length > MAX_ROWS) {
    return c.json({ success: false, error: TOO_MANY_ROWS_MESSAGE }, 400);
  }
  const csvText = toCsv(headers, rows); // BOM + CRLF + RFC4180 + injection sanitize
  const bytes = new TextEncoder().encode(csvText);
  if (bytes.length > MAX_BYTES) {
    return c.json({ success: false, error: TOO_LARGE_MESSAGE }, 413);
  }
  return c.body(csvText, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFilename(filename))}`,
  });
}

// ---- 友だち (F2-1) ----
// GET /api/exports/friends.csv?lineAccountId=X[&tagId=&search=]
csvExports.get('/api/exports/friends.csv', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (!lineAccountId) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }
    const tagId = c.req.query('tagId');
    const search = c.req.query('search');

    const conditions = ['f.line_account_id = ?'];
    const binds: unknown[] = [lineAccountId];
    if (tagId) {
      conditions.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(tagId);
    }
    if (search) {
      conditions.push('f.display_name LIKE ?');
      binds.push(`%${search}%`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    // タグは相関サブクエリの GROUP_CONCAT で一括取得 (N+1 回避 / MED-1)。
    const result = await c.env.DB
      .prepare(
        `SELECT f.display_name, f.line_user_id, f.is_following, f.score, f.created_at,
                (SELECT GROUP_CONCAT(t.name, ';')
                   FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id
                  WHERE ft.friend_id = f.id) AS tag_names
           FROM friends f
           ${where}
          ORDER BY f.created_at DESC
          LIMIT ?`,
      )
      .bind(...binds, MAX_ROWS + 1)
      .all<{
        display_name: string | null;
        line_user_id: string;
        is_following: number;
        score: number;
        created_at: string;
        tag_names: string | null;
      }>();

    const headers = ['表示名', 'ユーザーID', 'フォロー中', 'スコア', '登録日', 'タグ'];
    const rows = result.results.map((r) => [
      r.display_name ?? '',
      r.line_user_id,
      r.is_following ? 'はい' : 'いいえ',
      r.score,
      r.created_at,
      r.tag_names ?? '',
    ]);

    return csvResponse(c, headers, rows, `友だち一覧_${jstDateStamp()}.csv`);
  } catch (err) {
    console.error('GET /api/exports/friends.csv error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ---- フォーム回答 (F2-2) ----
// GET /api/exports/form-submissions.csv?formId=X[&lineAccountId=Y]
// form が一次スコープ。lineAccountId 指定時は friends.line_account_id で追加フィルタ
// (別 account の回答が混ざらない defense-in-depth / HIGH-1)。
csvExports.get('/api/exports/form-submissions.csv', async (c) => {
  try {
    const formId = c.req.query('formId');
    if (!formId) {
      return c.json({ success: false, error: 'formId is required' }, 400);
    }
    const lineAccountId = c.req.query('lineAccountId');

    const form = await c.env.DB
      .prepare(`SELECT id, name, fields FROM forms WHERE id = ?`)
      .bind(formId)
      .first<{ id: string; name: string; fields: string }>();
    if (!form) {
      return c.json({ success: false, error: 'Form not found' }, 404);
    }

    const fields = JSON.parse(form.fields || '[]') as Array<{ name: string; label?: string }>;

    const conditions = ['fs.form_id = ?'];
    const binds: unknown[] = [formId];
    let join = 'LEFT JOIN friends f ON f.id = fs.friend_id';
    if (lineAccountId) {
      // account 指定時は該当 account の friend の回答のみ (匿名/別 account は除外)。
      join = 'INNER JOIN friends f ON f.id = fs.friend_id';
      conditions.push('f.line_account_id = ?');
      binds.push(lineAccountId);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const result = await c.env.DB
      .prepare(
        `SELECT fs.data, fs.created_at, f.display_name AS friend_name
           FROM form_submissions fs
           ${join}
           ${where}
          ORDER BY fs.created_at DESC
          LIMIT ?`,
      )
      .bind(...binds, MAX_ROWS + 1)
      .all<{ data: string; created_at: string; friend_name: string | null }>();

    const headers = ['回答日時', '友だち表示名', ...fields.map((f) => f.label || f.name)];
    const rows = result.results.map((r) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(r.data || '{}') as Record<string, unknown>;
      } catch {
        data = {};
      }
      return [
        r.created_at,
        r.friend_name ?? '',
        ...fields.map((f) => normalizeAnswer(data[f.name])),
      ];
    });

    const formLabel = sanitizeFilename(form.name);
    return csvResponse(c, headers, rows, `フォーム回答_${formLabel}_${jstDateStamp()}.csv`);
  } catch (err) {
    console.error('GET /api/exports/form-submissions.csv error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** フォーム回答値 (文字列/配列/オブジェクト) をセル文字列へ正規化する。 */
function normalizeAnswer(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---- 予約 (F2-3) ----
// GET /api/exports/bookings.csv?account_id=X[&status=Y]
csvExports.get('/api/exports/bookings.csv', async (c) => {
  try {
    const accountId = c.req.query('account_id');
    if (!accountId) {
      return c.json({ success: false, error: 'account_id is required' }, 400);
    }
    const status = c.req.query('status');

    const conditions = ['b.line_account_id = ?'];
    const binds: unknown[] = [accountId];
    if (status && status !== 'all') {
      conditions.push('b.status = ?');
      binds.push(status);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const result = await c.env.DB
      .prepare(
        `SELECT b.starts_at, m.name AS menu_name, s.display_name AS staff_name,
                f.display_name AS friend_name, b.status, b.created_at
           FROM bookings b
           INNER JOIN menus m ON m.id = b.menu_id
           INNER JOIN staff s ON s.id = b.staff_id
           LEFT JOIN friends f ON f.id = b.friend_id
           ${where}
          ORDER BY b.starts_at ASC
          LIMIT ?`,
      )
      .bind(...binds, MAX_ROWS + 1)
      .all<{
        starts_at: string;
        menu_name: string;
        staff_name: string | null;
        friend_name: string | null;
        status: string;
        created_at: string;
      }>();

    const headers = ['予約日時', 'メニュー名', 'スタッフ名', '友だち名', 'ステータス', '作成日時'];
    const rows = result.results.map((r) => [
      r.starts_at,
      r.menu_name,
      r.staff_name ?? '',
      r.friend_name ?? '',
      BOOKING_STATUS_LABEL[r.status] ?? r.status,
      r.created_at,
    ]);

    return csvResponse(c, headers, rows, `予約一覧_${jstDateStamp()}.csv`);
  } catch (err) {
    console.error('GET /api/exports/bookings.csv error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

const BOOKING_STATUS_LABEL: Record<string, string> = {
  requested: '承認待ち',
  confirmed: '確定',
  rejected: '拒否',
  expired: '期限切れ',
  cancelled: 'キャンセル',
  completed: '完了',
  no_show: '無断キャンセル',
};

export { csvExports };
