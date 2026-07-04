/**
 * ab_tests (A/B テスト配信) の db model — F2 batch4 G1。
 *
 * account-scoped (account_id)。broadcasts.ab_test_id / ab_variant で案 A/B の配信を紐付ける。
 * 決定論的な audience 分割・比較・勝ち選定は worker services/ab-split.ts + routes/ab-tests.ts。
 * 実 A/B 分割送信・勝ち全配信の実発火は owner 立会 gated (本 model は表の CRUD のみ・送信しない)。
 */

export type AbMetric = 'open_rate' | 'click_rate';
export type AbStatus = 'draft' | 'running' | 'decided';

export interface AbTest {
  id: string;
  account_id: string;
  name: string;
  metric: AbMetric;
  status: AbStatus;
  winner_broadcast_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 自 account に属する A/B テストのみ取得 (別 account の id は null)。 */
export async function getAbTestById(db: D1Database, id: string, accountId: string): Promise<AbTest | null> {
  return db
    .prepare(`SELECT * FROM ab_tests WHERE id = ? AND account_id = ?`)
    .bind(id, accountId)
    .first<AbTest>();
}

/** account-scoped 一覧 (別 account のテストは出ない)。 */
export async function listAbTests(db: D1Database, accountId: string): Promise<AbTest[]> {
  const r = await db
    .prepare(`SELECT * FROM ab_tests WHERE account_id = ? ORDER BY created_at DESC`)
    .bind(accountId)
    .all<AbTest>();
  return r.results;
}

export async function createAbTest(
  db: D1Database,
  input: { accountId: string; name: string; metric: AbMetric },
): Promise<AbTest> {
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO ab_tests (id, account_id, name, metric) VALUES (?, ?, ?, ?)`)
    .bind(id, input.accountId, input.name, input.metric)
    .run();
  return (await getAbTestById(db, id, input.accountId))!;
}

/** account-scoped update (別 account の行は WHERE で除外され更新されない)。updated_at を JST で刻む。 */
export async function updateAbTest(
  db: D1Database,
  id: string,
  accountId: string,
  updates: { name?: string; metric?: AbMetric; status?: AbStatus; winnerBroadcastId?: string | null },
): Promise<AbTest | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.metric !== undefined) { fields.push('metric = ?'); values.push(updates.metric); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.winnerBroadcastId !== undefined) { fields.push('winner_broadcast_id = ?'); values.push(updates.winnerBroadcastId); }
  if (fields.length > 0) {
    fields.push(`updated_at = (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))`);
    values.push(id, accountId);
    await db
      .prepare(`UPDATE ab_tests SET ${fields.join(', ')} WHERE id = ? AND account_id = ?`)
      .bind(...values)
      .run();
  }
  return getAbTestById(db, id, accountId);
}

/** account-scoped delete (別 account の行は消えない)。 */
export async function deleteAbTest(db: D1Database, id: string, accountId: string): Promise<void> {
  await db.prepare(`DELETE FROM ab_tests WHERE id = ? AND account_id = ?`).bind(id, accountId).run();
}
