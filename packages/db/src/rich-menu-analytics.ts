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

/** postback 行として届き、messages_log と照合できるアクション種別 (postback + richmenuswitch)。 */
const POSTBACK_LOGGED_TYPES = new Set<TapAnalyticsArea['actionType']>(['postback', 'richmenuswitch']);

/**
 * area の action から messages_log.content と照合する postback data キーを導出する。
 *
 * - actionType='postback': action_data.data (admin 設定値) をそのまま照合キーにする。
 * - actionType='richmenuswitch': DB の action_data は `{ targetPageId }` を持つ (rich-menus.ts:12)。
 *   publish 時に publisher が `data: "switch-to-<targetPageId>"` を注入し (rich-menu-publisher.ts:88)、
 *   LINE はタブ切替タップを event.type='postback' / postback.data="switch-to-<targetPageId>" で届け、
 *   webhook.ts が全 postback を source='postback' / content=postback.data で記録する (webhook.ts:381-416)。
 *   よって照合キーは publisher と同一式 `switch-to-<targetPageId>` で決定論的に再構成できる
 *   (=richmenuswitch タブ切替タップも計測可能・reviewer MF-1 fix a)。
 * - uri/message: postback 行として届かないため null (計測対象外)。
 */
export function extractPostbackKey(
  actionType: TapAnalyticsArea['actionType'],
  actionData: Record<string, unknown>,
): string | null {
  if (actionType === 'postback') {
    const d = actionData['data'];
    return typeof d === 'string' ? d : null;
  }
  if (actionType === 'richmenuswitch') {
    const target = actionData['targetPageId'];
    if (typeof target === 'string' && target.length > 0) return `switch-to-${target}`;
    // LINE インポート等で既に data 文字列を持つ area はそれを使う (import 経路は richmenuswitch 拒否だが防御的)。
    const d = actionData['data'];
    return typeof d === 'string' ? d : null;
  }
  return null;
}

/**
 * (後方互換) action_data から postback の data フィールドを取り出す。string でなければ null。
 * postback area 専用の薄いヘルパ。richmenuswitch を含む場合は extractPostbackKey を使う。
 */
export function extractPostbackData(actionData: Record<string, unknown>): string | null {
  const d = actionData['data'];
  return typeof d === 'string' ? d : null;
}

/**
 * group の area 群と、期間内の postback タップ (data → 件数) を突き合わせて集計する。
 * postback + richmenuswitch の両方を「postback 行として届く」計測対象とする (webhook.ts:381)。
 *
 * @param areas       選択 group の全 area (page_id 込み・action_data は parse 済)。
 * @param tapCounts   期間内 postback タップの data → DISTINCT ml.id 件数 (別 account は既に除外済)。
 */
export function attributeTaps(
  areas: TapAnalyticsArea[],
  tapCounts: Map<string, number>,
): RichMenuTapAnalytics {
  // 選択 group 内で照合キーが一意かどうかを判定するためのカウント (postback + richmenuswitch)。
  const dataOccurrences = new Map<string, number>();
  for (const a of areas) {
    if (!POSTBACK_LOGGED_TYPES.has(a.actionType)) continue;
    const key = extractPostbackKey(a.actionType, a.actionData);
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
    if (!POSTBACK_LOGGED_TYPES.has(a.actionType)) {
      // uri/message は postback 行として届かない = 計測不能。
      return { ...base, postbackData: null, count: null, measurable: false, unmeasurableReason: 'non-postback' as const };
    }
    const key = extractPostbackKey(a.actionType, a.actionData);
    if (key === null || (dataOccurrences.get(key) ?? 0) > 1) {
      // キー欠落 or group 内で複数 area に衝突 = 一意帰属不能。
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

  // byPostbackData = group の area が持つ照合キーのうち、実際にタップされた分を data 単位で集計。
  // tapCounts は group の照合キー集合 (postback+richmenuswitch) で既に絞られている前提。
  // 注: 「group の照合キーに一致する = リッチメニュー由来」とは断定できない (別 group/Flex ボタン/
  //     クイックリプライが同一文字列の postback を送ると同じ data で混入し得る)。この固有限界は
  //     UI の amber 注記「リッチメニュー由来かどうかを完全に断定できない場合があります」で開示済 (案A/L-1)。
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

  // group の postback + richmenuswitch area の照合キー集合 (照合対象を「リッチメニュー由来」に閉じる)。
  // richmenuswitch も event.type='postback' / content="switch-to-<targetPageId>" で届くため含める
  // (webhook.ts:381-416 / rich-menu-publisher.ts:88 / reviewer MF-1 fix a)。
  const groupPostbackData = new Set<string>();
  for (const a of areas) {
    if (!POSTBACK_LOGGED_TYPES.has(a.actionType)) continue;
    const key = extractPostbackKey(a.actionType, a.actionData);
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
