/**
 * 配信通数の月次上限ガード (F2 batch4 G2) の共有 helper。
 *
 * 「今月送信数」の計測式は **表示 (line-accounts.ts の messagesThisMonth) と gate (送信入口 + executor)
 * が同一の SQL 式** を使うよう単一化する (owner が信じられる一致・Codex HIGH)。account 帰属は現行表示の
 * friends.line_account_id join を踏襲 (display==entry-gate==executor-gate 不変・送信元帰属
 * messages_log.line_account_id の厳密化は OPTIONAL-POLISH)。JST created_at / date('now')=UTC 境界は
 * 表示との一致を優先して据え置き (境界を作り変えない)。
 *
 * gate 判定: cap==null は常に通す (無制限 = 既定挙動不変 = 誤爆ゼロ)。cap!=null は
 * 「今月送信数 + 今回予定数 > cap」でブロック。test-send も LINE push の消費なので計測する。
 */

/**
 * 表示 (line-accounts.ts) と完全一致の「今月送信数」SQL (byte-identical・単一 source)。
 * outgoing かつ push 系 (delivery_type IS NULL / 'push' / 'test') かつ当月 1 日以降。account 帰属は
 * friends.line_account_id。reply のみ除外する。
 */
export const MESSAGES_THIS_MONTH_SQL = `SELECT COUNT(*) as count FROM messages_log ml
             INNER JOIN friends f ON f.id = ml.friend_id
             WHERE ml.direction = 'outgoing' AND (ml.delivery_type IS NULL OR ml.delivery_type IN ('push', 'test')) AND ml.created_at >= date('now', 'start of month') AND f.line_account_id = ?`;

/** 今月送信数 (表示 messagesThisMonth と同一式)。 */
export async function getMessagesThisMonth(db: D1Database, accountId: string): Promise<number> {
  const row = await db.prepare(MESSAGES_THIS_MONTH_SQL).bind(accountId).first<{ count: number }>();
  return row?.count ?? 0;
}

/** account の月次上限 (未設定 = null = 無制限)。 */
export async function getMonthlyCap(db: D1Database, accountId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT monthly_cap FROM line_accounts WHERE id = ?`).bind(accountId).first<{ monthly_cap: number | null }>();
  const cap = row?.monthly_cap;
  return typeof cap === 'number' ? cap : null;
}

export interface CapCheck {
  /** 送信を許可するか。cap==null は常に true (誤爆ゼロ)。 */
  allowed: boolean;
  /** 今月送信数 (表示 messagesThisMonth と同一計測)。 */
  count: number;
  /** 上限 (null = 無制限)。 */
  cap: number | null;
  /** 今回の送信予定数。 */
  pending: number;
  /** 残り送信可能数 (cap - count・cap==null は null)。 */
  remaining: number | null;
}

/**
 * 上限ガード判定。cap==null → 常に通す。cap!=null → (count + pending) > cap でブロック。
 * accountId が無い (single-channel フォールバック等) 場合は無制限扱い (既定挙動不変)。
 */
export async function checkMonthlyCap(
  db: D1Database,
  accountId: string | null | undefined,
  pending = 0,
): Promise<CapCheck> {
  if (!accountId) return { allowed: true, count: 0, cap: null, pending, remaining: null };
  const [count, cap] = await Promise.all([getMessagesThisMonth(db, accountId), getMonthlyCap(db, accountId)]);
  if (cap === null) return { allowed: true, count, cap: null, pending, remaining: null };
  return { allowed: count + pending <= cap, count, cap, pending, remaining: cap - count };
}
