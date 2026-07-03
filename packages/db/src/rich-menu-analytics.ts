/**
 * F2 G58 リッチメニュータップ数分析 (案A: postback系 read-only 集計)。
 *
 * 計測モデルの制約 (webhook.ts:412 実読):
 *   - postback タップは messages_log source='postback' に content = 生の action_data 文字列
 *     (event.postback.data) / line_account_id / created_at (JST・%Y-%m-%dT%H:%M:%f = ミリ秒付き)
 *     で記録される。
 *   - URI/message タップは per-area 記録なし → 数えられない (計測範囲注記で明示)。
 *
 * area 帰属の正しさ (Codex 独立指摘反映):
 *   - 対象 = 選択 group の area の action_data (postback の場合 actionData.data) に一致する
 *     postback タップのみ。
 *   - area 帰属は「選択 group 内で action_data(=data) が一意な場合のみ」。同一 data が group 内の
 *     複数 area に存在する場合は「領域不明」に寄せ (過大帰属回避)、別 group/非メニュー postback の
 *     同一文字列は group 外なので照合対象に入らない。
 *   - 集計の主軸は「postback data 別タップ数」。area 化は data が group 内で一意な時だけ。
 *
 * 二重計上防止: 同一 messages_log 行を 1 回だけ (COUNT(DISTINCT ml.id))。
 *   LINE webhook retry で同一 event が別 ml.id として二重保存された場合は DB 行が別なので
 *   本 batch の保証外 (仕様明記)。
 *
 * JST 期間: 半開区間 `created_at >= startT00:00:00 AND created_at < nextDayT00:00:00`。
 *   BETWEEN ...T23:59:59 はミリ秒付きデータを落とすため使わない。
 */

export interface TapAnalyticsArea {
  areaId: string;
  pageId: string;
  boundsX: number;
  boundsY: number;
  boundsWidth: number;
  boundsHeight: number;
  actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch';
  /** action_data (DB 保存の JSON 文字列を parse したもの)。 */
  actionData: Record<string, unknown>;
}

export interface AreaTapResult {
  areaId: string;
  pageId: string;
  boundsX: number;
  boundsY: number;
  boundsWidth: number;
  boundsHeight: number;
  actionType: TapAnalyticsArea['actionType'];
  /** postback の照合キー (actionData.data)。postback 以外は null。 */
  postbackData: string | null;
  /** タップ数。postback で一意帰属できた area のみ実数。uri/message は null (計測不可)。 */
  count: number | null;
  /** 計測可能か (postback かつ group 内 data 一意)。false の理由は unmeasurableReason。 */
  measurable: boolean;
  /** 計測不能理由: 'non-postback' (uri/message等) | 'ambiguous' (group 内 data 重複)。 */
  unmeasurableReason: 'non-postback' | 'ambiguous' | null;
}

export interface RichMenuTapAnalytics {
  /** area 別結果 (メニュー画像上のオーバーレイ + 一覧テーブル用)。 */
  areas: AreaTapResult[];
  /** postback data 別の生タップ数 (集計主軸)。area に一意帰属できたか否かに関わらず data 単位で数える。 */
  byPostbackData: { data: string; count: number }[];
  /**
   * 「領域不明」タップ数 = group 内で data が複数 area に衝突し area を特定できない postback タップの合計。
   * (集計主軸 byPostbackData の合計から一意帰属できた area の count を引いた残りと一致する。)
   */
  unattributedCount: number;
  /** 集計に用いた postback タップの総数 (DISTINCT ml.id)。 */
  totalTaps: number;
}

/** action_data から postback の照合キー (data フィールド) を取り出す。string でなければ null。 */
export function extractPostbackData(actionData: Record<string, unknown>): string | null {
  const d = actionData['data'];
  return typeof d === 'string' ? d : null;
}

/**
 * group の area 群と、期間内の postback タップ (data → 件数) を突き合わせて集計する。
 *
 * @param areas       選択 group の全 area (page_id 込み・action_data は parse 済)。
 * @param tapCounts   期間内 postback タップの data → DISTINCT ml.id 件数 (別 account は既に除外済)。
 */
export function attributeTaps(
  areas: TapAnalyticsArea[],
  tapCounts: Map<string, number>,
): RichMenuTapAnalytics {
  // 選択 group 内で postback data が一意かどうかを判定するためのカウント。
  const dataOccurrences = new Map<string, number>();
  for (const a of areas) {
    if (a.actionType !== 'postback') continue;
    const key = extractPostbackData(a.actionData);
    if (key === null) continue;
    dataOccurrences.set(key, (dataOccurrences.get(key) ?? 0) + 1);
  }

  const areaResults: AreaTapResult[] = areas.map((a) => {
    const base = {
      areaId: a.areaId,
      pageId: a.pageId,
      boundsX: a.boundsX,
      boundsY: a.boundsY,
      boundsWidth: a.boundsWidth,
      boundsHeight: a.boundsHeight,
      actionType: a.actionType,
    };
    if (a.actionType !== 'postback') {
      return { ...base, postbackData: null, count: null, measurable: false, unmeasurableReason: 'non-postback' as const };
    }
    const key = extractPostbackData(a.actionData);
    if (key === null || (dataOccurrences.get(key) ?? 0) > 1) {
      // data 欠落 or group 内で複数 area に衝突 = 一意帰属不能。
      return { ...base, postbackData: key, count: null, measurable: false, unmeasurableReason: 'ambiguous' as const };
    }
    return {
      ...base,
      postbackData: key,
      count: tapCounts.get(key) ?? 0,
      measurable: true,
      unmeasurableReason: null,
    };
  });

  // byPostbackData = group の area が持つ data のうち、実際にタップされた分を data 単位で集計。
  // (group の area に存在しない data のタップは「リッチメニュー由来でない postback」なので除外済 —
  //  tapCounts は既に group の data 集合で絞られている前提。)
  const byPostbackData = [...tapCounts.entries()]
    .map(([data, count]) => ({ data, count }))
    .sort((a, b) => b.count - a.count);

  const totalTaps = byPostbackData.reduce((s, x) => s + x.count, 0);

  // 一意帰属できた area の count 合計。
  const attributed = areaResults
    .filter((r) => r.measurable && r.count !== null)
    .reduce((s, r) => s + (r.count ?? 0), 0);
  const unattributedCount = totalTaps - attributed;

  return { areas: areaResults, byPostbackData, unattributedCount, totalTaps };
}

/**
 * DB から選択 group の area 群 + 期間内 postback タップ数を引き、attributeTaps で集計して返す。
 *
 * account 跨ぎ防止: messages_log.line_account_id = accountId でフィルタ。group も account に属する
 * ことは route 側で保証する (rich-menu-groups の accountId query と同じ)。
 *
 * @param startDate   'YYYY-MM-DD' (JST 開始日・含む)
 * @param endDate     'YYYY-MM-DD' (JST 終了日・含む — 内部で翌日 00:00 未満に変換)
 */
export async function getRichMenuTapAnalytics(
  db: D1Database,
  input: { groupId: string; accountId: string; startDate: string; endDate: string },
): Promise<RichMenuTapAnalytics> {
  // 1. group の全 area (page 経由) を取得。
  const areaRows = await db
    .prepare(
      `SELECT a.id AS area_id, a.page_id, a.bounds_x, a.bounds_y, a.bounds_width, a.bounds_height,
              a.action_type, a.action_data
         FROM rich_menu_areas a
         JOIN rich_menu_pages p ON p.id = a.page_id
        WHERE p.group_id = ?`,
    )
    .bind(input.groupId)
    .all<{
      area_id: string;
      page_id: string;
      bounds_x: number;
      bounds_y: number;
      bounds_width: number;
      bounds_height: number;
      action_type: TapAnalyticsArea['actionType'];
      action_data: string;
    }>();

  const areas: TapAnalyticsArea[] = areaRows.results.map((r) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(r.action_data) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return {
      areaId: r.area_id,
      pageId: r.page_id,
      boundsX: r.bounds_x,
      boundsY: r.bounds_y,
      boundsWidth: r.bounds_width,
      boundsHeight: r.bounds_height,
      actionType: r.action_type,
      actionData: parsed,
    };
  });

  // group の postback area の data 集合 (照合対象を「リッチメニュー由来」に閉じる)。
  const groupPostbackData = new Set<string>();
  for (const a of areas) {
    if (a.actionType !== 'postback') continue;
    const key = extractPostbackData(a.actionData);
    if (key !== null) groupPostbackData.add(key);
  }

  const tapCounts = new Map<string, number>();
  if (groupPostbackData.size > 0) {
    // 2. 期間内 postback タップを data(=content) 別に COUNT(DISTINCT id) で集計。
    //    JST 半開区間 + account フィルタ + group の data 集合に一致するもののみ。
    const nextDay = addOneDayJst(input.endDate);
    const placeholders = [...groupPostbackData].map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT content AS data, COUNT(DISTINCT id) AS cnt
           FROM messages_log
          WHERE source = 'postback'
            AND line_account_id = ?
            AND created_at >= ?
            AND created_at <  ?
            AND content IN (${placeholders})
          GROUP BY content`,
      )
      .bind(input.accountId, `${input.startDate}T00:00:00`, `${nextDay}T00:00:00`, ...groupPostbackData)
      .all<{ data: string; cnt: number }>();
    for (const r of rows.results) tapCounts.set(r.data, r.cnt);
  }

  return attributeTaps(areas, tapCounts);
}

/** 'YYYY-MM-DD' の翌日 'YYYY-MM-DD' を返す (JST 日付文字列演算・UTC 経由で桁上がり)。 */
export function addOneDayJst(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
