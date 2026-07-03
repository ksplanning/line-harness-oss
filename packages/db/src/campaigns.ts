import { jstNow } from './utils.js';

/**
 * F2 G3 キャンペーン集計 — 複数の配信 (broadcasts.campaign_id で紐付け) を1つのキャンペーンとして
 * 束ね、まとめて成果を見る。account-scoped (account_id NOT NULL)。送信には関与しない。
 */

export interface Campaign {
  id: string;
  account_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export async function listCampaigns(db: D1Database, accountId: string): Promise<Campaign[]> {
  const result = await db
    .prepare('SELECT * FROM campaigns WHERE account_id = ? ORDER BY created_at DESC')
    .bind(accountId)
    .all<Campaign>();
  return result.results;
}

export async function getCampaignById(db: D1Database, id: string): Promise<Campaign | null> {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<Campaign>();
}

export async function createCampaign(
  db: D1Database,
  input: { accountId: string; name: string },
): Promise<Campaign> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const result = await db
    .prepare(
      'INSERT INTO campaigns (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
    )
    .bind(id, input.accountId, input.name, now, now)
    .first<Campaign>();
  return result!;
}

export async function renameCampaign(
  db: D1Database,
  id: string,
  name: string,
): Promise<Campaign | null> {
  return db
    .prepare('UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ? RETURNING *')
    .bind(name, jstNow(), id)
    .first<Campaign>();
}

export async function deleteCampaign(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM campaigns WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

/**
 * 配信をキャンペーンに紐付け/解除する。campaignId=null で解除。
 * 同 account の配信のみ更新できるよう accountId でガード (別 account の配信は動かさない)。
 * broadcasts.line_account_id (単一 account) と一致する配信のみ対象。
 */
export async function linkBroadcastToCampaign(
  db: D1Database,
  broadcastId: string,
  campaignId: string | null,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE broadcasts SET campaign_id = ? WHERE id = ? AND line_account_id = ?')
    .bind(campaignId, broadcastId, accountId)
    .run();
  return result.meta.changes > 0;
}

export interface CampaignBroadcastSummary {
  broadcastId: string;
  title: string | null;
  sentAt: string | null;
  /** この配信の対象数 (total_count)。 */
  targetCount: number;
  /** 開封 (unique_impression)。insight 未取得なら null。 */
  opened: number | null;
  /** クリック (unique_click)。insight 未取得なら null。 */
  clicked: number | null;
}

export interface CampaignAggregate {
  broadcastCount: number;
  totalTarget: number;
  totalOpened: number | null;
  totalClicked: number | null;
  broadcasts: CampaignBroadcastSummary[];
}

/**
 * キャンペーンに紐付いた配信の per-broadcast 成果を返す (pre-aggregate)。
 *
 * broadcast_insights × messages_log を直 JOIN すると行の掛け算 (fan-out) で膨張するため、
 * broadcast 単位で最新 insight を 1 行だけ引く (相関サブクエリで created_at DESC の 1 件)。
 * 紐付いていない配信 (campaign_id != この id) は一切含めない。
 */
export async function getCampaignBroadcasts(
  db: D1Database,
  campaignId: string,
): Promise<CampaignBroadcastSummary[]> {
  const result = await db
    .prepare(
      `SELECT
         b.id            AS broadcast_id,
         b.title         AS title,
         b.sent_at       AS sent_at,
         b.total_count   AS target_count,
         bi.unique_impression AS opened,
         bi.unique_click      AS clicked
       FROM broadcasts b
       LEFT JOIN broadcast_insights bi
         ON bi.id = (
           SELECT id FROM broadcast_insights
            WHERE broadcast_id = b.id
            ORDER BY created_at DESC
            LIMIT 1
         )
       WHERE b.campaign_id = ?
       ORDER BY COALESCE(b.sent_at, b.created_at) DESC`,
    )
    .bind(campaignId)
    .all<{
      broadcast_id: string;
      title: string | null;
      sent_at: string | null;
      target_count: number | null;
      opened: number | null;
      clicked: number | null;
    }>();

  return result.results.map((r) => ({
    broadcastId: r.broadcast_id,
    title: r.title,
    sentAt: r.sent_at,
    targetCount: r.target_count ?? 0,
    opened: r.opened,
    clicked: r.clicked,
  }));
}

/**
 * per-broadcast 成果を JS 側で合算する (pre-aggregate → campaign 合算)。
 * opened/clicked は少なくとも 1 本 insight があれば合算値を返す (insight 無しの配信は 0 として
 * 加算せず null 扱い — ただし合計は「取得済み分の合計」として返し、全て null なら null)。
 */
export async function getCampaignAggregate(
  db: D1Database,
  campaignId: string,
): Promise<CampaignAggregate> {
  const broadcasts = await getCampaignBroadcasts(db, campaignId);
  const totalTarget = broadcasts.reduce((s, b) => s + b.targetCount, 0);

  const openedVals = broadcasts.map((b) => b.opened).filter((v): v is number => v !== null);
  const clickedVals = broadcasts.map((b) => b.clicked).filter((v): v is number => v !== null);

  return {
    broadcastCount: broadcasts.length,
    totalTarget,
    totalOpened: openedVals.length > 0 ? openedVals.reduce((s, v) => s + v, 0) : null,
    totalClicked: clickedVals.length > 0 ? clickedVals.reduce((s, v) => s + v, 0) : null,
    broadcasts,
  };
}
