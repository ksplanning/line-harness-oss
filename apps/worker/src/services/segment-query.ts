import { buildFriendMetadataPredicate } from './friend-metadata-condition.js'

/**
 * 行動 rule (G11 遡及オーディエンス) の期間指定。
 *  - sinceDays: 過去 N 日 (相対・省略時 30)。
 *  - since/until: 期間指定 (YYYY-MM-DD・JST 半開区間・until は inclusive → 翌日 00:00 exclusive)。
 * since が指定されたら since/until を優先し、なければ sinceDays を使う。
 */
export interface BehavioralPeriod {
  sinceDays?: number
  since?: string
  until?: string
}

/** clicked_link: (任意/特定の) トラッキングリンクをクリックした人 (link_clicks 遡及)。 */
export interface ClickedLinkValue extends BehavioralPeriod {
  trackedLinkId?: string | null
}
/** tapped_menu: (対象 rich_menu_group を) タップした人 (messages_log postback 遡及・groupId 必須)。 */
export interface TappedMenuValue extends BehavioralPeriod {
  groupId: string
}
/** opened_form: (任意/特定の) フォームを開いた人 (form_opens 遡及)。 */
export interface OpenedFormValue extends BehavioralPeriod {
  formId?: string | null
}

export type SegmentRuleValue =
  | string
  | boolean
  | { key: string; value: string }
  | ClickedLinkValue
  | TappedMenuValue
  | OpenedFormValue

export interface SegmentRule {
  type:
    | 'tag_exists'
    | 'tag_not_exists'
    | 'metadata_equals'
    | 'metadata_not_equals'
    | 'ref_code'
    | 'is_following'
    | 'clicked_link'
    | 'tapped_menu'
    | 'opened_form'
  value: SegmentRuleValue
}

export interface SegmentCondition {
  operator: 'AND' | 'OR'
  rules: SegmentRule[]
}

/** buildSegmentWhere の任意コンテキスト。now は行動 rule の「過去N日」計算基準 (既定 = 実時刻)。 */
export interface SegmentQueryContext {
  now?: Date
}

const JST_OFFSET_MS = 9 * 60 * 60_000

/** JST の「now から days 日前」の日付 (YYYY-MM-DD) を返す。 */
function jstDateNDaysAgo(now: Date, days: number): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MS)
  jst.setUTCDate(jst.getUTCDate() - days)
  return jst.toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD'(先頭10文字) の翌日 'YYYY-MM-DD' を返す (until inclusive → exclusive 境界)。 */
function addOneDayDate(dateStr: string): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}

/**
 * 行動 rule の期間指定を JST の半開区間 { start, end? } に解決する。
 *  - since 指定時: start=since(T00:00:00 補完)、until 指定時 end=翌日 00:00:00 (inclusive→exclusive)。
 *  - 無指定/ sinceDays 指定時: start = now から N 日前 (既定 30) の JST 00:00:00・end なし (現在まで)。
 */
function resolvePeriod(v: BehavioralPeriod, now: Date): { start: string; end?: string } {
  const since = typeof v.since === 'string' && v.since ? v.since : null
  if (since) {
    const start = since.includes('T') ? since : `${since}T00:00:00`
    let end: string | undefined
    if (typeof v.until === 'string' && v.until) {
      end = v.until.includes('T') ? v.until : `${addOneDayDate(v.until)}T00:00:00`
    }
    return { start, end }
  }
  const days = typeof v.sinceDays === 'number' && Number.isFinite(v.sinceDays) && v.sinceDays > 0
    ? Math.floor(v.sinceDays)
    : 30
  return { start: `${jstDateNDaysAgo(now, days)}T00:00:00` }
}

function asPeriodObject(value: SegmentRuleValue, ruleLabel: string): BehavioralPeriod {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${ruleLabel} rule requires an object value`)
  }
  return value as BehavioralPeriod
}

/**
 * Build the WHERE fragment (clause + bindings) for a segment condition, aliased
 * to `f` (matches `FROM friends f` in every caller). Extracted so /api/friends,
 * /api/segments/count, and segment-send can AND it structurally against an
 * account scope without string surgery.
 *
 * HIGH-2: when there is more than one rule the joined clause is wrapped in
 * parentheses. Without this, `f.line_account_id = ? AND tagA OR tagB` parses as
 * `(account AND tagA) OR tagB` and leaks friends from other accounts. Callers
 * that AND this fragment with an account condition rely on the grouping.
 */
export function buildSegmentWhere(
  condition: SegmentCondition,
  context: SegmentQueryContext = {},
): { clause: string; bindings: unknown[] } {
  const now = context.now ?? new Date()
  const bindings: unknown[] = []
  const clauses: string[] = []

  for (const rule of condition.rules) {
    switch (rule.type) {
      case 'tag_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('tag_exists rule requires a string tag ID value')
        }
        clauses.push(
          `EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'tag_not_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('tag_not_exists rule requires a string tag ID value')
        }
        clauses.push(
          `NOT EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'metadata_equals': {
        if (
          typeof rule.value !== 'object' ||
          rule.value === null ||
          typeof (rule.value as { key: string; value: string }).key !== 'string' ||
          typeof (rule.value as { key: string; value: string }).value !== 'string'
        ) {
          throw new Error('metadata_equals rule requires { key: string; value: string }')
        }
        const mv = rule.value as { key: string; value: string }
        const predicate = buildFriendMetadataPredicate(mv.key, mv.value, 'equals')
        clauses.push(predicate.sql)
        bindings.push(...predicate.bindings)
        break
      }

      case 'metadata_not_equals': {
        if (
          typeof rule.value !== 'object' ||
          rule.value === null ||
          typeof (rule.value as { key: string; value: string }).key !== 'string' ||
          typeof (rule.value as { key: string; value: string }).value !== 'string'
        ) {
          throw new Error('metadata_not_equals rule requires { key: string; value: string }')
        }
        const mv = rule.value as { key: string; value: string }
        const predicate = buildFriendMetadataPredicate(mv.key, mv.value, 'not_equals')
        clauses.push(predicate.sql)
        bindings.push(...predicate.bindings)
        break
      }

      case 'ref_code': {
        if (typeof rule.value !== 'string') {
          throw new Error('ref_code rule requires a string value')
        }
        clauses.push(`f.ref_code = ?`)
        bindings.push(rule.value)
        break
      }

      case 'is_following': {
        if (typeof rule.value !== 'boolean') {
          throw new Error('is_following rule requires a boolean value')
        }
        clauses.push(`f.is_following = ?`)
        bindings.push(rule.value ? 1 : 0)
        break
      }

      // ─── G11 行動 rule (遡及オーディエンス) ───────────────────────────────
      // REAL な per-friend イベント (link_clicks / messages_log postback / form_opens) のみを
      // friend_id 経由で EXISTS 参照する。friend は caller が account scope するため、これらは
      // その friend 自身の行動 = account を跨がない。broadcast の per-recipient「メッセージ開封」は
      // LINE 非提供 (broadcast_insights は aggregate) ゆえ audience 化しない (偽シグナル発明禁止)。
      case 'clicked_link': {
        const v = asPeriodObject(rule.value, 'clicked_link') as ClickedLinkValue
        const { start, end } = resolvePeriod(v, now)
        const parts = ['lc.friend_id = f.id', 'lc.clicked_at >= ?']
        bindings.push(start)
        if (end) { parts.push('lc.clicked_at < ?'); bindings.push(end) }
        if (typeof v.trackedLinkId === 'string' && v.trackedLinkId) {
          parts.push('lc.tracked_link_id = ?')
          bindings.push(v.trackedLinkId)
        }
        clauses.push(`EXISTS (SELECT 1 FROM link_clicks lc WHERE ${parts.join(' AND ')})`)
        break
      }

      case 'opened_form': {
        const v = asPeriodObject(rule.value, 'opened_form') as OpenedFormValue
        const { start, end } = resolvePeriod(v, now)
        const parts = ['fo.friend_id = f.id', 'fo.opened_at >= ?']
        bindings.push(start)
        if (end) { parts.push('fo.opened_at < ?'); bindings.push(end) }
        if (typeof v.formId === 'string' && v.formId) {
          parts.push('fo.form_id = ?')
          bindings.push(v.formId)
        }
        clauses.push(`EXISTS (SELECT 1 FROM form_opens fo WHERE ${parts.join(' AND ')})`)
        break
      }

      case 'tapped_menu': {
        const v = asPeriodObject(rule.value, 'tapped_menu') as TappedMenuValue
        if (typeof v.groupId !== 'string' || !v.groupId) {
          throw new Error('tapped_menu rule requires a groupId (対象リッチメニュー)')
        }
        const { start, end } = resolvePeriod(v, now)
        // Codex CRITICAL: postback は messages_log.source='postback' に記録される
        //   (webhook.ts:412)。delivery_type CHECK は push/reply/test のみ = delivery_type='postback'
        //   は 0 件バグ → 使わない。
        // Codex HIGH: postback は Flex ボタンでも発火するため、対象 rich_menu_group の area の
        //   action_data キー集合 (postback は $.data / richmenuswitch は switch-to-<targetPageId>・
        //   rich-menu-analytics と同一式) に content が一致するものだけに閉じ、account scope は
        //   group の account 由来 (別 account の postback を拾わない)。URI/message タップは LINE が
        //   event を送らず計測不可。
        const conds = [
          'ml.friend_id = f.id',
          "ml.source = 'postback'",
          'ml.created_at >= ?',
        ]
        bindings.push(start)
        if (end) { conds.push('ml.created_at < ?'); bindings.push(end) }
        conds.push('ml.line_account_id = (SELECT g.account_id FROM rich_menu_groups g WHERE g.id = ?)')
        bindings.push(v.groupId)
        conds.push(
          `ml.content IN (` +
          `SELECT CASE rma.action_type ` +
          `WHEN 'postback' THEN json_extract(rma.action_data, '$.data') ` +
          `WHEN 'richmenuswitch' THEN 'switch-to-' || json_extract(rma.action_data, '$.targetPageId') ` +
          `END ` +
          `FROM rich_menu_areas rma ` +
          `JOIN rich_menu_pages rmp ON rma.page_id = rmp.id ` +
          `WHERE rmp.group_id = ? AND rma.action_type IN ('postback','richmenuswitch'))`,
        )
        bindings.push(v.groupId)
        clauses.push(`EXISTS (SELECT 1 FROM messages_log ml WHERE ${conds.join(' AND ')})`)
        break
      }

      default: {
        const exhaustive: never = rule.type
        throw new Error(`Unknown segment rule type: ${exhaustive}`)
      }
    }
  }

  if (clauses.length === 0) {
    return { clause: '1=1', bindings }
  }
  const separator = condition.operator === 'AND' ? ' AND ' : ' OR '
  const joined = clauses.join(separator)
  const clause = clauses.length > 1 ? `(${joined})` : joined
  return { clause, bindings }
}

/**
 * Full SELECT for a segment condition. Kept as the equivalence anchor for
 * buildSegmentWhere; internally delegates so the WHERE fragment is identical.
 */
export function buildSegmentQuery(
  condition: SegmentCondition,
  context: SegmentQueryContext = {},
): { sql: string; bindings: unknown[] } {
  const { clause, bindings } = buildSegmentWhere(condition, context)
  const sql = `SELECT f.id, f.line_user_id FROM friends f WHERE ${clause}`
  return { sql, bindings }
}
