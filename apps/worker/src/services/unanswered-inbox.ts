import {
  AUTO_REPLY_KEEP_UNRESPONDED_SOURCE,
  UNMATCHED_USER_SOURCE,
  isAutoReplyHandledSource,
  matchesAutoReplyKeyword,
} from './auto-reply-keyword-match.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 2000;

// auto_reply にマッチした incoming は「人間対応不要」として未対応から除外する。
// 判定戦略は 3 系統:
//
// (A) 応答ありルール (response_type != 'silent'):
//     incoming 直後に source='auto_reply' delivery_type='reply' の outgoing が
//     messages_log に残っているかを「証拠」として確認する。ルール keyword が
//     後で書き換えられても歴史的判定がブレない。
//
// (B) 今後の incoming:
//     webhook が受信時点の判定を source に永続化する。auto_reply_keyword と
//     auto_reply_handled は除外する。auto_reply_keep_unresponded は未読からだけ除外し、
//     この一覧には明示的に残す。user_unmatched は現在のルールで再判定せず、FAQ の
//     返信証拠だけを確認して、それ以外は未対応として残す。
//
// (C) marker 導入前の incoming:
//     過去表示を遡及変更しないため、従来どおり raw 文字列・全 account の現在 active
//     keyword で判定する。新しい正規化や account scope は過去行へ適用しない。
const ACTIVE_AUTO_REPLIES_SQL = `
  SELECT keyword, match_type, line_account_id, is_active
  FROM auto_replies
  WHERE is_active = 1
`;

interface ActiveRuleRow {
  keyword: string;
  match_type: string;
  line_account_id: string | null;
  is_active: number;
}

function matchesAnyKeyword(
  content: string,
  messageType: string,
  rules: ActiveRuleRow[],
): boolean {
  if (messageType !== 'text') return false;
  return rules.some((rule) => matchesAutoReplyKeyword(content, rule, null, {
    normalize: false,
    enforceAccountScope: false,
  }));
}

// 同じ incoming に対して outgoing 'auto_reply' (delivery_type='reply') が
// 短時間内に発火していれば、この incoming は応答ありルールにマッチしたと判定する。
// 5 秒は webhook が auto_reply を送るまでの最大時間として保守的に取る。
const AUTO_REPLY_EVIDENCE_WINDOW_MS = 5_000;

// D-1 救済 (T-E5): faq_bot (FAQ AI) 返信は Workers AI generate (AI_TIMEOUT_MS 既定 8s / runtime.ts:54) +
// LINE API 往復 + messages_log 書込を経るため incoming の 5 秒後を超えて log され得る。5 秒窓のままだと
// 「AI が答えたのに未対応インボックスに残る」ため、faq_bot 証拠だけ大きめの窓 (30s = 想定 AI timeout の上限 +
// 往復 + logging の保守値) で判定する。auto_reply (keyword 即応) の 5000ms 判定は byte-identical (退行なし)。
// owner 立会後に定数調整可 (env スレッドは非導入 = getAllUnansweredRows は db のみ受ける最小改修)。
const FAQ_AI_EVIDENCE_WINDOW_MS = 30_000;

// Human-approved FAQ drafts are sent later with LINE push, but operationally they are
// the operator's reply. Treat them as the same handled boundary as a manual message so
// the answered chat does not reappear in the unanswered-only view after a refresh.
export const HUMAN_APPROVED_REPLY_SQL =
  `(source='manual' OR (source='faq_bot' AND delivery_type='push'))`;

/**
 * outgoing 1 件は incoming 1 件にしかマッチさせない。
 * 同じ友だちが短時間に複数メッセを送って auto_reply が 1 件しか飛ばないケース、
 * 古い free-form メッセが新しいマッチメッセの outgoing で誤判定される (codex
 * round 3 P1) のを防ぐ。consume 済み outgoing は配列から取り除く。
 *
 * 証拠窓は source 別 (T-E5): faq_bot は LLM 遅延を吸収する大窓・auto_reply は 5000ms (byte-identical)。
 */
function consumeAutoReplyEvidence(
  incomingAt: string,
  remainingOutgoings: { created_at: string; source: string }[],
  requiredSource?: string,
): boolean {
  const inMs = new Date(incomingAt).getTime();
  for (let i = 0; i < remainingOutgoings.length; i++) {
    const out = remainingOutgoings[i];
    if (requiredSource !== undefined && out.source !== requiredSource) continue;
    const win = out.source === 'faq_bot' ? FAQ_AI_EVIDENCE_WINDOW_MS : AUTO_REPLY_EVIDENCE_WINDOW_MS;
    const outMs = new Date(out.created_at).getTime();
    if (outMs >= inMs && outMs - inMs <= win) {
      remainingOutgoings.splice(i, 1);
      return true;
    }
  }
  return false;
}

// 候補 friend のメタデータ + 集約タイムスタンプ。
// プレビュー/タイプは別クエリで last_manual 以降の incoming 群から JS で決める
// (auto_reply マッチを除いた「最新の非マッチ incoming」が triage 対象)。
const CANDIDATES_SQL = `
  WITH agg AS (
    SELECT
      friend_id,
      MAX(CASE WHEN direction='incoming' AND (source IS NULL OR source != 'postback') THEN created_at END) AS last_incoming,
      MAX(CASE WHEN direction='outgoing' AND ${HUMAN_APPROVED_REPLY_SQL} THEN created_at END) AS last_manual,
      MAX(CASE WHEN direction='outgoing' AND source IN
          ('auto_reply','automation','automation_backfill','scenario','broadcast')
        THEN created_at END) AS last_machine
    FROM messages_log
    GROUP BY friend_id
  ),
  latest_chat_state AS (
    SELECT c.friend_id, c.status, c.updated_at
    FROM chats c
    WHERE c.rowid = (
      SELECT MAX(c2.rowid)
      FROM chats c2
      WHERE c2.friend_id = c.friend_id
    )
  )
  SELECT
    f.id            AS friend_id,
    f.display_name,
    f.picture_url,
    f.line_account_id,
    COALESCE(la.name, '(未分類)') AS account_name,
    agg.last_incoming,
    agg.last_manual,
    agg.last_machine,
    lcs.status AS chat_status,
    lcs.updated_at AS chat_updated_at
  FROM friends f
  LEFT JOIN line_accounts la ON la.id = f.line_account_id
  JOIN agg ON agg.friend_id = f.id
  LEFT JOIN latest_chat_state lcs ON lcs.friend_id = f.id
  WHERE f.is_following = 1
    AND (la.id IS NULL OR la.is_active = 1)
    AND agg.last_incoming IS NOT NULL
    AND (agg.last_manual IS NULL OR agg.last_manual < agg.last_incoming)
  ORDER BY agg.last_incoming ASC
`;

// 候補 friend の "last_manual 以降の全 incoming" (postback 除く)。
// 当初は friend_id IN (?, ...) で candidate scope する設計だったが、
// D1 の prepared statement bind 変数上限 (100) を IN×2 で越えて 500 が出た
// (本番事故 2026-05-08)。代わりに last_manual を全 friend で集約する CTE に
// して bind 変数ゼロで動かす。messages_log は (friend_id, direction, created_at)
// の index で scan されるので、incoming サブセット取得は十分速い。
const RECENT_INCOMINGS_SQL = `
  WITH last_manual AS (
    SELECT friend_id, MAX(created_at) AS lm
    FROM messages_log
    WHERE direction='outgoing' AND ${HUMAN_APPROVED_REPLY_SQL}
    GROUP BY friend_id
  )
  SELECT ml.friend_id, ml.message_type, ml.content, ml.created_at, ml.source
  FROM messages_log ml
  LEFT JOIN last_manual lm ON lm.friend_id = ml.friend_id
  WHERE ml.direction='incoming'
    AND (ml.source IS NULL OR ml.source != 'postback')
    AND (lm.lm IS NULL OR ml.created_at > lm.lm)
  ORDER BY ml.friend_id, ml.created_at DESC
`;

// 候補 friend の "last_manual 以降の auto_reply outgoing (reply 限定)"。
// delivery_type='reply' で絞ることで、forms.ts などが同じ source='auto_reply' で
// 記録する form-confirmation / webhook-failure push を証拠から除外する。
// 同じく bind 変数ゼロ。JS 側で friend_id ごとに group する。
const RECENT_AUTO_REPLY_OUTGOINGS_SQL = `
  WITH last_manual AS (
    SELECT friend_id, MAX(created_at) AS lm
    FROM messages_log
    WHERE direction='outgoing' AND ${HUMAN_APPROVED_REPLY_SQL}
    GROUP BY friend_id
  )
  SELECT ml.friend_id, ml.created_at, ml.source
  FROM messages_log ml
  LEFT JOIN last_manual lm ON lm.friend_id = ml.friend_id
  WHERE ml.direction='outgoing'
    AND ml.source IN ('auto_reply','faq_bot')
    AND ml.delivery_type='reply'
    AND (lm.lm IS NULL OR ml.created_at > lm.lm)
  ORDER BY ml.friend_id, ml.created_at ASC
`;


export interface UnansweredRow {
  friendId: string;
  displayName: string | null;
  pictureUrl: string | null;
  accountId: string;
  accountName: string;
  lastIncomingAt: string;
  lastManualAt: string | null;
  lastMachineAt: string | null;
  lastIncomingType: string;
  lastIncomingContent: string;
}

export interface UnansweredInboxResult {
  total: number;
  page: number;
  pageSize: number;
  rows: UnansweredRow[];
}

export interface UnansweredCount {
  total: number;
  byAccount: Array<{ accountId: string; accountName: string; count: number }>;
  oldestWaitMinutes: number | null;
}

export interface UnansweredInboxOptions {
  q?: string;
  account?: string;
  minWaitMinutes?: number;
  page?: number;
  pageSize?: number;
}

interface RawCandidateRow {
  friend_id: string;
  display_name: string | null;
  picture_url: string | null;
  line_account_id: string;
  account_name: string;
  last_incoming: string;
  last_manual: string | null;
  last_machine: string | null;
  chat_status: string | null;
  chat_updated_at: string | null;
}

interface RawIncomingRow {
  friend_id: string;
  message_type: string;
  content: string;
  created_at: string;
  source: string | null;
}

// resolved はその状態へ更新した時点までの受信だけを完了扱いにする。
// keep_unresponded 等で chat 状態を更新しない新着も、完了境界より後なら再表示する。
function isAfterCompletionBoundary(
  chatStatus: string | null | undefined,
  chatUpdatedAt: string | null | undefined,
  incomingAt: string,
): boolean {
  if (chatStatus !== 'resolved') return true;
  if (chatUpdatedAt == null) return false;
  return new Date(incomingAt).getTime() > new Date(chatUpdatedAt).getTime();
}

function applyFilters(rows: UnansweredRow[], opts: UnansweredInboxOptions): UnansweredRow[] {
  let filtered = rows;
  if (opts.account) {
    filtered = filtered.filter((r) => r.accountId === opts.account);
  }
  if (opts.minWaitMinutes && opts.minWaitMinutes > 0) {
    const cutoff = Date.now() - opts.minWaitMinutes * 60_000;
    filtered = filtered.filter((r) => new Date(r.lastIncomingAt).getTime() <= cutoff);
  }
  if (opts.q) {
    const q = opts.q.toLowerCase();
    filtered = filtered.filter((r) => {
      if (r.displayName?.toLowerCase().includes(q)) return true;
      if (r.lastIncomingContent.toLowerCase().includes(q)) return true;
      return false;
    });
  }
  return filtered;
}

/**
 * Single source of truth.
 *
 * 1. CANDIDATES_SQL で「last_incoming > last_manual」の friend を取る。
 * 2. 候補 friend に scope して "last_manual 以降の incoming" と "auto_reply outgoing" を取る。
 * 3. marker 導入前の互換判定にだけ使う active ルール一覧を取る。
 * 4. JS で各 incoming を判定: 将来行は永続 marker、過去行は応答証拠または raw keyword
 *    match を使う。マッチしない最新 incoming を preview にし、全部マッチした thread を除外。
 */
export async function getAllUnansweredRows(db: D1Database): Promise<UnansweredRow[]> {
  const candidatesResult = await db.prepare(CANDIDATES_SQL).all<RawCandidateRow>();
  const candidates = (candidatesResult.results ?? []).filter((candidate) => (
    isAfterCompletionBoundary(
      candidate.chat_status,
      candidate.chat_updated_at,
      candidate.last_incoming,
    )
  ));
  if (candidates.length === 0) return [];

  // 候補 friend のみを残すための Set。後段の JS group で他の friend は無視する。
  const candidateIds = new Set(candidates.map((c) => c.friend_id));

  const [incomingsResult, autoReplyOutgoingsResult, activeRulesResult] = await Promise.all([
    db.prepare(RECENT_INCOMINGS_SQL).all<RawIncomingRow>(),
    db.prepare(RECENT_AUTO_REPLY_OUTGOINGS_SQL).all<{ friend_id: string; created_at: string; source: string }>(),
    db.prepare(ACTIVE_AUTO_REPLIES_SQL).all<ActiveRuleRow>(),
  ]);

  const activeRules = activeRulesResult.results ?? [];

  // friend_id ごとに incomings を集める (created_at DESC でソート済み)。
  // 候補外の friend のメッセは捨てる (memory 節約)。
  const incomingsByFriend = new Map<string, RawIncomingRow[]>();
  for (const row of incomingsResult.results ?? []) {
    if (!candidateIds.has(row.friend_id)) continue;
    const list = incomingsByFriend.get(row.friend_id) ?? [];
    list.push(row);
    incomingsByFriend.set(row.friend_id, list);
  }
  // friend_id ごとに auto_reply/faq_bot outgoings を集める (created_at ASC ソート済み・source 別窓判定に source を保持)。
  const autoReplyOutgoingsByFriend = new Map<string, { created_at: string; source: string }[]>();
  for (const row of autoReplyOutgoingsResult.results ?? []) {
    if (!candidateIds.has(row.friend_id)) continue;
    const list = autoReplyOutgoingsByFriend.get(row.friend_id) ?? [];
    list.push({ created_at: row.created_at, source: row.source });
    autoReplyOutgoingsByFriend.set(row.friend_id, list);
  }

  const rows: UnansweredRow[] = [];
  for (const c of candidates) {
    const incomings = (incomingsByFriend.get(c.friend_id) ?? []).filter((row) => (
      isAfterCompletionBoundary(c.chat_status, c.chat_updated_at, row.created_at)
    ));
    // outgoings は consume するのでコピーを作る (元 Map の他参照を破壊しない)。
    // incomings は新しい順に処理し、各 outgoing を 1 incoming にしか割り当てない。
    const remainingOutgoings = [...(autoReplyOutgoingsByFriend.get(c.friend_id) ?? [])];

    // marker で keyword match / handled と確定している行へ auto_reply 証拠を先に予約する。
    // これをしないと、別の unmatched/legacy 行が少し遅れて書かれた reply を横取りし、
    // 本当の未読まで消す。古い順に割り当てて 1:1 を保つ。
    for (let index = incomings.length - 1; index >= 0; index--) {
      const incoming = incomings[index];
      if (isAutoReplyHandledSource(incoming.source)) {
        consumeAutoReplyEvidence(incoming.created_at, remainingOutgoings, 'auto_reply');
      }
    }

    let nonMatching: RawIncomingRow | undefined;
    for (const i of incomings) {
      if (i.source === AUTO_REPLY_KEEP_UNRESPONDED_SOURCE) {
        // 受信時点の per-rule opt-in。outgoing 証拠や後日のルール編集で
        // 過去の「スタッフ対応が必要」という判断を上書きしない。
        nonMatching = i;
        break;
      }
      if (isAutoReplyHandledSource(i.source)) continue;
      if (i.source === UNMATCHED_USER_SOURCE) {
        // A future unmatched row must never consume a delayed keyword reply.
        // faq_bot is distinct evidence that this otherwise-unmatched question
        // was answered automatically; away/structured actions use handled marker.
        if (consumeAutoReplyEvidence(i.created_at, remainingOutgoings, 'faq_bot')) continue;
        nonMatching = i;
        break;
      }
      if (consumeAutoReplyEvidence(i.created_at, remainingOutgoings)) continue;
      if (matchesAnyKeyword(i.content, i.message_type, activeRules)) continue;
      // この incoming は人間対応必要 → preview として採用 (最新の非マッチ)
      nonMatching = i;
      break;
    }
    if (!nonMatching) continue;

    rows.push({
      friendId: c.friend_id,
      displayName: c.display_name,
      pictureUrl: c.picture_url,
      accountId: c.line_account_id,
      accountName: c.account_name,
      lastIncomingAt: nonMatching.created_at,
      lastManualAt: c.last_manual,
      lastMachineAt: c.last_machine,
      lastIncomingType: nonMatching.message_type,
      lastIncomingContent: nonMatching.content,
    });
  }

  // 新しい順 (= 直近 incoming が先頭)。実運用では「最近来た会話を上から潰す」
  // 流れの方が手が動く (2026-05-12 野田さん運用フィードバック)。
  rows.sort((a, b) => b.lastIncomingAt.localeCompare(a.lastIncomingAt));
  return rows;
}

export async function computeUnansweredInbox(
  db: D1Database,
  opts: UnansweredInboxOptions = {},
): Promise<UnansweredInboxResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  const allRows = await getAllUnansweredRows(db);
  const filtered = applyFilters(allRows, opts);
  const slice = filtered.slice(offset, offset + pageSize);

  return {
    total: filtered.length,
    page,
    pageSize,
    rows: slice,
  };
}

/**
 * 未対応 (人間が返事してない) friend ID の Set を返す。
 * /api/chats?unansweredOnly=true で chat list を絞るのに使う。
 * 判定ロジックは getAllUnansweredRows と同じ source of truth。
 */
export async function getUnansweredFriendIds(db: D1Database): Promise<Set<string>> {
  const rows = await getAllUnansweredRows(db);
  return new Set(rows.map((r) => r.friendId));
}

export async function countUnanswered(db: D1Database): Promise<UnansweredCount> {
  const allRows = await getAllUnansweredRows(db);

  const byAccountMap = new Map<string, { accountName: string; count: number }>();
  let oldest: string | null = null;
  for (const r of allRows) {
    const key = r.accountId ?? '__unassigned__';
    const existing = byAccountMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      byAccountMap.set(key, { accountName: r.accountName, count: 1 });
    }
    if (oldest === null || r.lastIncomingAt < oldest) oldest = r.lastIncomingAt;
  }

  const byAccount = [...byAccountMap.entries()]
    .map(([accountId, v]) => ({ accountId, accountName: v.accountName, count: v.count }))
    .sort((a, b) => b.count - a.count);

  const oldestWaitMinutes =
    oldest !== null
      ? Math.max(0, Math.floor((Date.now() - new Date(oldest).getTime()) / 60_000))
      : null;

  return {
    total: allRows.length,
    byAccount,
    oldestWaitMinutes,
  };
}
